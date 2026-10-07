import { TypeSafeClient, choice } from "@typesafe-ai/sdk";
import { mockSystemOne } from "./mock.js";

export const MAX_LENGTH = 140;
export const END = "END";
export const SPACE = "SPACE";
const LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

let client;
function systemOne(request) {
  if (process.env.JEV_MOCK === "1") return mockSystemOne(request);
  client ??= new TypeSafeClient();
  return client.systemOne(request);
}

// Rules that code can enforce on its own stay out of the model's hands:
// no leading or double spaces, and no ending before anything is written.
function allowedOptions(answer) {
  const options = [...LETTERS];
  if (answer.length > 0 && !answer.endsWith(" ")) options.push(SPACE);
  if (answer.trim().length > 0) options.push(END);
  return options;
}

function criteriaFor(options) {
  const criteria = {};
  for (const option of options) {
    if (option === SPACE) criteria[option] = "A space, ending the current word.";
    else if (option === END) criteria[option] = "Stop: the answer is already complete as written.";
    else criteria[option] = `The letter ${option}.`;
  }
  return criteria;
}

const INSTRUCTIONS = {
  task:
    "You are writing a reply to `question` one character at a time, the way a language model emits tokens. " +
    "Pick the single best character to append to `answer_so_far`.",
  rules: [
    "The finished reply should correctly and directly answer the question in plain words.",
    "Continue the word in progress in `answer_so_far` if it is unfinished; spell words correctly.",
    "The whole reply must fit in `max_length` characters, so with few `characters_remaining`, wrap up.",
    "Only letters and spaces are available; there is no punctuation or digits, so spell numbers out.",
    "Choose END only when `answer_so_far` already reads as a complete answer.",
  ],
};

export async function nextCharacter(question, answer) {
  const options = allowedOptions(answer);
  const { answers } = await systemOne({
    state: {
      question,
      answer_so_far: answer,
      max_length: MAX_LENGTH,
      characters_remaining: MAX_LENGTH - answer.length,
    },
    questions: { next: choice(INSTRUCTIONS, criteriaFor(options)) },
  });

  const { probabilities } = answers.next;
  const best = Math.max(...options.map((o) => probabilities[o] ?? 0));
  const tied = options.filter((o) => (probabilities[o] ?? 0) === best);
  const pick = tied[Math.floor(Math.random() * tied.length)];

  const top = options
    .map((o) => ({ option: o, p: probabilities[o] ?? 0 }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 5);

  return { pick, top, tied: tied.length };
}

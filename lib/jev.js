import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import { mockSystemOne } from "./mock.js";

export const MAX_LENGTH = 140;
export const END = "END";
export const SPACE = "SPACE";
export const ANSWER_PATTERN = /^[A-Za-z .,!?'"\-:;()]*$/;

const LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
const CLOSERS = [".", ",", "!", "?", ":", ";", ")"];
const JOINERS = ["'", "-"]; // only inside words: don't, well-known
const DONE_THRESHOLD = 0.6;
const TAIL = 48; // characters of the answer shown in each option's description

let client;
function systemOne(request) {
  if (process.env.JEV_MOCK === "1") return mockSystemOne(request);
  client ??= new TypeSafeClient();
  return client.systemOne(request);
}

const isLetter = (c) => /[A-Za-z]/.test(c ?? "");
const currentWord = (answer) => answer.match(/[A-Za-z'-]*$/)[0];
const atSentenceStart = (answer) => answer.trim() === "" || /[.!?]["')]?\s+$/.test(answer);
const isOpeningQuote = (answer, i) => answer[i] === '"' && (i === 0 || answer[i - 1] === " ");

// The text an option appends. Code owns capitalization, so Jev only picks letters.
function textFor(option, answer) {
  if (option === SPACE) return " ";
  if (option === END) return "";
  if (option.length === 1 && isLetter(option)) return atSentenceStart(answer) ? option : option.toLowerCase();
  return option;
}

// Punctuation and spacing rules are mechanical, so code enforces them instead of asking Jev.
export function allowedOptions(answer) {
  const last = answer.at(-1);
  const quoteOpen = (answer.match(/"/g) ?? []).length % 2 === 1;
  const parenOpen = (answer.match(/\(/g) ?? []).length > (answer.match(/\)/g) ?? []).length;
  const closers = [...CLOSERS.filter((c) => c !== ")" || parenOpen), ...(quoteOpen ? ['"'] : [])];
  const options = [];
  let canEnd = false;

  if (last === undefined || last === " ") {
    options.push(...LETTERS, "(", ...(quoteOpen ? [] : ['"']));
  } else if (isLetter(last)) {
    const word = currentWord(answer).toLowerCase();
    const realWord = word.length > 1 || word === "a" || word === "i";
    options.push(...LETTERS, ...JOINERS, ...closers);
    if (realWord) options.push(SPACE);
    canEnd = true;
  } else if (JOINERS.includes(last) || last === "(" || isOpeningQuote(answer, answer.length - 1)) {
    options.push(...LETTERS);
  } else if ([",", ":", ";"].includes(last)) {
    options.push(SPACE);
  } else if ([".", "!", "?"].includes(last)) {
    options.push(SPACE, ...closers.filter((c) => c === ")" || c === '"'));
    if (last === "." && !answer.endsWith("...")) options.push(".");
    canEnd = true;
  } else {
    // After ")" or a closing quote.
    options.push(SPACE, ...closers.filter((c) => c !== last));
    canEnd = true;
  }
  if (canEnd && /[A-Za-z]/.test(answer)) options.push(END);
  return [...new Set(options)];
}

function preview(text) {
  return text.length > TAIL ? `…${text.slice(-TAIL)}` : text;
}

function criteriaFor(options, answer) {
  const criteria = {};
  for (const option of options) {
    if (option === END) {
      criteria[option] = `Stop writing. The final answer is "${answer.trim()}"`;
    } else if (option === SPACE) {
      criteria[option] = `A space, finishing the word "${currentWord(answer)}". The answer becomes "${preview(answer + " ")}"`;
    } else {
      criteria[option] = `The answer becomes "${preview(answer + textFor(option, answer))}"`;
    }
  }
  return criteria;
}

const NEXT_INSTRUCTIONS = {
  task:
    "You are writing a short reply to `question` one character at a time. " +
    "Each option shows what the reply would become after adding one more character. " +
    "Pick the option that best continues `answer_so_far` toward a correct, concise, correctly spelled reply.",
  rules: [
    "Most of the time, continue spelling the word in progress, letter by letter.",
    "Only finish a word (space or punctuation) when it is a complete, real word.",
    "Get to the point: lead with the key fact the question asks for.",
    "The whole reply must fit in `max_length` characters; when `characters_remaining` is low, wrap up.",
    "Choose END as soon as the reply fully answers the question.",
  ],
};

const DONE_INSTRUCTIONS =
  "Does `answer_so_far` already fully and correctly answer `question`, so that writing anything more is unnecessary?";
const DONE_CRITERIA = {
  true: "Yes: it is a finished answer that gives what the question asks for, even if very short.",
  false: "No: it stops mid-word, mid-sentence, or before giving the key information.",
};

export async function nextCharacter(question, answer) {
  const options = allowedOptions(answer);
  const askDone = options.includes(END);
  const questions = { next: choice(NEXT_INSTRUCTIONS, criteriaFor(options, answer)) };
  if (askDone) questions.done = noul(DONE_INSTRUCTIONS, DONE_CRITERIA);

  const { answers } = await systemOne({
    state: {
      question,
      answer_so_far: answer,
      max_length: MAX_LENGTH,
      characters_remaining: MAX_LENGTH - answer.length,
    },
    questions,
  });

  const { probabilities } = answers.next;
  const done = askDone ? answers.done.noul : null;
  const top = options
    .map((o) => ({ option: o, p: probabilities[o] ?? 0 }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 5);

  if (done !== null && done >= DONE_THRESHOLD) {
    return { pick: END, char: "", top, tied: 1, done };
  }

  const best = Math.max(...options.map((o) => probabilities[o] ?? 0));
  const tied = options.filter((o) => (probabilities[o] ?? 0) === best);
  const pick = tied[Math.floor(Math.random() * tied.length)];
  return { pick, char: textFor(pick, answer), top, tied: tied.length, done };
}

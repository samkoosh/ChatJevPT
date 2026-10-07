import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import { mockSystemOne } from "./mock.js";

export const MAX_LENGTH = 140;
export const END = "END";
export const SPACE = "SPACE";
export const ANSWER_PATTERN = /^[A-Za-z .,!?'\-:;]*$/;

const LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
// No quotes or parentheses: in testing, Jev looped on them ("cat t" "cat t" ...).
const CLOSERS = [".", ",", "!", "?", ":", ";"];
const JOINERS = ["'", "-"]; // only inside words: don't, well-known
const DONE_THRESHOLD = 0.6;
const TAIL = 28; // characters of the answer shown in each option's label
const MAX_ROUNDS = 3; // first pick plus up to two runoffs between tied options

let client;
function systemOne(request) {
  if (process.env.JEV_MOCK === "1") return mockSystemOne(request);
  client ??= new TypeSafeClient();
  return client.systemOne(request);
}

const isLetter = (c) => /[A-Za-z]/.test(c ?? "");
const currentWord = (answer) => answer.match(/[A-Za-z'-]*$/)[0];
const atSentenceStart = (answer) => answer.trim() === "" || /[.!?]["')]?\s+$/.test(answer);

// The text an option appends. Code owns capitalization, so Jev only picks letters.
function textFor(option, answer) {
  if (option === SPACE) return " ";
  if (option === END) return "";
  if (option.length === 1 && isLetter(option)) return atSentenceStart(answer) ? option : option.toLowerCase();
  return option;
}

const previousWord = (answer) => (answer.match(/([A-Za-z'-]+)[^A-Za-z'-]+[A-Za-z'-]*$/)?.[1] ?? "").toLowerCase();

// Punctuation and spacing rules are mechanical, so code enforces them instead of asking Jev.
export function allowedOptions(answer) {
  const last = answer.at(-1);
  const options = [];
  let canEnd = false;

  if (last === undefined || last === " ") {
    options.push(...LETTERS);
  } else if (isLetter(last)) {
    const word = currentWord(answer).toLowerCase();
    const realWord = word.length > 1 || word === "a" || word === "i";
    const repeated = word === previousWord(answer); // no "a a" or "the the"
    options.push(...LETTERS, ...JOINERS);
    if (!repeated) options.push(...CLOSERS);
    if (realWord && !repeated) options.push(SPACE);
    canEnd = !repeated;
  } else if (JOINERS.includes(last)) {
    options.push(...LETTERS);
  } else if ([",", ":", ";"].includes(last)) {
    options.push(SPACE);
  } else {
    options.push(SPACE);
    if (last === "." && !answer.endsWith("...")) options.push(".");
    canEnd = true;
  }
  if (canEnd && /[A-Za-z]/.test(answer)) options.push(END);
  return options;
}

function tail(text) {
  return text.length > TAIL ? `…${text.slice(-TAIL)}` : text;
}

// Labels are the text each option produces, not the bare letter: Jev reads labels like
// "A" and "B" as multiple-choice letters and strongly prefers them regardless of meaning.
function labelFor(option, answer) {
  if (option === END) return `"${tail(answer.trim())}" (done)`;
  return `"${tail(answer + textFor(option, answer))}…"`;
}

function describe(option, answer) {
  const word = currentWord(answer);
  if (option === END) return "Stop here: the reply is finished exactly as written.";
  if (option === SPACE) return `Finish the word "${word}" and start a new word.`;
  if (option.length === 1 && isLetter(option)) {
    const letter = textFor(option, answer);
    return word ? `Continue the word as "${word}${letter}".` : `Start a new word with "${letter}".`;
  }
  return `Add "${option}" right after "${tail(answer.trimEnd())}".`;
}

const NEXT_INSTRUCTIONS = {
  task:
    "You are writing a short reply to `question` one character at a time. " +
    "Each option is what the reply would look like after one more character. " +
    "Pick the option that best continues `answer_so_far` toward a correct, concise, correctly spelled reply.",
  rules: [
    "Most of the time, continue spelling the word in progress, letter by letter.",
    "Only finish a word (space or punctuation) when it is a complete, real word.",
    "Give the shortest correct answer: often a single word or short phrase. Don't restate the question.",
    "The whole reply must fit in `max_length` characters; when `characters_remaining` is low, wrap up.",
    "Choose the (done) option as soon as the reply fully answers the question.",
  ],
};

const RUNOFF_INSTRUCTIONS = {
  ...NEXT_INSTRUCTIONS,
  task: `${NEXT_INSTRUCTIONS.task} These options tied in an earlier round; choose the single best one.`,
};

const DONE_INSTRUCTIONS =
  "Does `answer_so_far` already fully and correctly answer `question`, so that writing anything more is unnecessary?";
const DONE_CRITERIA = {
  true: "Yes: it is a finished answer that gives what the question asks for, even if very short.",
  false: "No: it stops mid-word, mid-sentence, or before giving the key information.",
};

// One Choice round over `options`; returns each option's probability.
async function round(state, options, answer, instructions, extraQuestions = {}) {
  const criteria = {};
  const byLabel = {};
  // Shuffled so no letter benefits from always being listed first.
  for (const option of shuffle(options)) {
    const label = labelFor(option, answer);
    criteria[label] = describe(option, answer);
    byLabel[label] = option;
  }
  const { answers } = await systemOne({ state, questions: { next: choice(instructions, criteria), ...extraQuestions } });
  const probabilities = {};
  for (const [label, p] of Object.entries(answers.next.probabilities)) probabilities[byLabel[label]] = p;
  return { probabilities, answers };
}

function shuffle(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function leaders(options, probabilities) {
  const best = Math.max(...options.map((o) => probabilities[o] ?? 0));
  return options.filter((o) => (probabilities[o] ?? 0) === best);
}

export async function nextCharacter(question, answer) {
  const options = allowedOptions(answer);
  const askDone = options.includes(END);
  const state = {
    question,
    answer_so_far: answer,
    max_length: MAX_LENGTH,
    characters_remaining: MAX_LENGTH - answer.length,
  };

  const first = await round(state, options, answer, NEXT_INSTRUCTIONS, askDone ? { done: noul(DONE_INSTRUCTIONS, DONE_CRITERIA) } : {});
  const done = askDone ? first.answers.done.noul : null;
  const top = options
    .map((o) => ({ option: o, p: first.probabilities[o] ?? 0 }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 5);

  if (done !== null && done >= DONE_THRESHOLD) {
    return { pick: END, char: "", top, tied: 1, runoffs: 0, coinFlip: false, done };
  }

  // Ties go to a runoff between only the tied options; a coin flip is the last resort.
  let contenders = leaders(options, first.probabilities);
  const tied = contenders.length;
  let runoffs = 0;
  while (contenders.length > 1 && runoffs < MAX_ROUNDS - 1) {
    runoffs++;
    const { probabilities } = await round(state, contenders, answer, RUNOFF_INSTRUCTIONS);
    contenders = leaders(contenders, probabilities);
  }
  const coinFlip = contenders.length > 1;
  const pick = contenders[Math.floor(Math.random() * contenders.length)];
  return { pick, char: textFor(pick, answer), top, tied, runoffs, coinFlip, done };
}

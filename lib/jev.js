import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import { mockSystemOne } from "./mock.js";
import { examples, isPrefix, isWord } from "./dictionary.js";

export const MAX_LENGTH = 200;
export const MAX_HISTORY = 6; // earlier turns of the chat sent as context
export const END = "END";
export const SPACE = "SPACE";
export const NEWLINE = "NEWLINE";
export const ANSWER_PATTERN = /^[A-Za-z0-9 \n.,!?'\-:;]*$/;

const LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
const DIGITS = Array.from({ length: 10 }, (_, i) => String(i));
// No quotes or parentheses: in testing, Jev looped on them ("cat t" "cat t" ...).
const CLOSERS = [".", ",", "!", "?", ":", ";"];
const JOINERS = ["'", "-"]; // only inside words: don't, well-known
const DONE_THRESHOLD = 0.6;
const WORD_DONE_THRESHOLD = 0.5;
const WORD_CHECK_MAX = 4; // only short words are held open by the word-complete check
const MAX_WORD = 18; // longer than any word Jev should need; forces a runaway word to end
const TAIL = 28; // characters of the answer shown in each option's label
// TypeSafe list price per million tokens (input; output is free). Override with JEV_PRICE_PER_MTOK.
const PRICE_PER_MTOK = Number(process.env.JEV_PRICE_PER_MTOK) || 0.042;
const MAX_ROUNDS = 3; // first pick plus up to two runoffs between tied options

let client;
function defaultSystemOne(request) {
  if (process.env.JEV_MOCK === "1") return mockSystemOne(request);
  client ??= new TypeSafeClient();
  return client.systemOne(request);
}

const isLetter = (c) => /^[A-Za-z]$/.test(c ?? "");
const isDigit = (c) => /^[0-9]$/.test(c ?? "");
const currentWord = (answer) => answer.match(/[A-Za-z0-9'-]*$/)[0];
// The letters since the last apostrophe, hyphen or space: what the dictionary checks.
const segment = (answer) => answer.match(/[A-Za-z]*$/)[0];
const afterApostrophe = (answer) => answer.at(-segment(answer).length - 1) === "'";
const currentNumber = (answer) => answer.match(/[0-9][0-9.,]*$/)?.[0] ?? "";
const atSentenceStart = (answer) => answer.trim() === "" || /[.!?]["')]?\s+$/.test(answer) || answer.endsWith("\n");

// The text an option appends. Code owns capitalization, so Jev only picks letters.
export function textFor(option, answer) {
  if (option === SPACE) return " ";
  if (option === NEWLINE) return "\n";
  if (option === END) return "";
  if (option.length === 1 && isLetter(option)) return atSentenceStart(answer) ? option : option.toLowerCase();
  return option;
}

const previousWord = (answer) =>
  (answer.match(/([A-Za-z0-9'-]+)[^A-Za-z0-9'-]+[A-Za-z0-9'-]*$/)?.[1] ?? "").toLowerCase();

// True if appending `text` would make a stutter: one character three times ("sss") or a
// 2-3 character pattern three times in a row ("ndndnd", "eseses").
function stutters(answer, text) {
  const s = (answer + text).toLowerCase();
  for (let n = 1; n <= 3; n++) {
    const unit = s.slice(-n);
    if (s.length >= n * 3 && s.slice(-n * 3) === unit.repeat(3)) return true;
  }
  return false;
}

// Punctuation and spacing rules are mechanical, so code enforces them instead of asking Jev.
export function allowedOptions(answer) {
  return baseOptions(answer).filter((o) => o === END || !stutters(answer, textFor(o, answer)));
}

function baseOptions(answer) {
  const last = answer.at(-1);
  const options = [];
  let canEnd = false;

  const afterDigit = isDigit(answer.at(-2)); // "3." or "1," can continue as 3.14 or 1,000

  // Letters only go where they keep spelling a real word (60k most common English words),
  // and a word can only end once it is one. Still one letter per call; Jev picks which.
  const spellable = (seg, apostrophe = false) => LETTERS.filter((l) => isPrefix(seg + l, { afterApostrophe: apostrophe }));

  if (last === undefined || last === " " || last === "\n") {
    options.push(...spellable(""), ...DIGITS);
  } else if (isDigit(last)) {
    const repeated = currentWord(answer) === previousWord(answer); // no "5 5"
    options.push(...DIGITS);
    if (!repeated) options.push(SPACE, NEWLINE, ...CLOSERS);
    canEnd = !repeated;
  } else if (isLetter(last)) {
    const word = currentWord(answer).toLowerCase();
    const seg = segment(answer);
    const apostrophe = afterApostrophe(answer);
    const letters = word.length < MAX_WORD ? spellable(seg, apostrophe) : [];
    // A dead end (not a word, can't become one) is let out rather than stuck.
    const realWord = isWord(seg, { afterApostrophe: apostrophe }) || letters.length === 0;
    const repeated = word === previousWord(answer); // no "a a" or "the the"
    options.push(...letters);
    if (realWord && !apostrophe && !word.includes("'")) options.push(...JOINERS);
    if (realWord && !repeated) options.push(SPACE, NEWLINE, ...CLOSERS);
    canEnd = realWord && !repeated;
  } else if (JOINERS.includes(last)) {
    options.push(...spellable("", last === "'"));
  } else if ([",", ":", ";"].includes(last)) {
    options.push(SPACE, NEWLINE);
    if (last === "," && afterDigit) options.push(...DIGITS);
  } else {
    options.push(SPACE, NEWLINE);
    if (last === "." && !answer.endsWith("...")) options.push(".");
    if (last === "." && afterDigit) options.push(...DIGITS);
    canEnd = true;
  }
  if (canEnd && /[A-Za-z0-9]/.test(answer)) options.push(END);
  return options;
}

// Newlines are shown as " / " (like quoted poetry) so labels stay on one line.
function tail(text) {
  const shown = text.length > TAIL ? `…${text.slice(-TAIL)}` : text;
  return shown.replace(/\n/g, " / ");
}

// Labels are the text each option produces, not the bare letter: Jev reads labels like
// "A" and "B" as multiple-choice letters and strongly prefers them regardless of meaning.
export function labelFor(option, answer) {
  if (option === END) return `"${tail(answer.trim())}" (done)`;
  return `"${tail(answer + textFor(option, answer))}…"`;
}

function describe(option, answer) {
  const word = currentWord(answer);
  if (option === END) return "Stop here: the reply is finished exactly as written.";
  if (option === SPACE) return `Finish the word "${word}" and start a new word.`;
  if (option === NEWLINE) return "Start a new line, as in a poem or a list.";
  if (isDigit(option)) {
    const number = currentNumber(answer);
    return number ? `Continue the number as "${number}${option}".` : `Start a number with "${option}".`;
  }
  if (option.length === 1 && isLetter(option)) {
    const letter = textFor(option, answer);
    const seg = segment(answer) + letter;
    const like = afterApostrophe(answer) ? "" : examples(seg).join(", ");
    const hint = like ? ` (as in: ${like})` : "";
    return word ? `Continue the word as "${word}${letter}"${hint}.` : `Start a new word with "${letter}"${hint}.`;
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
    "`previous_turns` (if present) are earlier questions and replies in this chat; use them to understand follow-up questions.",
    "Give the shortest correct answer: often a single word or short phrase. Don't restate the question.",
    "Write numbers with digits, like 4, 1969 or 3.14.",
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
const WORD_DONE_INSTRUCTIONS =
  "Is `word_in_progress` already a complete, correctly spelled word that makes sense at the end of `answer_so_far`?";
const WORD_DONE_CRITERIA = {
  true: "Yes: it is a real, finished word (like \"blue\" or \"Paris\") that fits here.",
  false: "No: it is a fragment or misspelling that needs more letters (like \"bl\" or \"Shakesp\").",
};

const DONE_CRITERIA = {
  true: "Yes: it is a finished answer that gives what the question asks for, even if very short.",
  false: "No: it stops mid-word, mid-sentence, or before giving the key information.",
};

// One Choice round over `options`; returns each option's probability.
async function round(systemOne, state, options, answer, instructions, extraQuestions = {}) {
  const criteria = {};
  const byLabel = {};
  // Shuffled so no letter benefits from always being listed first.
  for (const option of shuffle(options)) {
    const label = labelFor(option, answer);
    criteria[label] = describe(option, answer);
    byLabel[label] = option;
  }
  const { answers, usage } = await systemOne({ state, questions: { next: choice(instructions, criteria), ...extraQuestions } });
  const probabilities = {};
  for (const [label, p] of Object.entries(answers.next.probabilities)) probabilities[byLabel[label]] = p;
  return { probabilities, answers, tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0) };
}

const costOf = (tokens) => (tokens / 1e6) * PRICE_PER_MTOK;

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

// Earlier turns as [{ question, answer }], oldest first; anything malformed is dropped.
export function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((t) => typeof t?.question === "string" && typeof t?.answer === "string")
    .slice(-MAX_HISTORY)
    .map((t) => ({ question: t.question.slice(0, 500), answer: t.answer.slice(0, MAX_LENGTH) }));
}

// `systemOne` can be swapped out in tests.
export async function nextCharacter(question, answer, history = [], { systemOne = defaultSystemOne } = {}) {
  const options = allowedOptions(answer);
  const askDone = options.includes(END);
  const previousTurns = normalizeHistory(history);
  const state = {
    ...(previousTurns.length ? { previous_turns: previousTurns } : {}),
    question,
    answer_so_far: answer,
    max_length: MAX_LENGTH,
    characters_remaining: MAX_LENGTH - answer.length,
  };

  // While a word is being spelled, also ask whether it's finished. If not, every option that
  // would end it (space, punctuation, END) is masked out and Jev keeps spelling.
  const spelling = isLetter(answer.at(-1)) ? currentWord(answer) : "";
  const word = spelling.length <= WORD_CHECK_MAX ? spelling : "";
  if (word) state.word_in_progress = word;
  const extra = {};
  if (askDone) extra.done = noul(DONE_INSTRUCTIONS, DONE_CRITERIA);
  if (word) extra.word_done = noul(WORD_DONE_INSTRUCTIONS, WORD_DONE_CRITERIA);

  const first = await round(systemOne, state, options, answer, NEXT_INSTRUCTIONS, extra);
  const wordDone = word ? first.answers.word_done.noul : null;
  const wordUnfinished = wordDone !== null && wordDone < WORD_DONE_THRESHOLD;
  const eligible = wordUnfinished ? options.filter((o) => isLetter(o) || JOINERS.includes(o)) : options;
  const done = askDone && !wordUnfinished ? first.answers.done.noul : null;
  const top = options
    .map((o) => ({ option: o, p: first.probabilities[o] ?? 0 }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 5);

  if (done !== null && done >= DONE_THRESHOLD) {
    return { pick: END, char: "", top, tied: 1, runoffs: 0, coinFlip: false, done, wordDone, tokens: first.tokens, cost: costOf(first.tokens) };
  }

  // Ties go to a runoff between only the tied options; a coin flip is the last resort.
  let contenders = leaders(eligible, first.probabilities);
  const tied = contenders.length;
  let runoffs = 0;
  let tokens = first.tokens;
  while (contenders.length > 1 && runoffs < MAX_ROUNDS - 1) {
    runoffs++;
    const runoff = await round(systemOne, state, contenders, answer, RUNOFF_INSTRUCTIONS);
    const { probabilities } = runoff;
    tokens += runoff.tokens;
    contenders = leaders(contenders, probabilities);
  }
  const coinFlip = contenders.length > 1;
  const pick = contenders[Math.floor(Math.random() * contenders.length)];
  return { pick, char: textFor(pick, answer), top, tied, runoffs, coinFlip, done, wordDone, tokens, cost: costOf(tokens) };
}

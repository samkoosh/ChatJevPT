import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";
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
// True if finishing the word in progress would repeat: the same word twice in a row ("the the"),
// the last three words already together earlier ("from the there ... from the there"), or an
// overused word (a short one more than 4 times, a longer one more than twice). Like an LLM's
// no-repeat n-gram setting, except Jev is asked whether the question wants repetition first.
export function loops(answer) {
  const words = answer.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const word = words.at(-1);
  if (!word) return false;
  if (words.at(-2) === word) return true;
  const uses = words.filter((w) => w === word).length;
  if (uses > (word.length <= 3 ? 4 : 2)) return true;
  if (words.length < 4) return false;
  const tri = words.slice(-3).join(" ");
  for (let i = 0; i + 3 < words.length; i++) if (words.slice(i, i + 3).join(" ") === tri) return true;
  return false;
}

const ENDS_WORD = new Set([SPACE, NEWLINE, ...CLOSERS, END]);
const repeating = (answer) => /[A-Za-z0-9]$/.test(answer) && loops(answer);

// `allowRepeats`: the question asks for repetition ("say duck 6 times"), so loops are fine.
export function allowedOptions(answer, { allowRepeats = false } = {}) {
  const options = baseOptions(answer).filter((o) => o === END || !stutters(answer, textFor(o, answer)));
  return allowRepeats ? options : withoutRepeats(answer, options);
}

// A repeating word can't be finished, only extended into a different word. If that leaves
// nothing, let it through rather than get stuck.
function withoutRepeats(answer, options) {
  if (!repeating(answer)) return options;
  const kept = options.filter((o) => !ENDS_WORD.has(o));
  return kept.length ? kept : options;
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
    options.push(...DIGITS, SPACE, NEWLINE, ...CLOSERS);
    canEnd = true;
  } else if (isLetter(last)) {
    const word = currentWord(answer).toLowerCase();
    const seg = segment(answer);
    const apostrophe = afterApostrophe(answer);
    const letters = word.length < MAX_WORD ? spellable(seg, apostrophe) : [];
    // A dead end (not a word, can't become one) is let out rather than stuck.
    const realWord = isWord(seg, { afterApostrophe: apostrophe }) || letters.length === 0;
    options.push(...letters);
    if (realWord && !apostrophe && !word.includes("'")) options.push(...JOINERS);
    if (realWord) options.push(SPACE, NEWLINE, ...CLOSERS);
    canEnd = realWord;
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

const REPEAT_THRESHOLD = 0.5;
const REPEAT_INSTRUCTIONS =
  "`answer_so_far` is starting to repeat itself. Does `question` ask for repetition, so that repeating a word or phrase is exactly what's wanted (like \"say duck 6 times\", a chant or a chorus)?";
const REPEAT_CRITERIA = {
  true: "Yes: the question asks for something to be repeated.",
  false: "No: repeating here is a loop that doesn't help answer the question.",
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
// Screening: before ranking, every candidate gets its own Noul ("is this still heading somewhere
// sensible?"), all in one parallel request. Only candidates at or above SCREEN_THRESHOLD go on
// to the ranking Choice; if fewer than SCREEN_KEEP_MIN pass, the best SCREEN_KEEP_MIN do.
const SCREEN_THRESHOLD = 0.3;
const SCREEN_KEEP_MIN = 2;
const SCREEN_TASK =
  "`candidate` is `answer_so_far` with one more character added. Is it still on its way to a sensible, correct reply to `question`?";
const SCREEN_CRITERIA = {
  true: "Yes: it reads as the start of a sensible reply that answers the question.",
  false: "No: it's turning into nonsense, a misspelling, a loop, or something off-topic.",
};

// Sense check: each time a word is finished (right after a space), Jev reads the answer alone,
// without the question, and judges whether it makes sense. Below SENSE_THRESHOLD the answer
// stops ("Jev got too spicy").
const SENSE_THRESHOLD = 0.35;
const SENSE_INSTRUCTIONS =
  "Does `text` make sense so far? It may be unfinished; judge whether it reads like the start of a sensible sentence.";
const SENSE_CRITERIA = {
  true: "Yes: sensible words in a sensible order, even if the sentence isn't finished.",
  false: "No: word salad, made-up words, broken grammar, or the same words looping.",
};

async function senseCheck(systemOne, answer) {
  const { answers, usage } = await systemOne({
    state: { text: answer.trim() },
    questions: { sensible: noul(SENSE_INSTRUCTIONS, SENSE_CRITERIA) },
  });
  return { sensible: answers.sensible.noul, tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0) };
}

// `systemOne` can be swapped out in tests.
export async function nextCharacter(question, answer, history = [], { systemOne = defaultSystemOne } = {}) {
  // Options are built allowing repeats; if the answer is repeating, Jev is also asked whether
  // the question wants that, and the repeat is masked out afterwards if not.
  const options = allowedOptions(answer, { allowRepeats: true });
  const askDone = options.includes(END);
  const askSense = answer.endsWith(" ") && /[A-Za-z]{2}/.test(answer);
  // Also ask about repetition when the sense check might trip on it: a context-free reader
  // can't tell "duck duck duck" (asked for) from a loop.
  const askRepeat = repeating(answer) || (askSense && loops(answer.trimEnd()));
  const previousTurns = normalizeHistory(history);
  const state = {
    ...(previousTurns.length ? { previous_turns: previousTurns } : {}),
    question,
    answer_so_far: answer,
    max_length: MAX_LENGTH,
    characters_remaining: MAX_LENGTH - answer.length,
  };

  // While a short word is being spelled, also ask whether it's finished. If not, every option
  // that would end it (space, punctuation, END) is masked out and Jev keeps spelling.
  const spelling = isLetter(answer.at(-1)) ? currentWord(answer) : "";
  const word = spelling.length <= WORD_CHECK_MAX ? spelling : "";
  if (word) state.word_in_progress = word;

  // Round 1: one parallel request of Nouls: a screen per candidate, plus done / word_done /
  // repeat_ok. The sense check runs alongside it as its own request, without the question.
  const candidates = options.filter((o) => o !== END);
  const questions = {};
  candidates.forEach((o, i) => {
    questions[`c${i}`] = noul({ task: SCREEN_TASK, candidate: labelFor(o, answer), how: describe(o, answer) }, SCREEN_CRITERIA);
  });
  if (askDone) questions.done = noul(DONE_INSTRUCTIONS, DONE_CRITERIA);
  if (word) questions.word_done = noul(WORD_DONE_INSTRUCTIONS, WORD_DONE_CRITERIA);
  if (askRepeat) questions.repeat_ok = noul(REPEAT_INSTRUCTIONS, REPEAT_CRITERIA);
  const [screen, sense] = await Promise.all([
    systemOne({ state, questions }),
    askSense ? senseCheck(systemOne, answer) : null,
  ]);
  let tokens = (screen.usage?.input_tokens ?? 0) + (screen.usage?.output_tokens ?? 0) + (sense?.tokens ?? 0);
  const a = screen.answers;
  const screenP = Object.fromEntries(candidates.map((o, i) => [o, a[`c${i}`].noul]));
  const sensible = sense ? sense.sensible : null;
  const wordDone = word ? a.word_done.noul : null;
  const repeatOk = askRepeat ? a.repeat_ok.noul : null;
  const base = { tied: 1, runoffs: 0, coinFlip: false, wordDone, repeatOk, sensible };

  const topOf = (probabilities, from) =>
    from
      .map((o) => ({ option: o, p: probabilities[o] ?? 0 }))
      .sort((x, y) => y.p - x.p)
      .slice(0, 5);

  const repeatWanted = repeatOk !== null && repeatOk >= REPEAT_THRESHOLD;
  if (sensible !== null && sensible < SENSE_THRESHOLD && !repeatWanted) {
    return { ...base, pick: END, char: "", spicy: true, top: topOf(screenP, candidates), done: null, screened: 0, tokens, cost: costOf(tokens) };
  }

  const wordUnfinished = wordDone !== null && wordDone < WORD_DONE_THRESHOLD;
  let eligible = repeatOk !== null && repeatOk < REPEAT_THRESHOLD ? withoutRepeats(answer, options) : options;
  if (wordUnfinished) eligible = eligible.filter((o) => isLetter(o) || JOINERS.includes(o));
  const done = eligible.includes(END) && !wordUnfinished ? a.done.noul : null;
  if (done !== null && done >= DONE_THRESHOLD) {
    return { ...base, pick: END, char: "", top: topOf(screenP, candidates), done, screened: 0, tokens, cost: costOf(tokens) };
  }

  // Screen: keep candidates Jev thinks are heading somewhere sensible.
  const pool = eligible.filter((o) => o !== END).sort((x, y) => screenP[y] - screenP[x]);
  let passed = pool.filter((o) => screenP[o] >= SCREEN_THRESHOLD);
  if (passed.length < SCREEN_KEEP_MIN) passed = pool.slice(0, SCREEN_KEEP_MIN);
  const finalists = eligible.includes(END) ? [...passed, END] : passed;
  if (finalists.length === 1) {
    const pick = finalists[0];
    return { ...base, pick, char: textFor(pick, answer), top: topOf(screenP, candidates), done, screened: 1, tokens, cost: costOf(tokens) };
  }

  // Round 2: the ranking Choice, over the finalists only.
  const ranked = await round(systemOne, state, finalists, answer, NEXT_INSTRUCTIONS);
  tokens += ranked.tokens;

  // Ties go to a runoff between only the tied options; a coin flip is the last resort.
  let contenders = leaders(finalists, ranked.probabilities);
  const tied = contenders.length;
  let runoffs = 0;
  while (contenders.length > 1 && runoffs < MAX_ROUNDS - 1) {
    runoffs++;
    const runoff = await round(systemOne, state, contenders, answer, RUNOFF_INSTRUCTIONS);
    tokens += runoff.tokens;
    contenders = leaders(contenders, runoff.probabilities);
  }
  const coinFlip = contenders.length > 1;
  const pick = contenders[Math.floor(Math.random() * contenders.length)];
  return {
    ...base,
    pick,
    char: textFor(pick, answer),
    top: topOf(ranked.probabilities, finalists),
    tied,
    runoffs,
    coinFlip,
    done,
    screened: finalists.length,
    tokens,
    cost: costOf(tokens),
  };
}

// After an answer is finished, Jev grades it: one Score question over five levels.
export const RATINGS = ["Terrible", "Bad", "Solid", "Good", "Perfect"];
const RATING_INSTRUCTIONS =
  "How good is `answer` as a reply to `question`? Take `previous_turns` (if present) into account: a follow-up question depends on them. Judge correctness first, then whether it reads as clear, sensible English.";
const RATING_CRITERIA = [
  "Terrible: wrong, or gibberish that doesn't answer the question at all.",
  "Bad: mostly wrong or garbled, though a fragment may touch on the right idea.",
  "Solid: gets the main point across, but is garbled, padded or partly off.",
  "Good: correct and clear, with only minor awkwardness.",
  "Perfect: correct, clear and concise; exactly what was asked for.",
];

export async function rateAnswer(question, answer, history = [], { systemOne = defaultSystemOne } = {}) {
  const previousTurns = normalizeHistory(history);
  const { answers, usage } = await systemOne({
    state: { ...(previousTurns.length ? { previous_turns: previousTurns } : {}), question, answer },
    questions: { rating: score(RATING_INSTRUCTIONS, RATING_CRITERIA) },
  });
  const value = answers.rating.score; // expected level, 0 (Terrible) to 4 (Perfect)
  const tokens = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
  const label = RATINGS[Math.min(4, Math.max(0, Math.round(value)))];
  return { label, score: value, tokens, cost: costOf(tokens) };
}

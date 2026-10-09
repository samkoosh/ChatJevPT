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

// A runoff asks the same thing, noting that the options tied.
const RUNOFF_NOTE = "These options tied in an earlier round; choose the single best one.";
const tiedVersion = (instructions, note) =>
  typeof instructions === "string" ? `${instructions} ${note}` : { ...instructions, task: `${instructions.task} ${note}` };

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

// One Choice round over `options`; returns each option's probability. By default the options
// are characters (Stump's ranking); Post's first round passes its own key, labels and
// descriptions for kinds of character, plus the checks asked alongside it.
async function round(systemOne, state, options, answer, instructions, { key = "next", label = labelFor, how = describe, extra = {} } = {}) {
  const criteria = {};
  const byLabel = {};
  // Shuffled so no letter benefits from always being listed first.
  for (const option of shuffle(options)) {
    const l = label(option, answer);
    criteria[l] = how(option, answer);
    byLabel[l] = option;
  }
  const { answers, usage } = await systemOne({ state, questions: { [key]: choice(instructions, criteria), ...extra } });
  const probabilities = {};
  for (const [l, p] of Object.entries(answers[key].probabilities)) probabilities[byLabel[l]] = p;
  return { probabilities, answers, tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0) };
}

// Ties go to up to two runoffs between only the tied options; a coin flip is the last resort.
async function breakTies(systemOne, state, options, probabilities, answer, instructions, roundOptions) {
  let contenders = leaders(options, probabilities);
  const tied = contenders.length;
  let runoffs = 0;
  let tokens = 0;
  while (contenders.length > 1 && runoffs < MAX_ROUNDS - 1) {
    runoffs++;
    const runoff = await round(systemOne, state, contenders, answer, instructions, roundOptions);
    tokens += runoff.tokens;
    contenders = leaders(contenders, runoff.probabilities);
  }
  const coinFlip = contenders.length > 1;
  return { pick: contenders[Math.floor(Math.random() * contenders.length)], tied, runoffs, coinFlip, tokens };
}

const topOf = (probabilities, from) =>
  from
    .map((o) => ({ option: o, p: probabilities[o] ?? 0 }))
    .sort((x, y) => y.p - x.p)
    .slice(0, 5);

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

async function senseCheck(systemOne, answer, p) {
  const { answers, usage } = await systemOne({
    state: { text: answer.trim() },
    questions: { sensible: noul(p.sense, SENSE_CRITERIA) },
  });
  return { sensible: answers.sensible.noul, tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0) };
}

// What Stump and Post both ask on every character, besides their first round: the options code
// allows, the state Jev sees, and the checks (done / word_done / repeat_ok, and whether to run
// the sense check alongside).
function prepare(question, answer, history, p) {
  // Options are built allowing repeats; if the answer is repeating, Jev is also asked whether
  // the question wants that, and the repeat is masked out afterwards if not.
  const options = allowedOptions(answer, { allowRepeats: true });
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

  const checks = {};
  if (options.includes(END)) checks.done = noul(p.done, DONE_CRITERIA);
  if (word) checks.word_done = noul(p.word_done, WORD_DONE_CRITERIA);
  if (askRepeat) checks.repeat_ok = noul(p.repeat_ok, REPEAT_CRITERIA);
  return { options, state, askSense, checks };
}

// Applies the checks' answers: stop as spicy, stop as done, or the options still eligible.
function judge(answer, options, checks, a, sensible) {
  const wordDone = checks.word_done ? a.word_done.noul : null;
  const repeatOk = checks.repeat_ok ? a.repeat_ok.noul : null;
  const base = { tied: 1, runoffs: 0, coinFlip: false, wordDone, repeatOk, sensible };

  const repeatWanted = repeatOk !== null && repeatOk >= REPEAT_THRESHOLD;
  if (sensible !== null && sensible < SENSE_THRESHOLD && !repeatWanted) return { base, stop: { spicy: true, done: null } };

  const wordUnfinished = wordDone !== null && wordDone < WORD_DONE_THRESHOLD;
  let eligible = repeatOk !== null && repeatOk < REPEAT_THRESHOLD ? withoutRepeats(answer, options) : options;
  if (wordUnfinished) eligible = eligible.filter((o) => isLetter(o) || JOINERS.includes(o));
  const done = eligible.includes(END) && !wordUnfinished ? a.done.noul : null;
  if (done !== null && done >= DONE_THRESHOLD) return { base, stop: { done } };
  return { base, eligible, done };
}

// One screening Noul per candidate, keyed c0, c1, ...
function screenQuestions(candidates, answer, p) {
  return Object.fromEntries(
    candidates.map((o, i) => [`c${i}`, noul({ task: p.screen, candidate: labelFor(o, answer), how: describe(o, answer) }, SCREEN_CRITERIA)]),
  );
}

// Keep candidates Jev thinks are heading somewhere sensible (at least the best SCREEN_KEEP_MIN).
function screenFinalists(eligible, screenP) {
  const pool = eligible.filter((o) => o !== END).sort((x, y) => screenP[y] - screenP[x]);
  let passed = pool.filter((o) => screenP[o] >= SCREEN_THRESHOLD);
  if (passed.length < SCREEN_KEEP_MIN) passed = pool.slice(0, SCREEN_KEEP_MIN);
  return eligible.includes(END) ? [...passed, END] : passed;
}

// The ranking Choice over the finalists, with runoffs on a tie.
async function rankFinalists(systemOne, state, finalists, answer, p) {
  const instructions = fromText(p.rank);
  const ranked = await round(systemOne, state, finalists, answer, instructions);
  const result = await breakTies(systemOne, state, finalists, ranked.probabilities, answer, tiedVersion(instructions, RUNOFF_NOTE));
  return { ...result, top: topOf(ranked.probabilities, finalists), tokens: ranked.tokens + result.tokens };
}

// `systemOne` can be swapped out in tests.
export async function nextCharacter(question, answer, history = [], { systemOne = defaultSystemOne, prompts } = {}) {
  const p = withDefaults(prompts);
  const { options, state, askSense, checks } = prepare(question, answer, history, p);

  // Round 1: one parallel request of Nouls: a screen per candidate, plus done / word_done /
  // repeat_ok. The sense check runs alongside it as its own request, without the question.
  const candidates = options.filter((o) => o !== END);
  const [screen, sense] = await Promise.all([
    systemOne({ state, questions: { ...screenQuestions(candidates, answer, p), ...checks } }),
    askSense ? senseCheck(systemOne, answer, p) : null,
  ]);
  let tokens = (screen.usage?.input_tokens ?? 0) + (screen.usage?.output_tokens ?? 0) + (sense?.tokens ?? 0);
  const a = screen.answers;
  const screenP = Object.fromEntries(candidates.map((o, i) => [o, a[`c${i}`].noul]));
  const { base, stop, eligible, done } = judge(answer, options, checks, a, sense ? sense.sensible : null);
  if (stop) return { ...base, pick: END, char: "", ...stop, top: topOf(screenP, candidates), screened: 0, tokens, cost: costOf(tokens) };

  const finalists = screenFinalists(eligible, screenP);
  if (finalists.length === 1) {
    const pick = finalists[0];
    return { ...base, pick, char: textFor(pick, answer), top: topOf(screenP, candidates), done, screened: 1, tokens, cost: costOf(tokens) };
  }

  // Round 2: the ranking Choice, over the finalists only.
  const ranked = await rankFinalists(systemOne, state, finalists, answer, p);
  tokens += ranked.tokens;
  const { pick, top, tied, runoffs, coinFlip } = ranked;
  return { ...base, pick, char: textFor(pick, answer), top, tied, runoffs, coinFlip, done, screened: finalists.length, tokens, cost: costOf(tokens) };
}

// Post: the first round asks what kind of character comes next (a letter, a number, a space, a
// line break, punctuation, or the end), with Stump's checks asked alongside. Then, within the
// winning kind, Stump's screening and ranking pick the character. Kinds with a single character
// (a space, a line break, the end) need no second round.
export const LETTER = "LETTER";
export const NUMBER = "NUMBER";
export const PUNCTUATION = "PUNCTUATION";
export const KINDS = [LETTER, NUMBER, SPACE, NEWLINE, PUNCTUATION, END];

export function kindOf(option) {
  if (isLetter(option)) return LETTER;
  if (isDigit(option)) return NUMBER;
  if ([SPACE, NEWLINE, END].includes(option)) return option;
  return PUNCTUATION;
}

const KIND_LABELS = { [LETTER]: "Letter", [NUMBER]: "Number", [SPACE]: "Space", [NEWLINE]: "Line break", [PUNCTUATION]: "Punctuation", [END]: "End of answer" };
export const kindLabel = (kind) => KIND_LABELS[kind];

// `options` are the characters code allows here, so punctuation lists only the marks that fit.
function describeKind(kind, answer, options) {
  const word = currentWord(answer);
  const number = currentNumber(answer);
  if (kind === LETTER) return /[A-Za-z]$/.test(word) || JOINERS.includes(answer.at(-1)) ? `Another letter in the word "${word}".` : "A letter, starting a new word.";
  if (kind === NUMBER) return number ? `Another digit in the number "${number}".` : "A digit, starting a number (like 4, 1969 or 3.14).";
  if (kind === SPACE) return word ? `A space: "${word}" is finished and a new word starts.` : "A space before the next word.";
  if (kind === NEWLINE) return "A line break: start a new line, as in a poem or a list.";
  if (kind === PUNCTUATION) return `A punctuation mark: ${options.filter((o) => kindOf(o) === PUNCTUATION).join(" ")}`;
  return "The end: the reply is finished exactly as written.";
}

const KIND_INSTRUCTIONS = {
  task:
    "You are writing a short reply to `question` one character at a time. " +
    "Decide what kind of character comes next in `answer_so_far`: a letter, a number, a space, a line break, punctuation, or the end of the reply.",
  rules: [
    "Most of the time, the next character is another letter of the word in progress.",
    "Only finish a word (space or punctuation) when it is a complete, real word.",
    ...NEXT_INSTRUCTIONS.rules.slice(2, -1),
    "Choose End of answer as soon as the reply fully answers the question.",
  ],
};
const KIND_RUNOFF_NOTE = "These kinds tied in an earlier round; choose the single best one.";

export async function postCharacter(question, answer, history = [], { systemOne = defaultSystemOne, prompts } = {}) {
  const p = withDefaults(prompts);
  const kindInstructions = fromText(p.kind);
  const { options, state, askSense, checks } = prepare(question, answer, history, p);
  const kinds = KINDS.filter((k) => options.some((o) => kindOf(o) === k));
  const kindRound = { key: "kind", label: kindLabel, how: (k) => describeKind(k, answer, options) };

  // Round 1: the kind Choice, with done / word_done / repeat_ok in the same request and the
  // sense check alongside, as in Stump.
  const [first, sense] = await Promise.all([
    round(systemOne, state, kinds, answer, kindInstructions, { ...kindRound, extra: checks }),
    askSense ? senseCheck(systemOne, answer, p) : null,
  ]);
  let tokens = first.tokens + (sense?.tokens ?? 0);
  const kindTop = topOf(first.probabilities, kinds);
  const { base, stop, eligible, done } = judge(answer, options, checks, first.answers, sense ? sense.sensible : null);
  if (stop) return { ...base, pick: END, char: "", ...stop, kind: END, kinds: kindTop, top: kindTop, screened: 0, tokens, cost: costOf(tokens) };

  // The checks can rule kinds out (an unfinished word can't end); the best remaining kind wins.
  const open = kinds.filter((k) => eligible.some((o) => kindOf(o) === k));
  const chosen = await breakTies(systemOne, state, open, first.probabilities, answer, tiedVersion(kindInstructions, KIND_RUNOFF_NOTE), kindRound);
  tokens += chosen.tokens;
  const kind = chosen.pick;
  const kindResult = { kind, kinds: kindTop, kindTied: chosen.tied, kindRunoffs: chosen.runoffs, kindCoinFlip: chosen.coinFlip };
  const within = eligible.filter((o) => kindOf(o) === kind);
  if (within.length === 1) {
    const pick = within[0];
    return { ...base, ...kindResult, pick, char: textFor(pick, answer), top: kindTop, done, screened: 0, tokens, cost: costOf(tokens) };
  }

  // Round 2: Stump's screening, over this kind's characters only.
  const screen = await systemOne({ state, questions: screenQuestions(within, answer, p) });
  tokens += (screen.usage?.input_tokens ?? 0) + (screen.usage?.output_tokens ?? 0);
  const screenP = Object.fromEntries(within.map((o, i) => [o, screen.answers[`c${i}`].noul]));
  const finalists = screenFinalists(within, screenP);
  if (finalists.length === 1) {
    const pick = finalists[0];
    return { ...base, ...kindResult, pick, char: textFor(pick, answer), top: topOf(screenP, within), done, screened: 1, tokens, cost: costOf(tokens) };
  }

  // Round 3: Stump's ranking Choice over the finalists, with runoffs on a tie.
  const ranked = await rankFinalists(systemOne, state, finalists, answer, p);
  tokens += ranked.tokens;
  const { pick, top, tied, runoffs, coinFlip } = ranked;
  return { ...base, ...kindResult, pick, char: textFor(pick, answer), top, tied, runoffs, coinFlip, done, screened: finalists.length, tokens, cost: costOf(tokens) };
}

// Model levels, as in "dumb as a ___". Doornail is the naive version: one Choice per character over
// every character, with nothing but the question and the answer so far. Rock asks the same
// way, but each option is the whole answer it would make, and it runs a tournament of three rounds. Stump is the full pipeline
// above. Post asks for the kind of character first, then runs Stump's checks within it.
export const LEVELS = ["doornail", "rock", "stump", "post"];
export const PLAYABLE_LEVELS = ["doornail", "rock", "stump", "post"];
const DOORNAIL_OPTIONS = [...LETTERS, ...DIGITS, SPACE, NEWLINE, ...CLOSERS, ...JOINERS];
export const DOORNAIL_INSTRUCTIONS = "Which character should come next in `answer_so_far` to answer `question`?";
export const MAX_LAB_INSTRUCTIONS = 4000;
const DOORNAIL_LABELS = { [SPACE]: "space" };
const PUNCTUATION_NAMES = { ".": "A period.", ",": "A comma.", "!": "An exclamation mark.", "?": "A question mark.", ":": "A colon.", ";": "A semicolon.", "'": "An apostrophe.", "-": "A hyphen." };
const DOORNAIL_DESCRIPTIONS = {
  ...Object.fromEntries(LETTERS.map((l) => [l, `The letter ${l}.`])),
  ...Object.fromEntries(DIGITS.map((d) => [d, `The digit ${d}.`])),
  ...PUNCTUATION_NAMES,
  [SPACE]: "A space between words (as though the keyboard's space bar was pressed).",
  [NEWLINE]: "A line break (as though the keyboard's Return key was pressed).",
  [END]: "The end of the answer, used to immediately stop generation. Use when the answer is satisfactory and complete.",
};

const doornailOptions = (answer) => (answer.trim() ? [...DOORNAIL_OPTIONS, END] : DOORNAIL_OPTIONS);
const doornailLabel = (o) => DOORNAIL_LABELS[o] ?? o;

// The `questions` part of a Doornail request. Labels are the characters themselves (a space is "space"),
// and every option is described: with bare labels, "A" reads like option A of a quiz and gets
// picked to start answers. The lab shows this exact object.
export function doornailQuestions(instructions, options = [...DOORNAIL_OPTIONS, END]) {
  const criteria = Object.fromEntries(options.map((o) => [doornailLabel(o), DOORNAIL_DESCRIPTIONS[o] ?? null]));
  return { next: choice(instructions || DOORNAIL_INSTRUCTIONS, criteria) };
}

// The whole request for one character, built the same way for real answers and for the lab's
// example. `instructions` replaces the default prompt (the lab can change it).
function doornailRequest(question, answer, instructions) {
  return { state: { question, answer_so_far: answer }, questions: doornailQuestions(instructions, doornailOptions(answer)) };
}

// Rock: Doornail's one Choice over every character, but each option is the whole answer it would
// make (the answer so far plus that character; END keeps it as it is), so Jev ranks finished-looking
// phrases instead of picking a letter to append. The state says how many characters are left.
export const ROCK_INSTRUCTIONS =
  "Each option is a possible answer to `question`, one character longer than the last (or, if marked done, finished as it is). Which option is the best start to the answer?";

// Labels are quoted so a trailing space shows; line breaks are shown as " / " to keep them on one line.
export function rockLabel(option, answer) {
  if (option === END) return `"${answer.replace(/\n/g, " / ")}" (done)`;
  return `"${(answer + textFor(option, answer)).replace(/\n/g, " / ")}"`;
}
const ROCK_DESCRIPTIONS = {
  [SPACE]: "Ends with a space: the last word is finished and a new one starts.",
  [NEWLINE]: "Ends with a line break.",
  [END]: "Stop here: the answer is finished exactly as written.",
};

// Rock is a tournament: the first Choice is over every option, then the same question again over
// only the top ROCK_SEMIFINAL, then over the top ROCK_FINAL, whose winner is the pick.
export const ROCK_SEMIFINAL = 5;
export const ROCK_FINAL = 2;
const ROCK_ROUNDS = [ROCK_SEMIFINAL, ROCK_FINAL];
// An option this probable in any round wins outright; the rest of the tournament is skipped.
export const ROCK_CONFIDENT = 0.9;

export function rockQuestions(answer, instructions, options = doornailOptions(answer)) {
  const criteria = Object.fromEntries(options.map((o) => [rockLabel(o, answer), ROCK_DESCRIPTIONS[o] ?? null]));
  return { next: choice(instructions || ROCK_INSTRUCTIONS, criteria) };
}

// Options go in a fresh random order every request, so Jev can't favor whatever is listed first.
function rockRequest(question, answer, instructions, options = doornailOptions(answer)) {
  return { state: { question, characters_remaining: MAX_LENGTH - answer.length }, questions: rockQuestions(answer, instructions, shuffle(options)) };
}

// Levels whose instructions admins can edit in the lab.
export const LAB_LEVELS = ["doornail", "rock"];
export const LAB_DEFAULTS = { doornail: DOORNAIL_INSTRUCTIONS, rock: ROCK_INSTRUCTIONS };
const REQUESTS = { doornail: doornailRequest, rock: rockRequest };
// Made-up data for the lab's view of the request: a question partway through its answer.
export const LAB_EXAMPLE = { question: "What is the capital of France?", answer: "Pa" };
export const labRequest = (level, instructions, { question, answer } = LAB_EXAMPLE) => REQUESTS[level](question, answer, instructions);

// One Choice over the characters (Doornail), or Rock's tournament of them: after each round only the
// top few go on to the next. The most probable in the last round wins, ties at random.
async function singleChoiceCharacter(level, question, answer, { systemOne = defaultSystemOne, instructions } = {}) {
  const label = level === "rock" ? (o) => rockLabel(o, answer) : doornailLabel;
  const cuts = level === "rock" ? ROCK_ROUNDS : [];
  let field = doornailOptions(answer);
  let tokens = 0;
  let top;
  let probabilities;
  const rounds = []; // what each round of Rock's tournament saw: its size and top few
  let stoppedEarly = false;
  for (let round = 0; ; round++) {
    const { answers, usage } = await systemOne(REQUESTS[level](question, answer, instructions, field));
    tokens += (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
    probabilities = Object.fromEntries(field.map((o) => [o, answers.next.probabilities[label(o)] ?? 0]));
    // Shuffled first so a tie at the cut is decided at random, not by option order.
    const ranked = shuffle(field).sort((a, b) => probabilities[b] - probabilities[a]);
    top ??= ranked.slice(0, 5).map((o) => ({ option: o, p: probabilities[o] }));
    rounds.push({ size: field.length, top: ranked.slice(0, 5).map((o) => ({ option: o, p: probabilities[o] })) });
    if (level === "rock" && round < cuts.length && probabilities[ranked[0]] >= ROCK_CONFIDENT) {
      field = [ranked[0]];
      stoppedEarly = true;
      break;
    }
    // Skip rounds that wouldn't cut anything (a field already that small).
    while (cuts.length > round && cuts[round] >= field.length) round++;
    if (round >= cuts.length) break;
    field = ranked.slice(0, cuts[round]);
  }
  const contenders = leaders(field, probabilities);
  const pick = contenders[Math.floor(Math.random() * contenders.length)];
  const tournament = level === "rock" ? { rounds, stoppedEarly } : {};
  return { pick, char: textFor(pick, answer), top, ...tournament, tied: contenders.length, runoffs: 0, coinFlip: contenders.length > 1, tokens, cost: costOf(tokens) };
}

export const doornailCharacter = (question, answer, opts) => singleChoiceCharacter("doornail", question, answer, opts);
export const rockCharacter = (question, answer, opts) => singleChoiceCharacter("rock", question, answer, opts);

// One character at the chosen level. `memory: false` leaves out earlier turns; Doornail and Rock never use them.
// `labInstructions` (Doornail and Rock only) replaces their saved instructions.
export const FORGETFUL_LEVELS = ["doornail", "rock"];
// `prompts` are the saved prompt edits (lib/lab.js), keyed as PROMPT_DEFAULTS; missing ones use the default.
export function pickNext(question, answer, history = [], { level = "stump", memory = true, systemOne, labInstructions, prompts } = {}) {
  if (level === "doornail") return doornailCharacter(question, answer, { systemOne, instructions: labInstructions ?? prompts?.doornail });
  if (level === "rock") return rockCharacter(question, answer, { systemOne, instructions: labInstructions ?? prompts?.rock });
  if (level === "post") return postCharacter(question, answer, memory ? history : [], { systemOne, prompts });
  return nextCharacter(question, answer, memory ? history : [], { systemOne, prompts });
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

export async function rateAnswer(question, answer, history = [], { systemOne = defaultSystemOne, prompts } = {}) {
  const previousTurns = normalizeHistory(history);
  const { answers, usage } = await systemOne({
    state: { ...(previousTurns.length ? { previous_turns: previousTurns } : {}), question, answer },
    questions: { rating: score(withDefaults(prompts).rating, RATING_CRITERIA) },
  });
  const value = answers.rating.score; // expected level, 0 (Terrible) to 4 (Perfect)
  const tokens = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
  const label = RATINGS[Math.min(4, Math.max(0, Math.round(value)))];
  return { label, score: value, tokens, cost: costOf(tokens) };
}

// Everything the "How it works" page (public/how.html) shows that lives in code: the limits and
// thresholds each level uses, and the default prompts Jev is given. api/how.js serves it, with the
// lab's saved instructions for Doornail and Rock in place of their defaults.
export function explainer() {
  return {
    levels: LEVELS,
    numbers: {
      MAX_LENGTH,
      MAX_HISTORY,
      DONE_THRESHOLD,
      WORD_DONE_THRESHOLD,
      WORD_CHECK_MAX,
      MAX_WORD,
      SCREEN_THRESHOLD,
      SCREEN_KEEP_MIN,
      SENSE_THRESHOLD,
      REPEAT_THRESHOLD,
      MAX_RUNOFFS: MAX_ROUNDS - 1,
      ROCK_SEMIFINAL,
      ROCK_FINAL,
      ROCK_CONFIDENT,
      PRICE_PER_MTOK,
    },
    prompts: { ...PROMPT_DEFAULTS },
  };
}

// Every prompt step, as editable text (admins edit them on the "How it works" page; saved edits
// live in lib/lab.js). A Choice with rules is written as its task, a blank line, then one rule
// per line starting "- "; fromText turns that back into { task, rules }.
export function toText(instructions) {
  if (typeof instructions === "string") return instructions;
  return `${instructions.task}\n\n${instructions.rules.map((r) => `- ${r}`).join("\n")}`;
}

export function fromText(text) {
  const [task, ...rest] = text.trim().split(/\n\s*\n/);
  const rules = rest.join("\n").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^[-•*]\s*/, ""));
  return rules.length ? { task: task.trim(), rules } : task.trim();
}

export const PROMPT_DEFAULTS = {
  doornail: DOORNAIL_INSTRUCTIONS,
  rock: ROCK_INSTRUCTIONS,
  screen: SCREEN_TASK,
  done: DONE_INSTRUCTIONS,
  word_done: WORD_DONE_INSTRUCTIONS,
  repeat_ok: REPEAT_INSTRUCTIONS,
  sense: SENSE_INSTRUCTIONS,
  rank: toText(NEXT_INSTRUCTIONS),
  kind: toText(KIND_INSTRUCTIONS),
  rating: RATING_INSTRUCTIONS,
};
export const PROMPT_KEYS = Object.keys(PROMPT_DEFAULTS);

function withDefaults(prompts) {
  const out = { ...PROMPT_DEFAULTS };
  for (const key of PROMPT_KEYS) if (typeof prompts?.[key] === "string" && prompts[key].trim()) out[key] = prompts[key];
  return out;
}

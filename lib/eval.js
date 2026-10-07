// Live evaluation against real Jev: a fixed question set with expected keywords.
// Used by `npm run eval` (needs TYPESAFE_API_KEY) to measure prompt changes.
import { END, MAX_LENGTH, nextCharacter } from "./jev.js";

export const CASES = [
  { question: "What is the capital of France?", expect: ["paris"] },
  { question: "What color is the sky?", expect: ["blue"] },
  { question: "What is 2 + 2?", expect: ["4", "four"] },
  { question: "How many legs does a spider have?", expect: ["8", "eight"] },
  { question: "In what year did humans first land on the Moon?", expect: ["1969"] },
  { question: "What is the largest planet in our solar system?", expect: ["jupiter"] },
  { question: "Who wrote Romeo and Juliet?", expect: ["shakespeare"] },
  { question: "At what temperature in Celsius does water boil?", expect: ["100"] },
  { question: "What is the opposite of hot?", expect: ["cold"] },
  { question: "Why is the sky blue?", expect: ["scatter", "rayleigh", "light", "sunlight"] },
  { question: "Say hello.", expect: ["hello", "hi"] },
  {
    question: "What about Germany?",
    history: [{ question: "What is the capital of France?", answer: "Paris" }],
    expect: ["berlin"],
  },
  {
    question: "And what is that times 3?",
    history: [{ question: "What is 2 + 2?", answer: "4" }],
    expect: ["12", "twelve"],
  },
];

export async function runAnswer({ question, history = [] }, { steps: keepSteps = false } = {}) {
  let answer = "";
  const steps = [];
  const started = Date.now();
  let cost = 0;
  while (answer.length < MAX_LENGTH) {
    const r = await nextCharacter(question, answer, history);
    steps.push(keepSteps ? r : r.pick);
    cost += r.cost ?? 0;
    if (r.pick === END) break;
    answer += r.char;
  }
  return { answer: answer.trim(), calls: steps.length, cost, seconds: (Date.now() - started) / 1000, ...(keepSteps ? { steps } : {}) };
}

// Pass = the expected word shows up early (first 6 words) in a short answer (80 chars or less),
// so rambling that eventually stumbles onto the answer doesn't count.
export function score(testCase, answer) {
  if (answer.length > 80) return false;
  const opening = answer.toLowerCase().split(/\s+/).slice(0, 6).join(" ");
  return testCase.expect.some((word) => new RegExp(`\\b${word}`).test(opening));
}

// Each case runs `repeats` times (answers vary run to run); a case's score is its pass rate.
export async function runEval(cases = CASES, { repeats = 1 } = {}) {
  const runs = cases.flatMap((c) => Array.from({ length: repeats }, () => c));
  const outcomes = await Promise.all(
    runs.map(async (c) => {
      try {
        const r = await runAnswer(c);
        return { c, answer: r.answer, pass: score(c, r.answer), calls: r.calls, cost: r.cost };
      } catch (err) {
        return { c, answer: "", pass: false, calls: 0, cost: 0, error: String(err) };
      }
    }),
  );
  const results = cases.map((c) => {
    const mine = outcomes.filter((o) => o.c === c);
    return {
      question: c.question,
      history: c.history?.length ?? 0,
      passes: mine.filter((o) => o.pass).length,
      runs: mine.length,
      pass: mine.every((o) => o.pass),
      answers: mine.map((o) => o.answer),
      answer: mine[0].answer,
      calls: Math.round(mine.reduce((s, o) => s + o.calls, 0) / mine.length),
      cost: mine.reduce((s, o) => s + o.cost, 0),
      error: mine.find((o) => o.error)?.error,
    };
  });
  const passed = outcomes.filter((o) => o.pass).length;
  const cost = outcomes.reduce((s, o) => s + o.cost, 0);
  return { passed, total: outcomes.length, cost, results };
}

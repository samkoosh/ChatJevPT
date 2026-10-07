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
  while (answer.length < MAX_LENGTH) {
    const r = await nextCharacter(question, answer, history);
    steps.push(keepSteps ? r : r.pick);
    if (r.pick === END) break;
    answer += r.char;
  }
  return { answer: answer.trim(), calls: steps.length, seconds: (Date.now() - started) / 1000, ...(keepSteps ? { steps } : {}) };
}

export function score(testCase, answer) {
  const lower = answer.toLowerCase();
  return testCase.expect.some((word) => new RegExp(`\\b${word}`).test(lower));
}

export async function runEval(cases = CASES) {
  const results = await Promise.all(
    cases.map(async (c) => {
      try {
        const r = await runAnswer(c);
        return { question: c.question, history: c.history?.length ?? 0, answer: r.answer, pass: score(c, r.answer), calls: r.calls };
      } catch (err) {
        return { question: c.question, answer: "", pass: false, error: String(err) };
      }
    }),
  );
  const passed = results.filter((r) => r.pass).length;
  return { passed, total: results.length, results };
}

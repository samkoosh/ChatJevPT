import { labelFor } from "../lib/jev.js";

// A fake Jev. `prefer(option, answer)` returns a score per option; the fake turns those into
// probabilities keyed by the real labels and records every request it sees.
export function fakeJev(prefer, { done = 0, wordDone = 1 } = {}) {
  const requests = [];
  const systemOne = async (request) => {
    requests.push(request);
    const answer = request.state.answer_so_far;
    const labels = Object.keys(request.questions.next.criteria);
    const options = labels.map((label) => optionFor(label, answer));
    const scores = options.map((o) => Math.max(0, prefer(o, answer, requests.length)));
    const total = scores.reduce((a, b) => a + b, 0) || 1;
    const probabilities = Object.fromEntries(labels.map((l, i) => [l, scores[i] / total]));
    const answers = { next: { type: "choice", choice: labels[0], confidence: 0, probabilities } };
    if (request.questions.word_done) answers.word_done = { type: "noul", noul: wordDone };
    if (request.questions.done) answers.done = { type: "noul", noul: typeof done === "function" ? done(answer) : done };
    return { model: "fake", answers, usage: { input_tokens: 0, output_tokens: 0 } };
  };
  return { systemOne, requests };
}

const ALL = [
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
  ...Array.from({ length: 10 }, (_, i) => String(i)),
  ".", ",", "!", "?", ":", ";", "'", "-", "SPACE", "NEWLINE", "END",
];
function optionFor(label, answer) {
  const option = ALL.find((o) => labelFor(o, answer) === label);
  if (!option) throw new Error(`Unknown label ${label}`);
  return option;
}

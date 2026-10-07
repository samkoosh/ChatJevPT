import { KINDS, kindLabel, labelFor } from "../lib/jev.js";

// A fake Jev. `prefer(option, answer, choiceCall)` scores each option in the ranking Choice;
// `screen(option, answer)` is each candidate's screening Noul (default: everything passes);
// `sensible` answers the sense check; `kind(kind, answer, kindCall)` scores Post's kind Choice.
// Records every request: all of them in `requests`, and the screening, ranking, sense and kind
// requests separately.
export function fakeJev(prefer, { done = 0, wordDone = 1, repeatOk = 0, screen = () => 1, sensible = 1, kind = () => 1 } = {}) {
  const requests = [];
  const screens = [];
  const choices = [];
  const senses = [];
  const kinds = [];
  const systemOne = async (request) => {
    requests.push(request);
    const q = request.questions;
    if (q.sensible) {
      senses.push(request);
      return { answers: { sensible: { type: "noul", noul: sensible } }, usage: { input_tokens: 0, output_tokens: 0 } };
    }
    const answer = request.state.answer_so_far;
    const answers = {};
    if (q.next) {
      choices.push(request);
      const labels = Object.keys(q.next.criteria);
      const options = labels.map((label) => optionFor(label, answer));
      const scores = options.map((o) => Math.max(0, prefer(o, answer, choices.length)));
      const total = scores.reduce((a, b) => a + b, 0) || 1;
      const probabilities = Object.fromEntries(labels.map((l, i) => [l, scores[i] / total]));
      answers.next = { type: "choice", choice: labels[0], confidence: 0, probabilities };
    } else if (q.kind) {
      kinds.push(request);
      answers.kind = { type: "choice", probabilities: distribution(Object.keys(q.kind.criteria), (l) => kind(KINDS.find((k) => kindLabel(k) === l), answer, kinds.length)) };
    } else {
      screens.push(request);
      for (const [k, question] of Object.entries(q)) {
        if (/^c\d+$/.test(k)) answers[k] = { type: "noul", noul: screen(optionFor(question.instructions.candidate, answer), answer) };
      }
    }
    if (q.repeat_ok) answers.repeat_ok = { type: "noul", noul: repeatOk };
    if (q.word_done) answers.word_done = { type: "noul", noul: wordDone };
    if (q.done) answers.done = { type: "noul", noul: typeof done === "function" ? done(answer) : done };
    return { model: "fake", answers, usage: { input_tokens: 0, output_tokens: 0 } };
  };
  return { systemOne, requests, screens, choices, senses, kinds };
}

function distribution(labels, score) {
  const scores = labels.map((l) => Math.max(0, score(l)));
  const total = scores.reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(labels.map((l, i) => [l, scores[i] / total]));
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

// Stand-in for the TypeSafe API, used by `npm run dev:mock` to try the UI without a key.
const SCRIPT = "Every letter is picked one at a time, so this is a mock answer!";

export async function mockSystemOne({ state, questions }) {
  await new Promise((r) => setTimeout(r, 60 + Math.random() * 90));
  if (questions.rating) {
    const score = 1 + Math.random() * 3;
    return { model: "jev-mock", answers: { rating: { type: "score", score, confidence: 0.5 } }, usage: { input_tokens: 220, output_tokens: 0 } };
  }
  // Labels are the text each option produces; the wanted one ends with the next scripted character.
  const options = Object.keys(questions.next.criteria);
  const answer = state.answer_so_far;
  const next = SCRIPT.slice(0, answer.length + 1);
  const want =
    answer.length >= SCRIPT.length
      ? options.find((o) => o.endsWith("(done)"))
      : options.find((o) => o.toLowerCase().endsWith(`${next.slice(-Math.min(next.length, 20)).toLowerCase()}…"`));

  const probabilities = {};
  let rest = 1;
  for (const o of options) probabilities[o] = 0;
  if (options.includes(want)) {
    probabilities[want] = 0.55 + Math.random() * 0.4;
    rest -= probabilities[want];
  }
  const others = options.filter((o) => o !== want);
  const weights = others.map(() => Math.random() ** 4);
  const total = weights.reduce((a, b) => a + b, 0);
  others.forEach((o, i) => (probabilities[o] = (rest * weights[i]) / total));

  const answers = { next: { type: "choice", choice: want, confidence: probabilities[want] ?? 0, probabilities } };
  if (questions.word_done) answers.word_done = { type: "noul", noul: /[a-z]/i.test(SCRIPT[answer.length] ?? "") ? 0.1 : 0.9 };
  if (questions.done) answers.done = { type: "noul", noul: answer.length >= SCRIPT.length ? 0.9 : 0.05 };
  // Roughly what the real request would cost: about 4 characters per token.
  const input_tokens = Math.round(JSON.stringify({ state, questions }).length / 4);
  return { model: "jev-mock", answers, usage: { input_tokens, output_tokens: 0 } };
}

// Stand-in for the TypeSafe API, used by `npm run dev:mock` to try the UI without a key.
const SCRIPT = "JEV PICKS EVERY LETTER ONE AT A TIME SO THIS IS A MOCK ANSWER";

export async function mockSystemOne({ state, questions }) {
  await new Promise((r) => setTimeout(r, 60 + Math.random() * 90));
  const options = Object.keys(questions.next.criteria);
  const answer = state.answer_so_far;
  const target = answer.length < SCRIPT.length ? SCRIPT[answer.length] : "END";
  const want = target === " " ? "SPACE" : target;

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

  return {
    model: "jev-mock",
    answers: { next: { type: "choice", choice: want, confidence: probabilities[want] ?? 0, probabilities } },
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

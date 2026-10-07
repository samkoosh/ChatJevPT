// Stand-in for the TypeSafe API, used by `npm run dev:mock` to try the UI without a key.
const SCRIPT = "Every letter is picked one at a time, so this is a mock answer!";

// The label (the text an option produces) that continues SCRIPT, or the "(done)" label at the end.
function wanted(labels, answer) {
  if (answer.length >= SCRIPT.length) return labels.find((l) => l.endsWith("(done)"));
  const next = SCRIPT.slice(0, answer.length + 1).slice(-20).toLowerCase();
  return labels.find((l) => l.toLowerCase().endsWith(`${next}…"`));
}

const usage = (request) => ({ input_tokens: Math.round(JSON.stringify(request).length / 4), output_tokens: 0 });

export async function mockSystemOne(request) {
  const { state, questions } = request;
  await new Promise((r) => setTimeout(r, 40 + Math.random() * 60));
  if (questions.rating) {
    const score = 1 + Math.random() * 3;
    return { model: "jev-mock", answers: { rating: { type: "score", score, confidence: 0.5 } }, usage: usage(request) };
  }
  if (questions.sensible) {
    return { model: "jev-mock", answers: { sensible: { type: "noul", noul: 0.9 } }, usage: usage(request) };
  }
  const answer = state.answer_so_far;
  const answers = {};

  if (questions.next) {
    const labels = Object.keys(questions.next.criteria);
    const want = wanted(labels, answer);
    const probabilities = {};
    let rest = 1;
    for (const l of labels) probabilities[l] = 0;
    if (want) {
      probabilities[want] = 0.55 + Math.random() * 0.4;
      rest -= probabilities[want];
    }
    const others = labels.filter((l) => l !== want);
    const weights = others.map(() => Math.random() ** 4);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    others.forEach((l, i) => (probabilities[l] = (rest * weights[i]) / total));
    answers.next = { type: "choice", choice: want, confidence: probabilities[want] ?? 0, probabilities };
  } else {
    // Screening round: one Noul per candidate; the scripted one passes, a few random others too.
    const keys = Object.keys(questions).filter((k) => /^c\d+$/.test(k));
    const want = wanted(keys.map((k) => questions[k].instructions.candidate), answer);
    for (const k of keys) {
      const p = questions[k].instructions.candidate === want ? 0.9 : Math.random() * 0.4;
      answers[k] = { type: "noul", noul: p };
    }
  }
  if (questions.word_done) answers.word_done = { type: "noul", noul: /[a-z]/i.test(SCRIPT[answer.length] ?? "") ? 0.1 : 0.9 };
  if (questions.done) answers.done = { type: "noul", noul: answer.length >= SCRIPT.length ? 0.9 : 0.05 };
  if (questions.repeat_ok) answers.repeat_ok = { type: "noul", noul: 0.1 };
  return { model: "jev-mock", answers, usage: usage(request) };
}

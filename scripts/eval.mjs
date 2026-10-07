// Content suite: runs the question set against real Jev, headless, and prints a scorecard.
// Usage: npm run test:content [-- repeats]   (reads TYPESAFE_API_KEY from .env)
import { runEval } from "../lib/eval.js";

const repeats = Number(process.argv[2]) || 3;
const { passed, total, cost, results } = await runEval(undefined, { repeats });
for (const r of results) {
  console.log(`${r.passes}/${r.runs}  ${r.question}${r.history ? " (follow-up)" : ""}${r.error ? `  ${r.error}` : ""}`);
  r.answers.forEach((a, i) => console.log(`        [${r.ratings[i]}] ${JSON.stringify(a.replace(/\n/g, " / "))}`));
}
console.log(`\n${passed}/${total} runs passed · $${cost.toFixed(4)}`);

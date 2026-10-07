// Runs the live eval set against real Jev and prints a scorecard.
// Usage: npm run eval   (reads TYPESAFE_API_KEY from .env)
import { runEval } from "../lib/eval.js";

const { passed, total, cost, results } = await runEval();
for (const r of results) {
  const answer = JSON.stringify(r.answer.replace(/\n/g, " / "));
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.question}${r.history ? " (follow-up)" : ""}\n      ${answer}  [${r.calls} calls]${r.error ? `  ${r.error}` : ""}`);
}
console.log(`\n${passed}/${total} passed · $${cost.toFixed(4)} total`);

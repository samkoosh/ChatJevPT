// TEMPORARY (preview only): runs the live eval set against real Jev. Removed before merging.
import { runEval } from "../lib/eval.js";

export async function GET() {
  if (process.env.VERCEL_ENV !== "preview") return new Response("Not found", { status: 404 });
  const { passed, total, results } = await runEval();
  return Response.json({ passed, total, results: results.map((r) => `${r.pass ? "PASS" : "FAIL"} | ${r.question}${r.history ? " (follow-up)" : ""} | ${JSON.stringify(r.answer)} | ${r.calls ?? 0} calls${r.error ? ` | ${r.error}` : ""}`) });
}

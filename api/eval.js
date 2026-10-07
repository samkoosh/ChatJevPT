// TEMPORARY (preview only): runs the content suite against real Jev. Removed before merging.
import { runEval } from "../lib/eval.js";

export async function GET(request) {
  if (process.env.VERCEL_ENV !== "preview") return new Response("Not found", { status: 404 });
  const repeats = Number(new URL(request.url).searchParams.get("repeats")) || 3;
  const started = Date.now();
  const { passed, total, cost, results } = await runEval(undefined, { repeats });
  return Response.json({
    passed,
    total,
    cost,
    wallSeconds: (Date.now() - started) / 1000,
    results: results.map((r) => `${r.passes}/${r.runs} | ${r.question}${r.history ? " (follow-up)" : ""} | ${r.answers.map((a, i) => `[${r.ratings[i]}] ${JSON.stringify(a)}`).join(" ; ")}${r.error ? ` | ${r.error}` : ""}`),
  });
}

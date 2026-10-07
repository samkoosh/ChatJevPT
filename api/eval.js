// TEMPORARY: runs whole answers server-side so prompts can be tuned against real Jev.
// Preview deployments only; removed before merging.
import { END, MAX_LENGTH, nextCharacter } from "../lib/jev.js";

export async function GET(request) {
  if (process.env.VERCEL_ENV !== "preview") return new Response("Not found", { status: 404 });
  const question = new URL(request.url).searchParams.get("q") || "What is the capital of France?";
  let answer = "";
  const steps = [];
  const started = Date.now();
  try {
    while (answer.length < MAX_LENGTH && Date.now() - started < 240_000) {
      const r = await nextCharacter(question, answer);
      steps.push({ pick: r.pick, done: r.done && +r.done.toFixed(3), tied: r.tied, top: r.top.map((t) => `${t.option}:${t.p.toFixed(3)}`).join(" ") });
      if (r.pick === END) break;
      answer += r.char;
    }
  } catch (err) {
    return Response.json({ question, answer, error: String(err), status: err?.status, body: err?.body, steps });
  }
  return Response.json({ question, answer, calls: steps.length, seconds: (Date.now() - started) / 1000, steps });
}

// TEMPORARY (preview only): runs Rock against real Jev. Removed before merging.
import { rockCharacter, END, MAX_LENGTH } from "../lib/jev.js";

export async function GET() {
  if (process.env.VERCEL_ENV !== "preview") return new Response("Not found", { status: 404 });
  const out = [];
  for (const question of ["What is the capital of France?", "What color is the sky?"]) {
    let answer = "";
    let cost = 0;
    try {
      while (answer.length < 40) {
        const r = await rockCharacter(question, answer);
        cost += r.cost;
        if (r.pick === END) break;
        answer += r.char;
      }
      out.push({ question, answer, cost });
    } catch (err) {
      out.push({ question, error: String(err), status: err?.status, body: err?.body });
    }
  }
  return Response.json(out);
}

// TEMPORARY (preview only): runs Rock against real Jev. Removed before merging.
import { rockCharacter, END } from "../lib/jev.js";

export async function GET() {
  if (process.env.VERCEL_ENV !== "preview") return new Response("Not found", { status: 404 });
  const out = [];
  for (const question of ["What is the capital of France?", "What color is the sky?", "Say hi to Bob"]) {
    let answer = "";
    const picks = [];
    try {
      while (answer.length < 40) {
        const r = await rockCharacter(question, answer);
        picks.push(`${r.pick}:${r.top.slice(0, 3).map((t) => `${t.option}=${t.p.toFixed(2)}`).join(",")}`);
        if (r.pick === END) break;
        answer += r.char;
      }
      out.push({ question, answer, picks: picks.slice(0, 12) });
    } catch (err) {
      out.push({ question, error: String(err), status: err?.status, body: err?.body });
    }
  }
  return Response.json(out);
}

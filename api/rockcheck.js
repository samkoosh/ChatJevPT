// TEMPORARY (preview only): runs Rock against real Jev. Removed before merging.
import { rockCharacter, END } from "../lib/jev.js";

export async function GET() {
  if (process.env.VERCEL_ENV !== "preview") return new Response("Not found", { status: 404 });
  const questions = ["What is the capital of France?", "What color is the sky?", "Say hi to Bob", "What is 2 + 2?"];
  const out = await Promise.all(
    questions.flatMap((q) => [q, q]).map(async (question) => {
      let answer = "";
      while (answer.length < 30) {
        const r = await rockCharacter(question, answer);
        if (r.pick === END) return `${question} -> ${JSON.stringify(answer)} (stopped)`;
        answer += r.char;
      }
      return `${question} -> ${JSON.stringify(answer)} (hit 30)`;
    }),
  );
  return Response.json(out);
}

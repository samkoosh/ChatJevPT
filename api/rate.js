import { ANSWER_PATTERN, MAX_LENGTH, rateAnswer } from "../lib/jev.js";
import { jevErrorResponse, missingKeyResponse } from "../lib/errors.js";

// POST { question, answer, history } -> { label, score, tokens, cost }
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  const answer = typeof body?.answer === "string" ? body.answer.trim() : "";
  if (!question || question.length > 2000) return Response.json({ error: "Invalid question." }, { status: 400 });
  if (!answer || answer.length > MAX_LENGTH || !ANSWER_PATTERN.test(answer)) {
    return Response.json({ error: "Invalid answer." }, { status: 400 });
  }
  const noKey = missingKeyResponse();
  if (noKey) return noKey;

  try {
    return Response.json(await rateAnswer(question, answer, body.history));
  } catch (err) {
    return jevErrorResponse(err);
  }
}

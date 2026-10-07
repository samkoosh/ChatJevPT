import { ANSWER_PATTERN, MAX_LENGTH, nextCharacter } from "../lib/jev.js";
import { jevErrorResponse, missingKeyResponse } from "../lib/errors.js";

export { isOutOfCredits } from "../lib/errors.js";

const MAX_QUESTION = 2000;

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const question = typeof body?.question === "string" ? body.question.trim() : "";
  const answer = typeof body?.answer === "string" ? body.answer : null;
  if (!question || question.length > MAX_QUESTION) {
    return Response.json({ error: `Question must be 1–${MAX_QUESTION} characters.` }, { status: 400 });
  }
  if (answer === null || answer.length >= MAX_LENGTH || !ANSWER_PATTERN.test(answer)) {
    return Response.json({ error: "Invalid answer so far." }, { status: 400 });
  }
  const noKey = missingKeyResponse();
  if (noKey) return noKey;

  try {
    return Response.json(await nextCharacter(question, answer, body.history));
  } catch (err) {
    return jevErrorResponse(err);
  }
}

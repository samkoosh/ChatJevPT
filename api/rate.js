import { ANSWER_PATTERN, MAX_LENGTH, rateAnswer } from "../lib/jev.js";
import { jevErrorResponse, missingKeyResponse } from "../lib/errors.js";
import { authenticate, budgetResponse, charge } from "../lib/auth.js";
import { chatHistory } from "../lib/chats.js";

// POST { question, answer, history } -> { label, score, tokens, cost }. Signed in: { question, answer, chatId }.
export async function POST(request) {
  const auth = await authenticate(request);
  if (auth.response) return auth.response;

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

  let history = body.history;
  if (auth.user) {
    const overBudget = budgetResponse(auth.user);
    if (overBudget) return overBudget;
    const chat = await chatHistory(auth.user, body.chatId, { question, answer });
    if (chat.response) return chat.response;
    history = chat.history;
  }

  let result;
  try {
    result = await rateAnswer(question, answer, history);
  } catch (err) {
    return jevErrorResponse(err);
  }
  if (auth.user) await charge(auth.user, result).catch((err) => console.error("charge failed", err));
  return Response.json(result);
}

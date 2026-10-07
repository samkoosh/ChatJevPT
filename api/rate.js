import { ANSWER_PATTERN, MAX_LENGTH, rateAnswer } from "../lib/jev.js";
import { jevErrorResponse, missingKeyResponse } from "../lib/errors.js";
import { authenticate, budgetResponse, charge } from "../lib/auth.js";
import { chatHistory } from "../lib/chats.js";

// POST { question, answer, history, memory? } -> { label, score, tokens, cost }.
// With accounts on: { question, answer, chatId }, and the history comes from the saved chat.
export function POST(request) {
  return handle(request);
}

// `systemOne` swaps Jev out in tests.
export async function handle(request, { systemOne } = {}) {
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

  // With memory off, the answer is graded on the question alone, as it was written.
  const memory = body.memory !== false;
  let history = memory ? body.history : [];
  if (auth.user) {
    const overBudget = budgetResponse(auth.user);
    if (overBudget) return overBudget;
    const chat = await chatHistory(auth.user, body.chatId, { question, answer });
    if (chat.response) return chat.response;
    history = memory ? chat.history : [];
  }

  let result;
  try {
    result = await rateAnswer(question, answer, history, { systemOne });
  } catch (err) {
    return jevErrorResponse(err);
  }
  if (auth.user) await charge(auth.user, result);
  return Response.json(result);
}

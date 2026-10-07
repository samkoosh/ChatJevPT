import { ANSWER_PATTERN, MAX_LENGTH, nextCharacter } from "../lib/jev.js";
import { jevErrorResponse, missingKeyResponse } from "../lib/errors.js";
import { authenticate, budgetResponse, charge } from "../lib/auth.js";
import { chatHistory } from "../lib/chats.js";

export { isOutOfCredits } from "../lib/errors.js";

const MAX_QUESTION = 2000;

// POST { question, answer, history } -> one character. With accounts on: { question, answer, chatId },
// and the history comes from the saved chat, never the client.
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
  const answer = typeof body?.answer === "string" ? body.answer : null;
  if (!question || question.length > MAX_QUESTION) {
    return Response.json({ error: `Question must be 1–${MAX_QUESTION} characters.` }, { status: 400 });
  }
  if (answer === null || answer.length >= MAX_LENGTH || !ANSWER_PATTERN.test(answer)) {
    return Response.json({ error: "Invalid answer so far." }, { status: 400 });
  }
  const noKey = missingKeyResponse();
  if (noKey) return noKey;

  let history = body.history;
  if (auth.user) {
    const overBudget = budgetResponse(auth.user);
    if (overBudget) return overBudget;
    const chat = await chatHistory(auth.user, body.chatId);
    if (chat.response) return chat.response;
    history = chat.history;
  }

  let result;
  try {
    result = await nextCharacter(question, answer, history, { systemOne });
  } catch (err) {
    return jevErrorResponse(err);
  }
  if (auth.user) await charge(auth.user, result);
  return Response.json(result);
}

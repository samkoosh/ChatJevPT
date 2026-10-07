import { ANSWER_PATTERN, LEVELS, MAX_LENGTH, PLAYABLE_LEVELS, pickNext } from "../lib/jev.js";
import { jevErrorResponse, missingKeyResponse } from "../lib/errors.js";
import { authenticate, budgetResponse, charge, isAdmin } from "../lib/auth.js";
import { chatHistory } from "../lib/chats.js";
import { cleanInstructions, rockInstructions } from "../lib/rock.js";

export { isOutOfCredits } from "../lib/errors.js";

const MAX_QUESTION = 2000;

// POST { question, answer, history, level?, memory? } -> one character. With accounts on: { question, answer, chatId },
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
  const level = body.level ?? "stump";
  if (!LEVELS.includes(level)) return Response.json({ error: "Unknown model level." }, { status: 400 });
  if (!PLAYABLE_LEVELS.includes(level)) {
    return Response.json({ error: "Post is still in development.", code: "level_locked" }, { status: 400 });
  }
  const memory = body.memory !== false && level !== "rock";
  const noKey = missingKeyResponse();
  if (noKey) return noKey;

  let history = memory ? body.history : [];
  if (auth.user) {
    const overBudget = budgetResponse(auth.user);
    if (overBudget) return overBudget;
    const chat = await chatHistory(auth.user, body.chatId);
    if (chat.response) return chat.response;
    history = memory ? chat.history : [];
  }

  let result;
  try {
    // Admins can try draft Rock instructions on their own answers (the in-chat Rock lab).
    let rock;
    if (level === "rock") {
      const draft = auth.user && isAdmin(auth.user) && body.rockInstructions != null ? cleanInstructions(body.rockInstructions) : null;
      if (draft?.error) return Response.json({ error: draft.error }, { status: 400 });
      rock = draft?.value ?? (await rockInstructions());
    }
    result = await pickNext(question, answer, history, { level, memory, systemOne, rockInstructions: rock });
  } catch (err) {
    return jevErrorResponse(err);
  }
  if (auth.user) await charge(auth.user, result);
  return Response.json(result);
}

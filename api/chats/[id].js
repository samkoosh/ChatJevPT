import { authDisabledResponse, authenticate, badRequest, fail, json, notFound, readJson } from "../../lib/auth.js";
import { cleanRating, cleanTurn, loadChat, MAX_TURNS, titleFrom } from "../../lib/chats.js";
import { getStore } from "../../lib/store.js";

// /api/chats/:id. Someone else's chat is indistinguishable from a missing one (404).
function chatId(request) {
  const url = new URL(request.url);
  return (url.searchParams.get("id") ?? decodeURIComponent(url.pathname.split("/").pop())).toLowerCase();
}

async function gate(request) {
  const auth = await authenticate(request);
  if (auth.off) return { response: authDisabledResponse() };
  if (auth.response) return auth;
  const chat = await loadChat(auth.user, chatId(request));
  return chat ? { user: auth.user, chat } : { response: notFound("Chat not found.") };
}

// GET -> { chat: { id, title, turns, createdAt, updatedAt } }
export async function GET(request) {
  const { response, chat } = await gate(request);
  return response ?? json({ chat });
}

// PUT one of:
//   { turn: { question, answer, label?, score?, tokens?, cost? } }  appends a finished turn
//   { lastTurnRating: { label, score, index? } }                     rates a turn (default: the last)
//   { title }                                                        renames
// -> { chat: { id, title, turnCount, updatedAt } }
export async function PUT(request) {
  const { response, user, chat } = await gate(request);
  if (response) return response;
  const body = await readJson(request);
  const store = getStore();

  if (body?.turn !== undefined) {
    const turn = cleanTurn(body.turn);
    if (!turn) return badRequest("Invalid turn.");
    if (chat.turns.length >= MAX_TURNS) return fail(409, "chat_full", `A chat holds up to ${MAX_TURNS} questions. Start a new one.`);
    const saved = await store.appendTurn(user.email, chat.id, turn, titleFrom(turn.question), MAX_TURNS);
    return saved ? json({ chat: saved }) : fail(409, "chat_full", `A chat holds up to ${MAX_TURNS} questions. Start a new one.`);
  }
  if (body?.lastTurnRating !== undefined) {
    const rating = cleanRating(body.lastTurnRating);
    const index = body.lastTurnRating?.index ?? chat.turns.length - 1;
    if (!rating || !Number.isInteger(index) || index < 0 || index >= chat.turns.length) return badRequest("Invalid rating.");
    return json({ chat: await store.patchTurn(user.email, chat.id, index, rating) });
  }
  if (typeof body?.title === "string" && titleFrom(body.title)) {
    return json({ chat: await store.renameChat(user.email, chat.id, titleFrom(body.title)) });
  }
  return badRequest("Send a turn, lastTurnRating or title.");
}

export async function DELETE(request) {
  const { response, user, chat } = await gate(request);
  if (response) return response;
  await getStore().deleteChat(user.email, chat.id);
  return json({ ok: true });
}

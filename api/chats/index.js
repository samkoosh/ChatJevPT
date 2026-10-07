import { authDisabledResponse, authenticate, fail, json, MAX_CHATS, readJson } from "../../lib/auth.js";
import { titleFrom } from "../../lib/chats.js";
import { getStore } from "../../lib/store.js";

// GET -> { chats: [{ id, title, turnCount, updatedAt }] }, newest first.
export async function GET(request) {
  const auth = await authenticate(request);
  if (auth.off) return authDisabledResponse();
  if (auth.response) return auth.response;
  return json({ chats: await getStore().listChats(auth.user.email), max: MAX_CHATS });
}

// POST { title? } -> { chat }. Each person keeps up to MAX_CHATS.
export async function POST(request) {
  const auth = await authenticate(request);
  if (auth.off) return authDisabledResponse();
  if (auth.response) return auth.response;
  const body = (await readJson(request)) ?? {};
  const chat = await getStore().createChat(auth.user.email, titleFrom(body.title), MAX_CHATS);
  if (!chat) return fail(409, "chat_limit", `You can keep up to ${MAX_CHATS} chats. Delete one to start another.`);
  return json({ chat }, 201);
}

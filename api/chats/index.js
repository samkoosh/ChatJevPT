import { authDisabledResponse, authenticate, chatLimit, fail, json, readJson } from "../../lib/auth.js";
import { titleFrom } from "../../lib/chats.js";
import { getStore } from "../../lib/store.js";

// GET -> { chats: [{ id, title, turnCount, updatedAt }], max } newest first; max is null for admins.
export async function GET(request) {
  const auth = await authenticate(request);
  if (auth.off) return authDisabledResponse();
  if (auth.response) return auth.response;
  return json({ chats: await getStore().listChats(auth.user.email), max: chatLimit(auth.user) });
}

// POST { title? } -> { chat }. Each person keeps up to MAX_CHATS; admins have no limit.
export async function POST(request) {
  const auth = await authenticate(request);
  if (auth.off) return authDisabledResponse();
  if (auth.response) return auth.response;
  const body = (await readJson(request)) ?? {};
  const max = chatLimit(auth.user);
  const chat = await getStore().createChat(auth.user.email, titleFrom(body.title), max ?? Number.MAX_SAFE_INTEGER);
  if (!chat) return fail(409, "chat_limit", `You can keep up to ${max} chats. Delete one to start another.`);
  return json({ chat }, 201);
}

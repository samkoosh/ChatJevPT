// Saved chats: validation and server-side history for signed-in people.
import { ANSWER_PATTERN, MAX_HISTORY, MAX_LENGTH, RATINGS } from "./jev.js";
import { notFound } from "./auth.js";
import { getStore } from "./store.js";

export const MAX_TURNS = 50;
export const MAX_TITLE = 60;
const MAX_QUESTION = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isChatId = (id) => typeof id === "string" && UUID.test(id);
export const titleFrom = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);

export function loadChat(user, id) {
  return isChatId(id) ? getStore().getChat(user.email, id.toLowerCase()) : null;
}

// History for a Jev call comes from the stored chat, never the client. When rating, the turn
// being rated may already be saved, so it and anything after it are left out.
export async function chatHistory(user, chatId, rating) {
  if (chatId == null) return { history: [] };
  const chat = await loadChat(user, chatId);
  if (!chat) return { response: notFound("Chat not found.") };
  let turns = chat.turns;
  if (rating) {
    const i = turns.findLastIndex((t) => t.question === rating.question && t.answer === rating.answer);
    if (i >= 0) turns = turns.slice(0, i);
  }
  return { history: turns.slice(-MAX_HISTORY).map(({ question, answer }) => ({ question, answer })) };
}

const finite = (n, min, max) => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;

// Optional tokens and cost (dollars) of a turn: {} when absent, null if malformed.
function usageFields(t) {
  const out = {};
  if (t.tokens !== undefined) {
    if (!finite(t.tokens, 0, 1e9)) return null;
    out.tokens = Math.round(t.tokens);
  }
  if (t.cost !== undefined) {
    if (!finite(t.cost, 0, 1000)) return null;
    out.cost = t.cost;
  }
  return out;
}

// A rating for a saved turn ({ label, score, tokens?, cost? }), or null if malformed.
export function cleanRating(r) {
  if (!r || !RATINGS.includes(r.label) || !finite(r.score, 0, 4)) return null;
  const usage = usageFields(r);
  return usage && { label: r.label, score: r.score, ...usage };
}

// A finished turn as the client sends it, or null if malformed. Long strings are capped.
export function cleanTurn(t) {
  if (!t || typeof t.question !== "string" || typeof t.answer !== "string") return null;
  const question = t.question.trim().slice(0, MAX_QUESTION);
  const answer = t.answer.trim().slice(0, MAX_LENGTH);
  if (!question || !answer || !ANSWER_PATTERN.test(answer)) return null;
  const usage = usageFields(t);
  if (!usage) return null;
  const turn = { question, answer, ...usage };
  if (t.label !== undefined || t.score !== undefined) {
    const rating = cleanRating(t);
    if (!rating) return null;
    Object.assign(turn, rating);
  }
  return turn;
}

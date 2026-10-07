// Rock's instructions, editable from the admin page's Rock lab. Saved in the settings table; with
// accounts off there's no database, so Rock uses the default.
import { authMode } from "./auth.js";
import { getStore } from "./store.js";
import { MAX_ROCK_INSTRUCTIONS, ROCK_INSTRUCTIONS } from "./jev.js";

const KEY = "rock_instructions";
const CACHE_MS = 15_000; // edits reach every server instance within this long
let cached = null; // { value, at }

export async function rockInstructions() {
  if (authMode().mode !== "on") return ROCK_INSTRUCTIONS;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  let value = ROCK_INSTRUCTIONS;
  try {
    value = (await getStore().getSetting(KEY)) || ROCK_INSTRUCTIONS;
  } catch (err) {
    console.error("Couldn't load Rock instructions; using the default", err);
  }
  cached = { value, at: Date.now() };
  return value;
}

// null (or the default text) goes back to the default.
export async function saveRockInstructions(text) {
  const value = text == null || text === ROCK_INSTRUCTIONS ? null : text;
  await getStore().setSetting(KEY, value);
  cached = { value: value ?? ROCK_INSTRUCTIONS, at: Date.now() };
  return cached.value;
}

export const forgetRockCache = () => (cached = null);

// { value } (null = the default) or { error } for instructions sent by an admin.
export function cleanInstructions(value) {
  if (value === null) return { value: null };
  if (typeof value !== "string" || !value.trim()) return { error: "Instructions can't be empty (use Reset for the default)." };
  if (value.length > MAX_ROCK_INSTRUCTIONS) return { error: `Instructions must be ${MAX_ROCK_INSTRUCTIONS} characters or fewer.` };
  return { value };
}

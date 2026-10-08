// Doornail's and Rock's instructions, editable from the in-chat lab. Saved in the settings table;
// with accounts off there's no database, so both use their defaults.
import { authMode } from "./auth.js";
import { getStore } from "./store.js";
import { LAB_DEFAULTS, MAX_LAB_INSTRUCTIONS } from "./jev.js";

// "rock_instructions" was named before Rock became Doornail; kept so saved instructions survive.
const KEYS = { doornail: "rock_instructions", rock: "rock_level_instructions" };
const CACHE_MS = 15_000; // edits reach every server instance within this long
let cached = {}; // level -> { value, at }

export async function labInstructions(level) {
  const fallback = LAB_DEFAULTS[level];
  if (authMode().mode !== "on") return fallback;
  const hit = cached[level];
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value = fallback;
  try {
    value = (await getStore().getSetting(KEYS[level])) || fallback;
  } catch (err) {
    console.error(`Couldn't load ${level} instructions; using the default`, err);
  }
  cached[level] = { value, at: Date.now() };
  return value;
}

// null (or the default text) goes back to the default.
export async function saveLabInstructions(level, text) {
  const fallback = LAB_DEFAULTS[level];
  const value = text == null || text === fallback ? null : text;
  await getStore().setSetting(KEYS[level], value);
  cached[level] = { value: value ?? fallback, at: Date.now() };
  return cached[level].value;
}

export const forgetLabCache = () => (cached = {});

// { value } (null = the default) or { error } for instructions sent by an admin.
export function cleanInstructions(value) {
  if (value === null) return { value: null };
  if (typeof value !== "string" || !value.trim()) return { error: "Instructions can't be empty (use Reset for the default)." };
  if (value.length > MAX_LAB_INSTRUCTIONS) return { error: `Instructions must be ${MAX_LAB_INSTRUCTIONS} characters or fewer.` };
  return { value };
}

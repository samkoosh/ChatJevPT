// Doornail's instructions, editable from the admin page's Doornail lab. Saved in the settings table; with
// accounts off there's no database, so Doornail uses the default.
import { authMode } from "./auth.js";
import { getStore } from "./store.js";
import { MAX_DOORNAIL_INSTRUCTIONS, DOORNAIL_INSTRUCTIONS } from "./jev.js";

const KEY = "rock_instructions"; // named before Rock became Doornail; kept so saved instructions survive
const CACHE_MS = 15_000; // edits reach every server instance within this long
let cached = null; // { value, at }

export async function doornailInstructions() {
  if (authMode().mode !== "on") return DOORNAIL_INSTRUCTIONS;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  let value = DOORNAIL_INSTRUCTIONS;
  try {
    value = (await getStore().getSetting(KEY)) || DOORNAIL_INSTRUCTIONS;
  } catch (err) {
    console.error("Couldn't load Doornail instructions; using the default", err);
  }
  cached = { value, at: Date.now() };
  return value;
}

// null (or the default text) goes back to the default.
export async function saveDoornailInstructions(text) {
  const value = text == null || text === DOORNAIL_INSTRUCTIONS ? null : text;
  await getStore().setSetting(KEY, value);
  cached = { value: value ?? DOORNAIL_INSTRUCTIONS, at: Date.now() };
  return cached.value;
}

export const forgetDoornailCache = () => (cached = null);

// { value } (null = the default) or { error } for instructions sent by an admin.
export function cleanInstructions(value) {
  if (value === null) return { value: null };
  if (typeof value !== "string" || !value.trim()) return { error: "Instructions can't be empty (use Reset for the default)." };
  if (value.length > MAX_DOORNAIL_INSTRUCTIONS) return { error: `Instructions must be ${MAX_DOORNAIL_INSTRUCTIONS} characters or fewer.` };
  return { value };
}

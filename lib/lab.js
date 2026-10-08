// Saved prompt edits: every prompt step Jev is given (PROMPT_DEFAULTS in lib/jev.js), editable by
// admins on the "How it works" page; Doornail's and Rock's are also edited in the in-chat lab.
// Saved in the settings table; with accounts off there's no database, so the defaults apply.
import { authMode } from "./auth.js";
import { getStore } from "./store.js";
import { MAX_LAB_INSTRUCTIONS, PROMPT_DEFAULTS, PROMPT_KEYS } from "./jev.js";

// "rock_instructions" was named before Rock became Doornail; kept so saved instructions survive.
const LEGACY_KEYS = { doornail: "rock_instructions", rock: "rock_level_instructions" };
const settingKey = (key) => LEGACY_KEYS[key] ?? `prompt_${key}`;
const CACHE_MS = 15_000; // edits reach every server instance within this long
let cached = null; // { prompts, at }

// Every prompt, saved edits in place of the defaults.
export async function savedPrompts() {
  if (authMode().mode !== "on") return { ...PROMPT_DEFAULTS };
  if (cached && Date.now() - cached.at < CACHE_MS) return { ...cached.prompts };
  const prompts = { ...PROMPT_DEFAULTS };
  try {
    const store = getStore();
    const values = await Promise.all(PROMPT_KEYS.map((key) => store.getSetting(settingKey(key))));
    PROMPT_KEYS.forEach((key, i) => values[i] && (prompts[key] = values[i]));
  } catch (err) {
    console.error("Couldn't load saved prompts; using the defaults", err);
  }
  cached = { prompts, at: Date.now() };
  return { ...prompts };
}

export const isPromptKey = (key) => PROMPT_KEYS.includes(key);

// null (or the default text) goes back to the default. Returns the prompt now in use.
export async function savePrompt(key, text) {
  const fallback = PROMPT_DEFAULTS[key];
  const value = text == null || text.trim() === fallback.trim() ? null : text;
  await getStore().setSetting(settingKey(key), value);
  const prompts = await savedPrompts();
  prompts[key] = value ?? fallback;
  cached = { prompts, at: Date.now() };
  return prompts[key];
}

export const labInstructions = async (level) => (await savedPrompts())[level];
export const saveLabInstructions = savePrompt;
export const forgetLabCache = () => (cached = null);

// { value } (null = the default) or { error } for instructions sent by an admin.
export function cleanInstructions(value) {
  if (value === null) return { value: null };
  if (typeof value !== "string" || !value.trim()) return { error: "Instructions can't be empty (use Reset for the default)." };
  if (value.length > MAX_LAB_INSTRUCTIONS) return { error: `Instructions must be ${MAX_LAB_INSTRUCTIONS} characters or fewer.` };
  return { value };
}

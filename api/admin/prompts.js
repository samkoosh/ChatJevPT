import { authDisabledResponse, authenticate, badRequest, json, readJson } from "../../lib/auth.js";
import { PROMPT_DEFAULTS } from "../../lib/jev.js";
import { cleanInstructions, isPromptKey, savePrompt, savedPrompts } from "../../lib/lab.js";

// Admins edit every prompt step from the "How it works" page.
async function gate(request) {
  const auth = await authenticate(request, { admin: true });
  if (auth.off) return { response: authDisabledResponse() };
  return auth;
}

const shape = (key, text) => ({ key, text, default: PROMPT_DEFAULTS[key], isDefault: text === PROMPT_DEFAULTS[key] });

// GET -> { prompts: { key: { key, text, default, isDefault } } }
export async function GET(request) {
  const { response } = await gate(request);
  if (response) return response;
  const saved = await savedPrompts();
  return json({ prompts: Object.fromEntries(Object.keys(PROMPT_DEFAULTS).map((k) => [k, shape(k, saved[k])])) });
}

// PUT { key, text } saves that prompt for everyone; { key, text: null } resets it to the default.
export async function PUT(request) {
  const { response } = await gate(request);
  if (response) return response;
  const body = await readJson(request);
  if (!isPromptKey(body?.key)) return badRequest("Unknown prompt.");
  const { value, error } = cleanInstructions(body?.text);
  if (error) return badRequest(error);
  return json(shape(body.key, await savePrompt(body.key, value)));
}

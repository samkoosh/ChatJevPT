import { authDisabledResponse, authenticate, badRequest, json, readJson } from "../../lib/auth.js";
import { LAB_DEFAULTS, LAB_EXAMPLE, LAB_LEVELS, labRequest } from "../../lib/jev.js";
import { cleanInstructions, labInstructions, saveLabInstructions } from "../../lib/lab.js";

async function gate(request) {
  const auth = await authenticate(request, { admin: true });
  if (auth.off) return { response: authDisabledResponse() };
  return auth;
}

const levelOf = (value) => (LAB_LEVELS.includes(value) ? value : null);

// `request` is the whole request (state and questions) for the made-up example in `example`, with
// the saved instructions; the lab swaps in a draft.
const shape = (level, instructions) => ({
  level,
  instructions,
  default: LAB_DEFAULTS[level],
  isDefault: instructions === LAB_DEFAULTS[level],
  example: LAB_EXAMPLE,
  request: labRequest(level, instructions),
});

// GET ?level=doornail|rock -> { level, instructions, default, isDefault, example, request }
export async function GET(request) {
  const { response } = await gate(request);
  if (response) return response;
  const level = levelOf(new URL(request.url).searchParams.get("level") ?? "doornail");
  if (!level) return badRequest("Unknown lab level.");
  return json(shape(level, await labInstructions(level)));
}

// PUT { level, instructions } saves them for everyone's answers at that level; { instructions: null } resets.
export async function PUT(request) {
  const { response } = await gate(request);
  if (response) return response;
  const body = await readJson(request);
  const level = levelOf(body?.level ?? "doornail");
  if (!level) return badRequest("Unknown lab level.");
  const { value, error } = cleanInstructions(body?.instructions);
  if (error) return badRequest(error);
  return json(shape(level, await saveLabInstructions(level, value)));
}

import { authDisabledResponse, authenticate, badRequest, json, readJson } from "../../lib/auth.js";
import { DOORNAIL_INSTRUCTIONS, doornailQuestions } from "../../lib/jev.js";
import { cleanInstructions, doornailInstructions, saveDoornailInstructions } from "../../lib/doornail.js";

async function gate(request) {
  const auth = await authenticate(request, { admin: true });
  if (auth.off) return { response: authDisabledResponse() };
  return auth;
}

// `questions` is the request's questions part with the saved instructions; the lab swaps in a draft.
const shape = (instructions) => ({
  instructions,
  default: DOORNAIL_INSTRUCTIONS,
  isDefault: instructions === DOORNAIL_INSTRUCTIONS,
  questions: doornailQuestions(instructions),
});

// GET -> { instructions, default, isDefault, questions }
export async function GET(request) {
  const { response } = await gate(request);
  return response ?? json(shape(await doornailInstructions()));
}

// PUT { instructions } saves them for everyone's Doornail answers; { instructions: null } resets.
export async function PUT(request) {
  const { response } = await gate(request);
  if (response) return response;
  const body = await readJson(request);
  const { value, error } = cleanInstructions(body?.instructions);
  if (error) return badRequest(error);
  return json(shape(await saveDoornailInstructions(value)));
}

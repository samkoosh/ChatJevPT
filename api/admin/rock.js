import { authDisabledResponse, authenticate, badRequest, json, readJson } from "../../lib/auth.js";
import { ROCK_INSTRUCTIONS } from "../../lib/jev.js";
import { cleanInstructions, rockInstructions, saveRockInstructions } from "../../lib/rock.js";

async function gate(request) {
  const auth = await authenticate(request, { admin: true });
  if (auth.off) return { response: authDisabledResponse() };
  return auth;
}

const shape = (instructions) => ({ instructions, default: ROCK_INSTRUCTIONS, isDefault: instructions === ROCK_INSTRUCTIONS });

// GET -> { instructions, default, isDefault }
export async function GET(request) {
  const { response } = await gate(request);
  return response ?? json(shape(await rockInstructions()));
}

// PUT { instructions } saves them for everyone's Rock answers; { instructions: null } resets.
export async function PUT(request) {
  const { response } = await gate(request);
  if (response) return response;
  const body = await readJson(request);
  const { value, error } = cleanInstructions(body?.instructions);
  if (error) return badRequest(error);
  return json(shape(await saveRockInstructions(value)));
}

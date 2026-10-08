import { LAB_LEVELS, explainer } from "../lib/jev.js";
import { labInstructions } from "../lib/lab.js";

// GET -> what the "How it works" page shows: limits, thresholds and prompts, straight from the code,
// with the lab's saved Doornail and Rock instructions. Public, like the page.
export async function GET() {
  const how = explainer();
  for (const level of LAB_LEVELS) how.prompts[level] = await labInstructions(level);
  return Response.json(how, { headers: { "cache-control": "public, max-age=60" } });
}

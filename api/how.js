import { explainer } from "../lib/jev.js";
import { savedPrompts } from "../lib/lab.js";

// GET -> what the "How it works" page shows: limits, thresholds and prompts, straight from the code,
// with any prompt edits admins have saved in place of the defaults. Public, like the page.
export async function GET() {
  const how = explainer();
  how.prompts = await savedPrompts();
  return Response.json(how, { headers: { "cache-control": "no-store" } });
}

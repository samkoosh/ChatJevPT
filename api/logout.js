import { authMode, clearedCookie, csrfError } from "../lib/auth.js";

// POST -> clears the session cookie.
export async function POST(request) {
  if (authMode().mode !== "off") {
    const refused = csrfError(request);
    if (refused) return refused;
  }
  return Response.json({ ok: true }, { headers: { "set-cookie": clearedCookie(request) } });
}

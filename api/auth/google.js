import {
  account,
  admit,
  authDisabledResponse,
  authMode,
  csrfError,
  fail,
  misconfiguredResponse,
  readJson,
  sessionCookie,
  signSession,
  verifyGoogleToken,
} from "../../lib/auth.js";

// POST { credential } (a Google ID token from the Sign in with Google button) -> /api/me shape + session cookie.
export async function POST(request) {
  const { mode, missing } = authMode();
  if (mode === "off") return authDisabledResponse();
  if (mode === "misconfigured") return misconfiguredResponse(missing);
  const refused = csrfError(request);
  if (refused) return refused;

  const body = await readJson(request);
  if (typeof body?.credential !== "string" || !body.credential) return fail(400, "bad_request", "Missing Google credential.");
  let profile;
  try {
    profile = await verifyGoogleToken(body.credential);
  } catch (err) {
    console.error("Google sign-in rejected:", err.code ?? err.message);
    return fail(401, "bad_credential", "Google sign-in didn't work. Try again.");
  }

  const { user, response } = await admit(profile);
  if (response) return response;
  const cookie = sessionCookie(request, await signSession(user.email));
  return Response.json(account(user), { headers: { "set-cookie": cookie } });
}

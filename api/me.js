import { account, authMode, clearedCookie, devLoginEmail, misconfiguredResponse, monthStart, sessionEmail } from "../lib/auth.js";
import { getStore } from "../lib/store.js";

// GET -> { authEnabled, user?, usage?, googleClientId?, devLogin? }
export async function GET(request) {
  const { mode, missing } = authMode();
  if (mode === "off") return Response.json({ authEnabled: false });
  if (mode === "misconfigured") return misconfiguredResponse(missing);

  const email = await sessionEmail(request);
  const user = email ? await getStore().getUser(email, monthStart()) : null;
  if (user?.status === "allowed") return Response.json(account(user));

  const signedOut = { authEnabled: true, googleClientId: process.env.GOOGLE_CLIENT_ID || null };
  if (devLoginEmail()) signedOut.devLogin = true;
  // A session for someone who has since been blocked (or removed) is dropped.
  const headers = email ? { "set-cookie": clearedCookie(request) } : {};
  return Response.json(signedOut, { headers });
}

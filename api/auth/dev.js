import { account, authMode, csrfError, devLoginEmail, monthStart, notFound, sessionCookie, signSession } from "../../lib/auth.js";
import { getStore } from "../../lib/store.js";

// Local dev only: POST signs in as DEV_LOGIN_EMAIL (as an admin) without Google.
// Refused whenever VERCEL is set, so it can never work on a deployment.
export async function POST(request) {
  const email = devLoginEmail();
  if (!email || authMode().mode !== "on") return notFound();
  const refused = csrfError(request);
  if (refused) return refused;

  const store = getStore();
  await store.signIn({ email, googleSub: null, name: "Dev", picture: null }, { admin: true });
  const user = await store.getUser(email, monthStart());
  return Response.json(account(user), { headers: { "set-cookie": sessionCookie(request, await signSession(email)) } });
}

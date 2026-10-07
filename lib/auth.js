// Accounts: modes, Google sign-in, sessions, CSRF and budgets. Handlers in api/ stay thin.
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { getStore } from "./store.js";

export const MAX_CHATS = 5;
const AUTH_VARS = ["GOOGLE_CLIENT_ID", "SESSION_SECRET", "DATABASE_URL"];
const SESSION_DAYS = 7;
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

// Created once per cold start; jose caches Google's keys and refetches them when they rotate.
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
let getGoogleKeys = () => GOOGLE_JWKS;

// Tests verify against a local key set instead of Google's (pass null to restore).
export function setGoogleKeys(getter) {
  getGoogleKeys = getter ?? (() => GOOGLE_JWKS);
}

const onVercel = () => Boolean(process.env.VERCEL);
export const devLoginEmail = () => (!onVercel() && process.env.DEV_LOGIN_EMAIL?.trim().toLowerCase()) || null;

// "off" when none of the three variables is set, "on" when all are, "misconfigured" otherwise.
// STORE=memory counts as a database. Off Vercel, DEV_LOGIN_EMAIL stands in for GOOGLE_CLIENT_ID,
// so local dev can sign in without a Google client.
export function authMode(env = process.env) {
  const has = {
    GOOGLE_CLIENT_ID: Boolean(env.GOOGLE_CLIENT_ID),
    SESSION_SECRET: Boolean(env.SESSION_SECRET),
    DATABASE_URL: Boolean(env.DATABASE_URL) || env.STORE === "memory",
  };
  const local = !env.VERCEL && Boolean(env.DEV_LOGIN_EMAIL);
  if (!AUTH_VARS.some((name) => has[name]) && !local) return { mode: "off", missing: [] };
  if (local) has.GOOGLE_CLIENT_ID = true;
  const missing = AUTH_VARS.filter((name) => !has[name]);
  return { mode: missing.length ? "misconfigured" : "on", missing };
}

export const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers });
const fail = (status, code, error) => json({ error, code }, status);

export function misconfiguredResponse(missing) {
  return fail(500, "auth_misconfigured", `Sign-in is half set up: missing ${missing.join(", ")}.`);
}

export const authDisabledResponse = () => fail(404, "auth_disabled", "Accounts aren't turned on.");

// --- CSRF -------------------------------------------------------------------------------------

// State-changing requests must come from our own pages: same Origin and a JSON content type,
// which a cross-site form can't send without a CORS preflight.
export function csrfError(request) {
  const origin = request.headers.get("origin");
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!origin || origin !== new URL(request.url).origin || !type.startsWith("application/json")) {
    return fail(403, "csrf", "Request refused: it didn't come from ChatJevPT.");
  }
  return null;
}

// --- Sessions ---------------------------------------------------------------------------------

// Over plain http on localhost, browsers reject __Host- and Secure cookies, so local dev drops both.
function isLocalHttp(request) {
  const { protocol, hostname } = new URL(request.url);
  return protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

export const cookieName = (request) => (isLocalHttp(request) ? "session" : "__Host-session");

export function sessionCookie(request, value, maxAge = SESSION_DAYS * 86400) {
  const secure = isLocalHttp(request) ? "" : "; Secure";
  return `${cookieName(request)}=${value}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${maxAge}`;
}

export const clearedCookie = (request) => sessionCookie(request, "", 0);

const secretKey = () => new TextEncoder().encode(process.env.SESSION_SECRET);

export function signSession(email, { expiresIn = `${SESSION_DAYS}d` } = {}) {
  return new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(email).setIssuedAt().setExpirationTime(expiresIn).sign(secretKey());
}

export async function verifySession(token) {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

export const sessionEmail = (request) => {
  const token = readCookie(request, cookieName(request));
  return token ? verifySession(token) : null;
};

// --- Google -----------------------------------------------------------------------------------

export async function verifyGoogleToken(credential, { clientId = process.env.GOOGLE_CLIENT_ID, getKeys = getGoogleKeys } = {}) {
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not set");
  const { payload } = await jwtVerify(credential, getKeys(), { issuer: GOOGLE_ISSUERS, audience: clientId });
  if (payload.email_verified !== true || typeof payload.email !== "string") throw new Error("Google email not verified");
  return {
    email: payload.email.toLowerCase(),
    googleSub: payload.sub,
    name: typeof payload.name === "string" ? payload.name : null,
    picture: typeof payload.picture === "string" ? payload.picture : null,
  };
}

export const adminEmails = () =>
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

// Admins: role admin, or listed in ADMIN_EMAILS. They have no budget, but their usage is still recorded.
export const isAdmin = (user) => user?.role === "admin" || adminEmails().includes(user?.email);

// Signs in a verified profile. Returns { user } or { response } (403 not on the list / blocked).
export async function admit(profile) {
  const store = getStore();
  const admin = adminEmails().includes(profile.email);
  if (!admin) {
    const user = await store.getUser(profile.email, usageSince());
    if (!user) {
      await store.requestAccess(profile.email, profile.name);
      return { response: fail(403, "not_invited", "You're not on the list yet. Ask the owner for access.") };
    }
    if (user.status !== "allowed") return { response: blockedResponse() };
  }
  await store.signIn(profile, { admin });
  return { user: await store.getUser(profile.email, usageSince()) };
}

const blockedResponse = () => fail(403, "blocked", "Your access to ChatJevPT has been turned off. Ask the owner.");

// --- Budgets ----------------------------------------------------------------------------------

const today = (now = new Date()) => now.toISOString().slice(0, 10);
// Budgets are lifetime allowances, so usage is counted from the beginning.
export const usageSince = () => "1970-01-01";

export function defaultBudgetMicros() {
  const usd = Number(process.env.DEFAULT_BUDGET_USD);
  return Math.round((process.env.DEFAULT_BUDGET_USD && Number.isFinite(usd) && usd >= 0 ? usd : 0.25) * 1e6);
}

// A person's total allowance in micro-dollars ($0.25 unless set); null means no limit (admins).
export const budgetOf = (user) => (isAdmin(user) ? null : (user.customBudgetMicros ?? defaultBudgetMicros()));

export const formatUsd = (micros) => `$${(micros / 1e6).toFixed(2)}`;

export function budgetResponse(user) {
  const budget = budgetOf(user);
  if (budget === null || user.totalCostMicros < budget) return null;
  return fail(402, "budget_exhausted", `You've used your ChatJevPT allowance (${formatUsd(budget)}). Ask the owner if you'd like more.`);
}

// Records a Jev call's actual tokens and cost (in dollars) against today's usage row. The answer
// was already paid for, so a failed write is logged rather than turned into an error.
export async function charge(user, { tokens = 0, cost = 0 } = {}) {
  try {
    await getStore().charge(user.email, today(), Math.max(0, Math.round(tokens || 0)), Math.max(0, Math.round((cost || 0) * 1e6)));
  } catch (err) {
    console.error("Couldn't record usage for", user.email, err);
  }
}

// --- Request gate -----------------------------------------------------------------------------

// Every protected handler starts here. Returns { off: true } when accounts are off,
// { response } to send as is, or { user } (with their total usage) for a signed-in person.
export async function authenticate(request, { admin = false } = {}) {
  const { mode, missing } = authMode();
  if (mode === "off") return { off: true };
  if (mode === "misconfigured") return { response: misconfiguredResponse(missing) };
  if (!["GET", "HEAD"].includes(request.method)) {
    const refused = csrfError(request);
    if (refused) return { response: refused };
  }
  const email = await sessionEmail(request);
  if (!email) return { response: fail(401, "signed_out", "Sign in to keep going.") };
  const user = await getStore().getUser(email, usageSince());
  if (!user) return { response: fail(401, "signed_out", "Sign in to keep going.") };
  if (user.status !== "allowed") return { response: blockedResponse() };
  if (admin && !isAdmin(user)) return { response: fail(403, "not_admin", "Only admins can do that.") };
  return { user };
}

// The /api/me shape for a signed-in person.
export function account(user) {
  return {
    authEnabled: true,
    user: { email: user.email, name: user.name, picture: user.picture, role: isAdmin(user) ? "admin" : user.role },
    usage: { totalCostMicros: user.totalCostMicros, totalTokens: user.totalTokens, budgetMicros: budgetOf(user) },
  };
}

export async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

export const badRequest = (error) => fail(400, "bad_request", error);
export const notFound = (error = "Not found.") => fail(404, "not_found", error);
export { fail };

// Shared plumbing for the browser UI tests: a dev.mjs child process for static
// files, a Chromium instance, and scripted fakes for every /api/* route so the
// tests never reach Jev or the accounts backend.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_HEADER = "x-fake-jev";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Starts dev.mjs on a free port. TYPESAFE_API_KEY is blanked and JEV_MOCK is
// off, so even a request that slipped past the fake would get a 500 from the
// function rather than calling Jev.
export async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, ["dev.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), TYPESAFE_API_KEY: "", JEV_MOCK: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dev.mjs did not start: ${stderr}`)), 10_000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("ChatJevPT on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`dev.mjs exited (${code}): ${stderr}`));
    });
  });
  return {
    baseURL: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", resolve);
        child.kill();
      }),
  };
}

export function launchBrowser() {
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}

// Opens a fresh context + page. Any /api/* request that no test route
// handled is recorded in `leaks`; call assertNoLeaks() at the end of a test.
//   setup: async (page) => {}  routes to add before the page loads
//   path:  the page to open (default "/")
export async function openPage(browser, baseURL, { device, setup, path = "/" } = {}) {
  let options = { baseURL };
  if (device) {
    const { defaultBrowserType, ...descriptor } = devices[device];
    options = { ...descriptor, baseURL };
  } else {
    options.viewport = { width: 1280, height: 800 };
  }
  const context = await browser.newContext(options);
  const leaks = [];

  // Fonts are cosmetic and external; keep the tests offline and fast.
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  // Google's sign-in script is replaced by a tiny stub (see GIS_STUB).
  await context.route(/accounts\.google\.com/, (route) =>
    route.request().url().startsWith(GIS_URL)
      ? route.fulfill({ status: 200, contentType: "text/javascript", body: GIS_STUB })
      : route.abort(),
  );
  // Context routes run after page routes, so this only fires when a test
  // didn't route that /api/* path. Accounts are off and ratings are free and
  // "Good" by default; anything else is a leak, aborted so nothing reaches the server.
  await context.route(/\/api\//, (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/me") return fulfill(route, 200, { authEnabled: false });
    if (pathname === "/api/rate") return fulfill(route, 200, DEFAULT_RATING);
    leaks.push(`unrouted ${route.request().method()} ${route.request().url()}`);
    return route.abort();
  });
  // Belt and braces: every /api/* response must come from a fake.
  context.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/api/") && response.headers()[FAKE_HEADER] !== "1") {
      leaks.push(`server answered ${path} (${response.status()})`);
    }
  });

  const page = await context.newPage();
  page.on("dialog", (dialog) => (page.confirmAnswer ?? true ? dialog.accept() : dialog.dismiss()));
  if (setup) await setup(page);
  await page.goto(path);
  return {
    context,
    page,
    leaks,
    assertNoLeaks() {
      if (leaks.length) throw new Error(`/api/* reached the server:\n${leaks.join("\n")}`);
    },
  };
}

const OPTION = { " ": "SPACE", "\n": "NEWLINE" };
const ALPHABET = "abcdefghijklmnopqrstuvwxyz".split("");

export const TOKENS_PER_CALL = 100;
export const DEFAULT_RATING = { label: "Good", score: 3.1, tokens: 0, cost: 0 };
export const COST_PER_CALL = 0.0001;

function topFor(pick) {
  const others = ALPHABET.filter((o) => o !== pick.toLowerCase()).slice(0, 2);
  return [
    { option: pick, p: 0.7 },
    { option: others[0], p: 0.2 },
    { option: others[1], p: 0.1 },
  ];
}

export function fulfill(route, status, body) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { [FAKE_HEADER]: "1" },
    body: JSON.stringify(body),
  });
}

// Returns a route handler that spells out `text` one character per request
// (keyed on the request's answer length), then END. Every request body is
// recorded in handler.requests.
//   overrides: { [index]: partial response } e.g. { 2: { tied: 2, coinFlip: false } }
//   gate:      { [index]: Promise } – hold that step's response until it resolves
export function scripted(text, { overrides = {}, gate = {} } = {}) {
  const requests = [];
  const handler = async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const i = body.answer.length;
    if (gate[i]) await gate[i];
    const char = i < text.length ? text[i] : "";
    const pick = i < text.length ? (OPTION[char] ?? char) : "END";
    const response = {
      pick,
      char,
      top: topFor(pick),
      tied: 1,
      runoffs: 0,
      coinFlip: false,
      done: pick === "END",
      wordDone: pick === "END" || pick === "SPACE" || pick === "NEWLINE",
      tokens: TOKENS_PER_CALL,
      cost: COST_PER_CALL,
      ...overrides[i],
    };
    try {
      await fulfill(route, 200, response);
    } catch {
      // The page aborted the fetch (Stop / New chat) while we were gated.
    }
  };
  handler.requests = requests;
  return handler;
}

// Route handler for /api/rate returning `rating`; records request bodies.
//   gate: Promise – hold the response until it resolves
export function rated(rating, { gate } = {}) {
  const requests = [];
  const handler = async (route) => {
    requests.push(route.request().postDataJSON());
    if (gate) await gate;
    try {
      await fulfill(route, 200, rating);
    } catch {}
  };
  handler.requests = requests;
  return handler;
}

// Route handler that answers every request with an error status.
export function failing(status, body) {
  const requests = [];
  const handler = (route) => {
    requests.push(route.request().postDataJSON());
    return fulfill(route, status, body);
  };
  handler.requests = requests;
  return handler;
}

// Routes /api/next by question, so one page can ask several scripted questions.
export function byQuestion(map) {
  return (route) => {
    const { question } = route.request().postDataJSON();
    const handler = map[question];
    if (!handler) return fulfill(route, 500, { error: `no script for ${question}` });
    return handler(route);
  };
}

export function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

// Google Identity Services stand-in: initialize() keeps the callback, renderButton()
// draws a button that "signs in" with a fixed credential. Calls are logged on window.gisCalls.
export const GIS_URL = "https://accounts.google.com/gsi/client";
export const FAKE_CREDENTIAL = "fake.google.id-token";
const GIS_STUB = `
window.gisCalls = [];
window.google = { accounts: { id: {
  initialize(config) { window.gisCalls.push(["initialize", { client_id: config.client_id }]); window.gisCallback = config.callback; },
  renderButton(target, options) {
    window.gisCalls.push(["renderButton", options]);
    const b = document.createElement("button");
    b.className = "fake-gsi";
    b.textContent = "Sign in with Google";
    b.onclick = () => window.gisCallback({ credential: ${JSON.stringify(FAKE_CREDENTIAL)} });
    target.append(b);
  },
  disableAutoSelect() { window.gisCalls.push(["disableAutoSelect"]); },
} } };
`;

export const USER = { email: "friend@example.com", name: "Friend", picture: null, role: "user" };
export const ADMIN = { email: "owner@example.com", name: "Owner", picture: null, role: "admin" };

// A fake accounts backend: /api/me, /api/auth/*, /api/logout and /api/chats[/id], kept in
// memory per page. Every request is logged in `log` as "METHOD /path" with its body.
//   user:   the signed-in user, or null for signed out
//   usage:  { totalCostMicros, totalTokens, budgetMicros }
//   chats:  [{ id, title, updatedAt, turns }]
//   signIn: response for POST /api/auth/google: { status, body }
export function fakeAccounts({ user = USER, usage, chats = [], signIn, googleClientId = "test-client" } = {}) {
  const state = {
    user,
    usage: usage ?? { totalCostMicros: 120_000, totalTokens: 3400, budgetMicros: user?.role === "admin" ? null : 1_000_000 },
    chats: chats.map((c) => ({ turns: [], ...c })),
  };
  const log = [];
  let nextId = 1;
  const meBody = () =>
    state.user ? { authEnabled: true, user: state.user, usage: state.usage } : { authEnabled: true, googleClientId };
  const summary = (c) => ({ id: c.id, title: c.title, turnCount: c.turns.length, updatedAt: c.updatedAt });

  async function install(page) {
    await page.route(/\/api\/(me|auth\/google|logout|chats)(\/|$|\?)/, (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      const method = request.method();
      const body = request.postData() ? request.postDataJSON() : undefined;
      log.push({ call: `${method} ${pathname}`, body, headers: request.headers() });
      if (pathname === "/api/me") return fulfill(route, 200, meBody());
      if (pathname === "/api/auth/google") {
        if (signIn) return fulfill(route, signIn.status, signIn.body);
        state.user = USER;
        return fulfill(route, 200, meBody());
      }
      if (pathname === "/api/logout") {
        state.user = null;
        return fulfill(route, 200, { ok: true });
      }
      if (pathname === "/api/chats" && method === "GET") return fulfill(route, 200, { chats: state.chats.map(summary) });
      if (pathname === "/api/chats" && method === "POST") {
        if (state.chats.length >= 5) return fulfill(route, 409, { error: "You can keep up to 5 chats. Delete one to start another.", code: "chat_limit" });
        const chat = { id: `new-${nextId++}`, title: "", updatedAt: new Date().toISOString(), turns: [] };
        state.chats.unshift(chat);
        return fulfill(route, 201, { chat: summary(chat) });
      }
      const id = pathname.split("/").pop();
      const chat = state.chats.find((c) => c.id === id);
      if (!chat) return fulfill(route, 404, { error: "Chat not found.", code: "not_found" });
      if (method === "GET") return fulfill(route, 200, { chat });
      if (method === "DELETE") {
        state.chats = state.chats.filter((c) => c !== chat);
        return fulfill(route, 200, { ok: true });
      }
      if (body.turn) {
        chat.turns.push({ ...body.turn });
        if (!chat.title) chat.title = body.turn.question.slice(0, 60);
      } else if (body.lastTurnRating) {
        const { index = chat.turns.length - 1, ...rating } = body.lastTurnRating;
        Object.assign(chat.turns[index], rating);
      }
      chat.updatedAt = new Date().toISOString();
      return fulfill(route, 200, { chat: summary(chat) });
    });
  }
  return { install, log, state, calls: () => log.map((l) => l.call) };
}

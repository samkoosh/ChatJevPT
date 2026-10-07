// Shared plumbing for the browser UI tests: a dev.mjs child process for static
// files, a Chromium instance, and a scripted fake for POST /api/next so the
// tests never reach Jev.
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

// Opens a fresh context + page. Any /api/next request that no test route
// handled is recorded in `leaks`; call assertNoLeaks() at the end of a test.
export async function openPage(browser, baseURL, { device } = {}) {
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
  // Context routes run after page routes, so this only fires when a test
  // forgot to route /api/next. Abort so nothing reaches the server.
  await context.route("**/api/next", (route) => {
    leaks.push(`unrouted ${route.request().method()} ${route.request().url()}`);
    return route.abort();
  });
  // Ratings are spoofed by default (free, "Good"); tests about ratings route their own.
  await context.route("**/api/rate", (route) => fulfill(route, 200, DEFAULT_RATING));
  // Belt and braces: every /api/* response must come from a fake.
  context.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/api/") && response.headers()[FAKE_HEADER] !== "1") {
      leaks.push(`server answered ${path} (${response.status()})`);
    }
  });

  const page = await context.newPage();
  await page.goto("/");
  return {
    context,
    page,
    leaks,
    assertNoLeaks() {
      if (leaks.length) throw new Error(`/api/next reached the server:\n${leaks.join("\n")}`);
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

function fulfill(route, status, body) {
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

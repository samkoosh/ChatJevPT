// The "How it works" page: numbers and prompts come from /api/how (spoofed), and it fits a phone.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { fulfill, launchBrowser, openPage, startServer } from "./helpers.mjs";

const T = { timeout: 5_000 };
let server;
let browser;
let session;

before(async () => {
  server = await startServer();
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await server?.stop();
});
afterEach(async () => {
  if (!session) return;
  const s = session;
  session = null;
  await s.context.close();
  s.assertNoLeaks();
});

const HOW = {
  levels: ["doornail", "rock", "stump", "post"],
  numbers: { MAX_LENGTH: 200, DONE_THRESHOLD: 0.75, SENSE_THRESHOLD: 0.35 },
  prompts: { doornail: "Saved Doornail prompt", kind: "Kind prompt" },
};
const routeHow = (page) => page.route("**/api/how", (route) => fulfill(route, 200, HOW));

test("numbers and prompts come from /api/how; there's a section and flowchart per level", async () => {
  session = await openPage(browser, server.baseURL, { path: "/how.html", setup: routeHow });
  const { page } = session;
  await page.waitForFunction(() => document.querySelector('[data-prompt="doornail"]').textContent === "Saved Doornail prompt", null, T);
  assert.equal(await page.locator('[data-n="DONE_THRESHOLD"]').first().textContent(), "0.75", "live value replaces the fallback");
  assert.equal(await page.locator('[data-n="MAX_WORD"]').first().textContent(), "18", "fallback kept when the API has no value");
  assert.equal(await page.locator('[data-prompt="rock"]').textContent(), "(not available)");
  for (const level of HOW.levels) assert.equal(await page.locator(`#level-${level} .flow`).count(), 1, level);
  assert.ok((await page.locator("#level-stump .flow .decision").count()) >= 5);
});

test("fits a 390px phone, and the chat links to it", async () => {
  session = await openPage(browser, server.baseURL, { device: "iPhone 13", path: "/how.html", setup: routeHow });
  const { page } = session;
  await page.locator("#level-post .flow").waitFor(T);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.goto("/");
  assert.equal(await page.locator(".hero-how").getAttribute("href"), "/how.html");
});

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

test("admins get an editor for every prompt: save for everyone, reset, and an edited badge", async () => {
  const prompt = (key, text, isDefault = true) => ({ key, text, default: `default ${key}`, isDefault });
  const keys = ["doornail", "rock", "screen", "done", "word_done", "repeat_ok", "sense", "rank", "kind", "rating"];
  const puts = [];
  session = await openPage(browser, server.baseURL, {
    path: "/how.html",
    setup: async (page) => {
      await routeHow(page);
      await page.route("**/api/me", (route) => fulfill(route, 200, { authEnabled: true, user: { email: "o@x.com", role: "admin" } }));
      await page.route("**/api/admin/prompts", (route) => {
        if (route.request().method() === "GET") {
          return fulfill(route, 200, { prompts: Object.fromEntries(keys.map((k) => [k, prompt(k, `default ${k}`)])) });
        }
        const body = route.request().postDataJSON();
        puts.push(body);
        return fulfill(route, 200, body.text === null ? prompt(body.key, `default ${body.key}`) : prompt(body.key, body.text, false));
      });
    },
  });
  const { page } = session;
  await page.locator("#admin-note").waitFor(T);
  assert.equal(await page.locator(".prompt-editor").count(), keys.length, "every prompt on the page is editable");
  assert.equal(await page.locator("pre[data-prompt]").count(), 0);

  const done = page.locator('.prompt-editor[data-prompt="done"]');
  await page.locator("#level-stump details").first().locator("summary").click();
  assert.ok(await done.getByRole("button", { name: "Save for everyone" }).isDisabled(), "nothing to save yet");
  await done.locator("textarea").fill("Is it finished?");
  assert.equal(await done.locator(".prompt-status").textContent(), "Unsaved changes");
  await done.getByRole("button", { name: "Save for everyone" }).click();
  await page.waitForFunction(() => document.querySelector('.prompt-editor[data-prompt="done"]').classList.contains("edited"), null, T);
  assert.deepEqual(puts.at(-1), { key: "done", text: "Is it finished?" });
  assert.match(await done.locator(".prompt-status").textContent(), /Saved/);
  assert.equal(await page.locator("#level-stump details.has-edits").count(), 1, "the section shows it's edited");

  await done.getByRole("button", { name: "Reset to default" }).click();
  await page.waitForFunction(() => !document.querySelector('.prompt-editor[data-prompt="done"]').classList.contains("edited"), null, T);
  assert.deepEqual(puts.at(-1), { key: "done", text: null });
  assert.equal(await done.locator("textarea").inputValue(), "default done");
});

test("previewing as a regular person shows the prompts read-only", async () => {
  session = await openPage(browser, server.baseURL, {
    path: "/how.html",
    setup: async (page) => {
      await routeHow(page);
      await page.addInitScript(() => sessionStorage.setItem("jev-preview", "1"));
    },
  });
  const { page } = session;
  await page.waitForFunction(() => document.querySelector('[data-prompt="doornail"]').textContent === "Saved Doornail prompt", null, T);
  assert.equal(await page.locator(".prompt-editor").count(), 0);
  assert.ok(await page.locator("#admin-note").isHidden());
});

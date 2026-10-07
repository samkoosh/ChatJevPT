// The "Stopped" tag on answers ended with Stop, live and in saved chats. All /api/* spoofed.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { deferred, fakeAccounts, launchBrowser, openPage, scripted, startServer } from "./helpers.mjs";

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

async function stopMidAnswer(page, via) {
  const gate = deferred();
  await page.route("**/api/next", scripted("Hello world", { gate: { 3: gate.promise } }));
  await page.fill("#input", "Say hello");
  await page.click("#send");
  await page.waitForFunction(() => document.querySelectorAll(".answer .ch").length === 3, null, T);
  await page.click(via);
  await page.waitForFunction(() => !document.querySelector("#send.stop"), null, T);
  gate.resolve();
}

test("Stop (either button) tags the answer Stopped; finished answers aren't", async () => {
  for (const via of [".meta .stop-answer", "#send"]) {
    session = await openPage(browser, server.baseURL);
    const page = session.page;
    await stopMidAnswer(page, via);
    await page.locator(".meta .stopped-tag").waitFor(T);
    assert.equal(await page.locator(".meta .stopped-tag").textContent(), "Stopped", via);
    await session.context.close();
    session.assertNoLeaks();
    session = null;
  }
  session = await openPage(browser, server.baseURL);
  await session.page.route("**/api/next", scripted("Hi"));
  await session.page.fill("#input", "Q");
  await session.page.click("#send");
  await session.page.waitForFunction(() => !document.querySelector("#send.stop") && document.querySelector(".meta .act"), null, T);
  assert.equal(await session.page.locator(".stopped-tag").count(), 0);
});

test("saved chats remember Stopped and the level", async () => {
  const accounts = fakeAccounts({
    chats: [{ id: "c1", title: "Old", updatedAt: new Date().toISOString(), turns: [{ question: "Q", answer: "Hel", tokens: 1, cost: 0, level: "doornail", stopped: true }] }],
  });
  session = await openPage(browser, server.baseURL, { setup: (page) => accounts.install(page) });
  const page = session.page;
  await page.locator("#chat-list button").first().waitFor(T);

  await stopMidAnswer(page, ".meta .stop-answer");
  await page.waitForFunction(() => document.querySelector(".meta .rating:not(.pending)"), null, T);
  const saved = accounts.log.find((l) => l.call.startsWith("PUT /api/chats/") && l.body.turn);
  assert.equal(saved.body.turn.stopped, true);
  assert.equal(saved.body.turn.level, "stump");

  await page.locator("#chat-list button", { hasText: "Old" }).click();
  await page.locator(".msg-jev.saved .stopped-tag").waitFor(T);
  assert.equal(await page.locator(".msg-jev.saved .level-tag").textContent(), "Doornail");
});

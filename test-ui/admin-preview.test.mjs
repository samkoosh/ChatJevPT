// Admins: unlimited chats, and the "preview as non-admin" view. Every /api/* route is spoofed.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, fakeAccounts, launchBrowser, openPage, scripted, startServer } from "./helpers.mjs";

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

const sixChats = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, title: `Chat ${i + 1}`, updatedAt: new Date(Date.now() - i * 60_000).toISOString() }));
const ADMIN_ME = { limits: { chats: null }, regular: { budgetMicros: 250_000, chats: 5 } };

async function open(options = {}, opts = {}) {
  const accounts = fakeAccounts({ user: ADMIN, me: ADMIN_ME, chats: sixChats, ...options });
  session = await openPage(browser, server.baseURL, { ...opts, setup: (page) => accounts.install(page) });
  await session.page.locator("#account-btn").waitFor(T);
  return { page: session.page, accounts };
}

async function openMenu(page) {
  await page.click("#account-btn");
  await page.locator("#account-menu").waitFor({ state: "visible", ...T });
}

test("admins have no chat limit: more than 5 chats, New chat stays enabled", async () => {
  const { page } = await open();
  await page.waitForFunction(() => document.querySelectorAll("#chat-list .chat-item, #chat-list li:not(.chat-empty)").length === 6, null, T);
  assert.equal(await page.locator("#chat-count").textContent(), "6");
  assert.ok(await page.locator("#sidebar-new").isEnabled());
  assert.match(await page.locator("#sidebar-note").textContent(), /as many chats as they like/);
});

test("regular people still see 5 max", async () => {
  const { page } = await open({ user: { email: "friend@example.com", name: "Friend", picture: null, role: "user" }, me: { limits: { chats: 5 } }, chats: sixChats.slice(0, 5) });
  await page.waitForFunction(() => document.getElementById("chat-count").textContent === "5/5", null, T);
  assert.ok(await page.locator("#sidebar-new").isDisabled());
  await openMenu(page);
  assert.ok(await page.locator("#preview-toggle").isHidden(), "no preview for non-admins");
});

test("preview as non-admin hides admin tools and shows regular limits, then exits", async () => {
  const { page } = await open();
  await page.waitForFunction(() => document.getElementById("chat-count").textContent === "6", null, T);
  assert.ok(await page.locator("#lab-toggle").isVisible());

  await openMenu(page);
  await page.click("#preview-toggle");
  await page.locator("#preview-banner").waitFor({ state: "visible", ...T });
  assert.ok(await page.locator("#lab-toggle").isHidden(), "Lab hidden");
  assert.equal(await page.locator("#chat-count").textContent(), "6/5");
  assert.ok(await page.locator("#sidebar-new").isDisabled(), "New chat greyed out at the regular limit");
  await openMenu(page);
  assert.ok(await page.locator("#admin-link").isHidden(), "Admin link hidden");
  assert.equal(await page.locator("#usage-text").textContent(), "Usage: $0.12 of $0.25");
  assert.ok(await page.locator("#usage-bar").isVisible());
  assert.equal(await page.locator("#preview-toggle").textContent(), "Exit non-admin preview");

  // Doornail answers don't carry a lab draft while previewing.
  await page.evaluate(() => localStorage.setItem("jev-doornail-draft", "My draft."));
  await page.keyboard.press("Escape");
  await page.locator('.level-option[data-level="doornail"]').click();
  const fake = scripted("B");
  await page.route("**/api/next", fake);
  await page.fill("#input", "Q");
  await page.click("#send");
  await page.waitForFunction(() => !document.querySelector("#send.stop"), null, T);
  assert.ok(fake.requests.every((r) => !("labInstructions" in r)));

  // Survives a reload (same tab), then Exit preview restores everything.
  await page.reload();
  await page.locator("#preview-banner").waitFor({ state: "visible", ...T });
  await page.click("#preview-exit");
  await page.locator("#preview-banner").waitFor({ state: "hidden", ...T });
  assert.ok(await page.locator("#lab-toggle").isVisible());
  assert.equal(await page.locator("#chat-count").textContent(), "6");
  await openMenu(page);
  assert.ok(await page.locator("#admin-link").isVisible());
  assert.equal(await page.locator("#usage-text").textContent(), "Usage: $0.12 total · no limit");
});

test("the preview banner fits a phone in both themes", async () => {
  for (const theme of ["modern", "y2k"]) {
    const { page } = await open({}, { device: "iPhone 13" });
    if (theme === "y2k") await page.evaluate(() => (document.documentElement.dataset.uiTheme = "y2k"));
    await openMenu(page);
    await page.click("#preview-toggle");
    await page.locator("#preview-banner").waitFor({ state: "visible", ...T });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, theme);
    await session.context.close();
    session.assertNoLeaks();
    session = null;
  }
});

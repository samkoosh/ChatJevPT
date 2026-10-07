// Model level picker (Doornail / Rock / Stump / Post) and the memory toggle. All /api/* spoofed.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { byQuestion, launchBrowser, openPage, scripted, startServer } from "./helpers.mjs";

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

async function open(opts) {
  session = await openPage(browser, server.baseURL, opts);
  return session.page;
}

async function ask(page, question) {
  await page.fill("#input", question);
  await page.click("#send");
  await page.waitForFunction(() => !document.querySelector(".msg-jev.typing") && !document.querySelector("#send.stop"), null, T);
}

const level = (page, name) => page.locator(`.level-option[data-level="${name}"]`);

test("Stump with memory is the default and is what requests send", async () => {
  const page = await open();
  const fake = scripted("Hi");
  await page.route("**/api/next", fake);
  assert.equal(await level(page, "stump").getAttribute("aria-checked"), "true");
  assert.equal(await page.locator("#memory-toggle").getAttribute("aria-pressed"), "true");
  await ask(page, "Q");
  assert.ok(fake.requests.every((r) => r.level === "stump" && r.memory === true));
  assert.match(await page.locator(".meta .level-tag").textContent(), /Stump/);
});

test("Doornail: requests say doornail, memory is off and greyed out, and the choice is remembered", async () => {
  const page = await open();
  await level(page, "doornail").click();
  assert.equal(await level(page, "doornail").getAttribute("aria-checked"), "true");
  assert.ok(await page.locator("#memory-toggle").isDisabled());
  assert.match(await page.locator("#memory-toggle").getAttribute("title"), /Doornails don't remember/);

  const fake = scripted("Hi");
  await page.route("**/api/next", fake);
  await ask(page, "Q");
  assert.ok(fake.requests.every((r) => r.level === "doornail" && r.memory === false));
  assert.match(await page.locator(".meta .level-tag").textContent(), /Doornail/);

  await page.reload();
  assert.equal(await level(page, "doornail").getAttribute("aria-checked"), "true", "remembered");
});

test("Rock: sits between Doornail and Stump, requests say rock, and memory is off", async () => {
  const page = await open();
  const order = await page.locator(".level-option").evaluateAll((els) => els.map((e) => e.dataset.level));
  assert.deepEqual(order, ["doornail", "rock", "stump", "post"]);
  await level(page, "rock").click();
  assert.equal(await level(page, "rock").getAttribute("aria-checked"), "true");
  assert.ok(await page.locator("#memory-toggle").isDisabled());
  assert.match(await page.locator("#memory-toggle").getAttribute("title"), /Rocks don't remember/);

  const fake = scripted("Hi");
  await page.route("**/api/next", fake);
  await ask(page, "Q");
  assert.ok(fake.requests.every((r) => r.level === "rock" && r.memory === false && !("doornailInstructions" in r)));
  assert.match(await page.locator(".meta .level-tag").textContent(), /Rock/);
});

test("Post: requests say post, memory stays on, and the tooltip shows the kind round", async () => {
  const page = await open();
  await level(page, "post").click();
  assert.equal(await level(page, "post").getAttribute("aria-checked"), "true");
  assert.equal(await page.locator("#memory-toggle").isDisabled(), false);

  const kinds = [{ option: "LETTER", p: 0.9 }, { option: "SPACE", p: 0.1 }];
  const fake = scripted("Hi", { overrides: { 0: { kind: "LETTER", kinds } } });
  await page.route("**/api/next", fake);
  await ask(page, "Q");
  assert.ok(fake.requests.every((r) => r.level === "post" && r.memory === true));
  assert.match(await page.locator(".meta .level-tag").textContent(), /Post/);

  await page.locator(".answer .ch").first().hover();
  await page.locator("#tooltip").waitFor({ state: "visible", ...T });
  assert.equal(await page.locator("#tooltip .screen-note").first().textContent(), "Kind: letter 90% · space 10%");

  await page.reload();
  assert.equal(await level(page, "post").getAttribute("aria-checked"), "true", "remembered");
});

test("memory off: requests and the rating say memory false, and it's remembered", async () => {
  const page = await open();
  await page.locator("#memory-toggle").click();
  assert.equal(await page.locator("#memory-toggle").getAttribute("aria-pressed"), "false");
  const rates = [];
  await page.route("**/api/rate", (route) => {
    rates.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "x-fake-jev": "1" }, body: JSON.stringify({ label: "Good", score: 3, tokens: 0, cost: 0 }) });
  });
  const fake = scripted("Hi");
  await page.route("**/api/next", fake);
  await ask(page, "Q");
  assert.ok(fake.requests.every((r) => r.memory === false));
  await page.locator(".rating-good").waitFor(T);
  assert.equal(rates[0].memory, false);
  await page.reload();
  assert.equal(await page.locator("#memory-toggle").getAttribute("aria-pressed"), "false");
});

test("changing level mid-answer doesn't change the answer in progress", async () => {
  const page = await open();
  let release;
  const gate = new Promise((r) => (release = r));
  const fake = scripted("Hello", { gate: { 2: gate } });
  await page.route("**/api/next", byQuestion({ Q: fake }));
  await page.fill("#input", "Q");
  await page.click("#send");
  await page.waitForFunction(() => document.querySelectorAll(".answer .ch").length === 2, null, T);
  await level(page, "doornail").click();
  release();
  await page.waitForFunction(() => !document.querySelector("#send.stop"), null, T);
  assert.ok(fake.requests.every((r) => r.level === "stump"));
});

test("the composer controls fit a 390px phone in both themes", async () => {
  for (const theme of ["modern", "y2k"]) {
    const page = await open({ device: "iPhone 13" });
    if (theme === "y2k") await page.evaluate(() => (document.documentElement.dataset.uiTheme = "y2k"));
    await page.locator(".composer-controls").waitFor(T);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, theme);
    const box = await page.locator(".composer-controls").boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, `${theme}: controls inside the screen`);
    await session.context.close();
    session.assertNoLeaks();
    session = null;
  }
});

test("a profile photo fills the avatar circle", async () => {
  const page = await open();
  const sizes = await page.evaluate(() => {
    const account = document.getElementById("account");
    account.hidden = false;
    const button = document.getElementById("account-btn");
    const img = document.createElement("img");
    img.src = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="red"/></svg>');
    button.replaceChildren(img);
    const b = button.getBoundingClientRect();
    const i = img.getBoundingClientRect();
    return { bw: b.width, bh: b.height, iw: i.width, ih: i.height, padding: getComputedStyle(button).padding };
  });
  assert.equal(sizes.padding, "0px");
  assert.equal(sizes.iw, sizes.bw);
  assert.equal(sizes.ih, sizes.bh);
});

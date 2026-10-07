// The in-chat Doornail lab (admins only). Every /api/* route is spoofed in the browser.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, fakeAccounts, fulfill, launchBrowser, openPage, DOORNAIL_CRITERIA, DOORNAIL_DEFAULT, doornailQuestionsFor, scripted, startServer } from "./helpers.mjs";

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

// Signed in, with a fake /api/admin/doornail that remembers what's saved.
async function open({ user = ADMIN, saved = DOORNAIL_DEFAULT, device } = {}) {
  const accounts = fakeAccounts({ user });
  const doornail = { saved, puts: [] };
  session = await openPage(browser, server.baseURL, {
    device,
    setup: async (page) => {
      await accounts.install(page);
      await page.route("**/api/admin/doornail", (route) => {
        if (route.request().method() === "PUT") {
          const { instructions } = route.request().postDataJSON();
          doornail.puts.push(instructions);
          doornail.saved = instructions ?? DOORNAIL_DEFAULT;
        }
        return fulfill(route, 200, { instructions: doornail.saved, default: DOORNAIL_DEFAULT, isDefault: doornail.saved === DOORNAIL_DEFAULT, questions: doornailQuestionsFor(doornail.saved) });
      });
    },
  });
  return { page: session.page, doornail };
}

async function ask(page, question) {
  await page.fill("#input", question);
  await page.click("#send");
  await page.waitForFunction(() => !document.querySelector(".msg-jev.typing") && !document.querySelector("#send.stop"), null, T);
}

test("only admins get the Lab button", async () => {
  const { page } = await open({ user: { email: "friend@example.com", name: "Friend", picture: null, role: "user" } });
  await page.locator("#account-btn").waitFor(T);
  assert.ok(await page.locator("#doornail-lab-toggle").isHidden());
});

test("opening the lab switches to Doornail and shows the saved instructions", async () => {
  const { page } = await open({ saved: "Saved prompt." });
  await page.locator("#doornail-lab-toggle").click();
  await page.locator("#doornail-lab").waitFor({ state: "visible", ...T });
  assert.equal(await page.locator('.level-option[data-level="doornail"]').getAttribute("aria-checked"), "true");
  await page.waitForFunction(() => document.getElementById("doornail-lab-text").value === "Saved prompt.", null, T);
  assert.equal(await page.locator("#doornail-lab-state").textContent(), "Saved for everyone");
  assert.ok(await page.locator("#doornail-lab-save").isDisabled(), "nothing to save yet");
});

test("edits apply to my next Doornail answer right away, without saving", async () => {
  const { page, doornail } = await open();
  await page.locator("#doornail-lab-toggle").click();
  await page.waitForFunction((d) => document.getElementById("doornail-lab-text").value === d, DOORNAIL_DEFAULT, T);
  await page.fill("#doornail-lab-text", "Answer like a pirate.");
  assert.equal(await page.locator("#doornail-lab-state").textContent(), "Your edits (only you)");

  const fake = scripted("Arr");
  await page.route("**/api/next", fake);
  await ask(page, "Q");
  assert.ok(fake.requests.every((r) => r.level === "doornail" && r.doornailInstructions === "Answer like a pirate."));
  assert.deepEqual(doornail.puts, [], "not saved for everyone");

  await page.reload();
  await page.locator("#doornail-lab-toggle").click();
  await page.waitForFunction(() => document.getElementById("doornail-lab-text").value === "Answer like a pirate.", null, T);
  assert.equal(await page.locator("#doornail-lab-state").textContent(), "Your edits (only you)", "the draft survives a reload");
});

test("unchanged instructions aren't sent; Save, Discard and Reset do what they say", async () => {
  const { page, doornail } = await open();
  await page.locator("#doornail-lab-toggle").click();
  await page.waitForFunction((d) => document.getElementById("doornail-lab-text").value === d, DOORNAIL_DEFAULT, T);

  const fake = scripted("B");
  await page.route("**/api/next", fake);
  await ask(page, "Q");
  assert.ok(fake.requests.every((r) => !("doornailInstructions" in r)), "the saved version is the server's job");

  await page.fill("#doornail-lab-text", "Draft one.");
  await page.click("#doornail-lab-revert");
  assert.equal(await page.locator("#doornail-lab-text").inputValue(), DOORNAIL_DEFAULT);

  await page.fill("#doornail-lab-text", "For everyone.");
  await page.click("#doornail-lab-save");
  await page.waitForFunction(() => document.getElementById("doornail-lab-state").textContent === "Saved for everyone", null, T);
  assert.deepEqual(doornail.puts, ["For everyone."]);
  assert.match(await page.locator("#doornail-lab-status").textContent(), /Everyone's Doornail answers use this now/);

  await page.click("#doornail-lab-reset");
  await page.waitForFunction(() => document.getElementById("doornail-lab-state").textContent === "Default", null, T);
  assert.deepEqual(doornail.puts, ["For everyone.", null]);
  assert.equal(await page.locator("#doornail-lab-text").inputValue(), DOORNAIL_DEFAULT);
});

test("Stump answers never carry Doornail instructions", async () => {
  const { page } = await open();
  await page.locator("#doornail-lab-toggle").click();
  await page.waitForFunction((d) => document.getElementById("doornail-lab-text").value === d, DOORNAIL_DEFAULT, T);
  await page.fill("#doornail-lab-text", "Draft.");
  await page.locator('.level-option[data-level="stump"]').click();
  const fake = scripted("B");
  await page.route("**/api/next", fake);
  await ask(page, "Q");
  assert.ok(fake.requests.every((r) => r.level === "stump" && !("doornailInstructions" in r)));
});

test("the lab fits a phone, in both themes", async () => {
  for (const theme of ["modern", "y2k"]) {
    const { page } = await open({ device: "iPhone 13" });
    if (theme === "y2k") await page.evaluate(() => (document.documentElement.dataset.uiTheme = "y2k"));
    await page.locator("#doornail-lab-toggle").click();
    await page.locator("#doornail-lab").waitFor({ state: "visible", ...T });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, theme);
    await session.context.close();
    session.assertNoLeaks();
    session = null;
  }
});

test("Show full request swaps the editor for the exact questions JSON, with the live draft", async () => {
  const { page } = await open();
  await page.locator("#doornail-lab-toggle").click();
  await page.waitForFunction((d) => document.getElementById("doornail-lab-text").value === d, DOORNAIL_DEFAULT, T);
  await page.fill("#doornail-lab-text", "Spell like a pirate.");
  await page.click("#doornail-lab-view");
  assert.ok(await page.locator("#doornail-lab-text").isHidden());
  assert.equal(await page.locator("#doornail-lab-view").textContent(), "Edit instructions");
  const shown = JSON.parse(await page.locator("#doornail-lab-request-json").textContent());
  assert.deepEqual(shown, { next: { type: "choice", instructions: "Spell like a pirate.", criteria: DOORNAIL_CRITERIA } });

  await page.click("#doornail-lab-view");
  assert.ok(await page.locator("#doornail-lab-text").isVisible());
  assert.ok(await page.locator("#doornail-lab-request").isHidden());
  assert.equal(await page.locator("#doornail-lab-text").inputValue(), "Spell like a pirate.", "the draft is untouched");
});

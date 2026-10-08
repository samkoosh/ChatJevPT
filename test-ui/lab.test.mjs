// The in-chat lab for Doornail and Rock (admins only). Every /api/* route is spoofed in the browser.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, fakeAccounts, fulfill, launchBrowser, openPage, DOORNAIL_CRITERIA, DOORNAIL_DEFAULT, LAB_STATES, ROCK_CRITERIA, ROCK_DEFAULT, labFor, scripted, startServer } from "./helpers.mjs";

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

// Signed in, with a fake /api/admin/lab that remembers what's saved for each level.
async function open({ user = ADMIN, saved = DOORNAIL_DEFAULT, savedRock = ROCK_DEFAULT, device } = {}) {
  const accounts = fakeAccounts({ user });
  const doornail = { saved, puts: [] };
  const rock = { saved: savedRock, puts: [] };
  const labs = { doornail, rock };
  const defaults = { doornail: DOORNAIL_DEFAULT, rock: ROCK_DEFAULT };
  session = await openPage(browser, server.baseURL, {
    device,
    setup: async (page) => {
      await accounts.install(page);
      await page.route("**/api/admin/lab*", (route) => {
        let level = new URL(route.request().url()).searchParams.get("level");
        if (route.request().method() === "PUT") {
          const body = route.request().postDataJSON();
          level = body.level;
          labs[level].puts.push(body.instructions);
          labs[level].saved = body.instructions ?? defaults[level];
        }
        return fulfill(route, 200, labFor(level, labs[level].saved));
      });
    },
  });
  return { page: session.page, doornail, rock };
}

async function ask(page, question) {
  await page.fill("#input", question);
  await page.click("#send");
  await page.waitForFunction(() => !document.querySelector(".msg-jev.typing") && !document.querySelector("#send.stop"), null, T);
}

test("only admins get the Lab button", async () => {
  const { page } = await open({ user: { email: "friend@example.com", name: "Friend", picture: null, role: "user" } });
  await page.locator("#account-btn").waitFor(T);
  assert.ok(await page.locator("#lab-toggle").isHidden());
});

test("opening the lab switches to Doornail and shows the saved instructions", async () => {
  const { page } = await open({ saved: "Saved prompt." });
  await page.locator("#lab-toggle").click();
  await page.locator("#lab").waitFor({ state: "visible", ...T });
  assert.equal(await page.locator('.level-option[data-level="doornail"]').getAttribute("aria-checked"), "true");
  await page.waitForFunction(() => document.getElementById("lab-text").value === "Saved prompt.", null, T);
  assert.equal(await page.locator("#lab-badge").textContent(), "Saved for everyone");
  assert.ok(await page.locator("#lab-save").isDisabled(), "nothing to save yet");
});

test("edits apply to my next Doornail answer right away, without saving", async () => {
  const { page, doornail } = await open();
  await page.locator("#lab-toggle").click();
  await page.waitForFunction((d) => document.getElementById("lab-text").value === d, DOORNAIL_DEFAULT, T);
  await page.fill("#lab-text", "Answer like a pirate.");
  assert.equal(await page.locator("#lab-badge").textContent(), "Your edits (only you)");

  const fake = scripted("Arr");
  await page.route("**/api/next", fake);
  await ask(page, "Q");
  assert.ok(fake.requests.every((r) => r.level === "doornail" && r.labInstructions === "Answer like a pirate."));
  assert.deepEqual(doornail.puts, [], "not saved for everyone");

  await page.reload();
  await page.locator("#lab-toggle").click();
  await page.waitForFunction(() => document.getElementById("lab-text").value === "Answer like a pirate.", null, T);
  assert.equal(await page.locator("#lab-badge").textContent(), "Your edits (only you)", "the draft survives a reload");
});

test("unchanged instructions aren't sent; Save, Discard and Reset do what they say", async () => {
  const { page, doornail } = await open();
  await page.locator("#lab-toggle").click();
  await page.waitForFunction((d) => document.getElementById("lab-text").value === d, DOORNAIL_DEFAULT, T);

  const fake = scripted("B");
  await page.route("**/api/next", fake);
  await ask(page, "Q");
  assert.ok(fake.requests.every((r) => !("labInstructions" in r)), "the saved version is the server's job");

  await page.fill("#lab-text", "Draft one.");
  await page.click("#lab-revert");
  assert.equal(await page.locator("#lab-text").inputValue(), DOORNAIL_DEFAULT);

  await page.fill("#lab-text", "For everyone.");
  await page.click("#lab-save");
  await page.waitForFunction(() => document.getElementById("lab-badge").textContent === "Saved for everyone", null, T);
  assert.deepEqual(doornail.puts, ["For everyone."]);
  assert.match(await page.locator("#lab-status").textContent(), /Everyone's Doornail answers use this now/);

  await page.click("#lab-reset");
  await page.waitForFunction(() => document.getElementById("lab-badge").textContent === "Default", null, T);
  assert.deepEqual(doornail.puts, ["For everyone.", null]);
  assert.equal(await page.locator("#lab-text").inputValue(), DOORNAIL_DEFAULT);
});

test("Stump answers never carry lab instructions", async () => {
  const { page } = await open();
  await page.locator("#lab-toggle").click();
  await page.waitForFunction((d) => document.getElementById("lab-text").value === d, DOORNAIL_DEFAULT, T);
  await page.fill("#lab-text", "Draft.");
  await page.locator('.level-option[data-level="stump"]').click();
  const fake = scripted("B");
  await page.route("**/api/next", fake);
  await ask(page, "Q");
  assert.ok(fake.requests.every((r) => r.level === "stump" && !("labInstructions" in r)));
});

test("the lab fits a phone, in both themes", async () => {
  for (const theme of ["modern", "y2k"]) {
    const { page } = await open({ device: "iPhone 13" });
    if (theme === "y2k") await page.evaluate(() => (document.documentElement.dataset.uiTheme = "y2k"));
    await page.locator("#lab-toggle").click();
    await page.locator("#lab").waitFor({ state: "visible", ...T });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, theme);
    await session.context.close();
    session.assertNoLeaks();
    session = null;
  }
});

test("Show full request swaps the editor for the exact questions JSON, with the live draft", async () => {
  const { page } = await open();
  await page.locator("#lab-toggle").click();
  await page.waitForFunction((d) => document.getElementById("lab-text").value === d, DOORNAIL_DEFAULT, T);
  await page.fill("#lab-text", "Spell like a pirate.");
  await page.click("#lab-view");
  assert.ok(await page.locator("#lab-text").isHidden());
  assert.equal(await page.locator("#lab-view").textContent(), "Edit instructions");
  const shown = JSON.parse(await page.locator("#lab-request-json").textContent());
  assert.deepEqual(shown, { next: { type: "choice", instructions: "Spell like a pirate.", criteria: DOORNAIL_CRITERIA } });

  await page.click("#lab-view");
  assert.ok(await page.locator("#lab-text").isVisible());
  assert.ok(await page.locator("#lab-request").isHidden());
  assert.equal(await page.locator("#lab-text").inputValue(), "Spell like a pirate.", "the draft is untouched");
});

test("the Rock tab edits Rock's own instructions and switches to Rock", async () => {
  const { page, doornail, rock } = await open({ savedRock: "Saved rock." });
  await page.locator("#lab-toggle").click();
  await page.waitForFunction((d) => document.getElementById("lab-text").value === d, DOORNAIL_DEFAULT, T);
  await page.fill("#lab-text", "Doornail draft.");

  await page.click('.lab-level[data-level="rock"]');
  assert.equal(await page.locator('.lab-level[data-level="rock"]').getAttribute("aria-selected"), "true");
  assert.equal(await page.locator('.level-option[data-level="rock"]').getAttribute("aria-checked"), "true", "the lab's level is the one answering");
  await page.waitForFunction(() => document.getElementById("lab-text").value === "Saved rock.", null, T);
  assert.match(await page.locator(".lab-help").textContent(), /Rock's instructions/);
  assert.equal(await page.locator("#lab-badge").textContent(), "Saved for everyone");

  await page.fill("#lab-text", "Rock draft.");
  const fake = scripted("B");
  await page.route("**/api/next", fake);
  await ask(page, "Q");
  assert.ok(fake.requests.every((r) => r.level === "rock" && r.labInstructions === "Rock draft."));

  await page.click("#lab-save");
  await page.waitForFunction(() => document.getElementById("lab-badge").textContent === "Saved for everyone", null, T);
  assert.deepEqual(rock.puts, ["Rock draft."]);
  assert.deepEqual(doornail.puts, [], "Doornail's draft is still only a draft");
  assert.match(await page.locator("#lab-status").textContent(), /Everyone's Rock answers use this now/);

  await page.click('.lab-level[data-level="doornail"]');
  assert.equal(await page.locator("#lab-text").inputValue(), "Doornail draft.", "each level keeps its own draft");
  assert.equal(await page.locator('.level-option[data-level="doornail"]').getAttribute("aria-checked"), "true");

  // Picking Rock in the composer while the lab is open takes the lab with it.
  await page.locator('.level-option[data-level="rock"]').click();
  assert.equal(await page.locator('.lab-level[data-level="rock"]').getAttribute("aria-selected"), "true");
  assert.equal(await page.locator("#lab-text").inputValue(), "Rock draft.");
});

test("opening the lab while on Rock shows Rock", async () => {
  const { page } = await open();
  await page.locator('.level-option[data-level="rock"]').click();
  await page.locator("#lab-toggle").click();
  await page.waitForFunction((d) => document.getElementById("lab-text").value === d, ROCK_DEFAULT, T);
  assert.equal(await page.locator('.lab-level[data-level="rock"]').getAttribute("aria-selected"), "true");
});

test("Show state shows the example state read-only, for each level, and toggles back", async () => {
  const { page } = await open();
  await page.locator("#lab-toggle").click();
  await page.waitForFunction((d) => document.getElementById("lab-text").value === d, DOORNAIL_DEFAULT, T);
  await page.fill("#lab-text", "Draft.");
  await page.click("#lab-state-toggle");
  assert.ok(await page.locator("#lab-text").isHidden());
  assert.ok(await page.locator("#lab-request").isHidden(), "one view at a time");
  assert.equal(await page.locator("#lab-state-toggle").textContent(), "Edit instructions");
  assert.equal(await page.locator("#lab-state-toggle").getAttribute("aria-pressed"), "true");
  assert.deepEqual(JSON.parse(await page.locator("#lab-state-json").textContent()), LAB_STATES.doornail);
  assert.match(await page.locator("#lab-state-note").textContent(), /made-up data.*Not editable/);
  assert.equal(await page.locator("#lab-state-json").evaluate((e) => e.isContentEditable), false);

  await page.click('.lab-level[data-level="rock"]');
  await page.waitForFunction(() => document.getElementById("lab-state-json").textContent.includes("characters_remaining"), null, T);
  assert.deepEqual(JSON.parse(await page.locator("#lab-state-json").textContent()), LAB_STATES.rock);

  await page.click("#lab-view");
  assert.ok(await page.locator("#lab-state-view").isHidden());
  const shown = JSON.parse(await page.locator("#lab-request-json").textContent());
  assert.deepEqual(shown, { next: { type: "choice", instructions: ROCK_DEFAULT, criteria: ROCK_CRITERIA } });

  await page.click("#lab-view");
  assert.ok(await page.locator("#lab-text").isVisible());
  assert.equal(await page.locator("#lab-state-toggle").textContent(), "Show state");
  await page.click('.lab-level[data-level="doornail"]');
  assert.equal(await page.locator("#lab-text").inputValue(), "Draft.", "the draft is untouched");
});

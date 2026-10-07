// The in-chat Rock lab (admins only). Every /api/* route is spoofed in the browser.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, fakeAccounts, fulfill, launchBrowser, openPage, ROCK_DEFAULT, scripted, startServer } from "./helpers.mjs";

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

// Signed in, with a fake /api/admin/rock that remembers what's saved.
async function open({ user = ADMIN, saved = ROCK_DEFAULT, device } = {}) {
  const accounts = fakeAccounts({ user });
  const rock = { saved, puts: [] };
  session = await openPage(browser, server.baseURL, {
    device,
    setup: async (page) => {
      await accounts.install(page);
      await page.route("**/api/admin/rock", (route) => {
        if (route.request().method() === "PUT") {
          const { instructions } = route.request().postDataJSON();
          rock.puts.push(instructions);
          rock.saved = instructions ?? ROCK_DEFAULT;
        }
        return fulfill(route, 200, { instructions: rock.saved, default: ROCK_DEFAULT, isDefault: rock.saved === ROCK_DEFAULT });
      });
    },
  });
  return { page: session.page, rock };
}

async function ask(page, question) {
  await page.fill("#input", question);
  await page.click("#send");
  await page.waitForFunction(() => !document.querySelector(".msg-jev.typing") && !document.querySelector("#send.stop"), null, T);
}

test("only admins get the Lab button", async () => {
  const { page } = await open({ user: { email: "friend@example.com", name: "Friend", picture: null, role: "user" } });
  await page.locator("#account-btn").waitFor(T);
  assert.ok(await page.locator("#rock-lab-toggle").isHidden());
});

test("opening the lab switches to Rock and shows the saved instructions", async () => {
  const { page } = await open({ saved: "Saved prompt." });
  await page.locator("#rock-lab-toggle").click();
  await page.locator("#rock-lab").waitFor({ state: "visible", ...T });
  assert.equal(await page.locator('.level-option[data-level="rock"]').getAttribute("aria-checked"), "true");
  await page.waitForFunction(() => document.getElementById("rock-lab-text").value === "Saved prompt.", null, T);
  assert.equal(await page.locator("#rock-lab-state").textContent(), "Saved for everyone");
  assert.ok(await page.locator("#rock-lab-save").isDisabled(), "nothing to save yet");
});

test("edits apply to my next Rock answer right away, without saving", async () => {
  const { page, rock } = await open();
  await page.locator("#rock-lab-toggle").click();
  await page.waitForFunction((d) => document.getElementById("rock-lab-text").value === d, ROCK_DEFAULT, T);
  await page.fill("#rock-lab-text", "Answer like a pirate.");
  assert.equal(await page.locator("#rock-lab-state").textContent(), "Your edits (only you)");

  const fake = scripted("Arr");
  await page.route("**/api/next", fake);
  await ask(page, "Q");
  assert.ok(fake.requests.every((r) => r.level === "rock" && r.rockInstructions === "Answer like a pirate."));
  assert.deepEqual(rock.puts, [], "not saved for everyone");

  await page.reload();
  await page.locator("#rock-lab-toggle").click();
  await page.waitForFunction(() => document.getElementById("rock-lab-text").value === "Answer like a pirate.", null, T);
  assert.equal(await page.locator("#rock-lab-state").textContent(), "Your edits (only you)", "the draft survives a reload");
});

test("unchanged instructions aren't sent; Save, Discard and Reset do what they say", async () => {
  const { page, rock } = await open();
  await page.locator("#rock-lab-toggle").click();
  await page.waitForFunction((d) => document.getElementById("rock-lab-text").value === d, ROCK_DEFAULT, T);

  const fake = scripted("B");
  await page.route("**/api/next", fake);
  await ask(page, "Q");
  assert.ok(fake.requests.every((r) => !("rockInstructions" in r)), "the saved version is the server's job");

  await page.fill("#rock-lab-text", "Draft one.");
  await page.click("#rock-lab-revert");
  assert.equal(await page.locator("#rock-lab-text").inputValue(), ROCK_DEFAULT);

  await page.fill("#rock-lab-text", "For everyone.");
  await page.click("#rock-lab-save");
  await page.waitForFunction(() => document.getElementById("rock-lab-state").textContent === "Saved for everyone", null, T);
  assert.deepEqual(rock.puts, ["For everyone."]);
  assert.match(await page.locator("#rock-lab-status").textContent(), /Everyone's Rock answers use this now/);

  await page.click("#rock-lab-reset");
  await page.waitForFunction(() => document.getElementById("rock-lab-state").textContent === "Default", null, T);
  assert.deepEqual(rock.puts, ["For everyone.", null]);
  assert.equal(await page.locator("#rock-lab-text").inputValue(), ROCK_DEFAULT);
});

test("Stump answers never carry Rock instructions", async () => {
  const { page } = await open();
  await page.locator("#rock-lab-toggle").click();
  await page.waitForFunction((d) => document.getElementById("rock-lab-text").value === d, ROCK_DEFAULT, T);
  await page.fill("#rock-lab-text", "Draft.");
  await page.locator('.level-option[data-level="stump"]').click();
  const fake = scripted("B");
  await page.route("**/api/next", fake);
  await ask(page, "Q");
  assert.ok(fake.requests.every((r) => r.level === "stump" && !("rockInstructions" in r)));
});

test("the lab fits a phone, in both themes", async () => {
  for (const theme of ["modern", "y2k"]) {
    const { page } = await open({ device: "iPhone 13" });
    if (theme === "y2k") await page.evaluate(() => (document.documentElement.dataset.uiTheme = "y2k"));
    await page.locator("#rock-lab-toggle").click();
    await page.locator("#rock-lab").waitFor({ state: "visible", ...T });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, theme);
    await session.context.close();
    session.assertNoLeaks();
    session = null;
  }
});

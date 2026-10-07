// Browser UI tests for accounts: sign-in, the avatar menu, saved chats, budgets and the admin page.
// Every /api/* route is a fake (see fakeAccounts in helpers.mjs); Google's script is a stub.
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN,
  failing,
  FAKE_CREDENTIAL,
  fakeAccounts,
  fulfill,
  launchBrowser,
  openPage,
  rated,
  scripted,
  startServer,
} from "./helpers.mjs";

const T = { timeout: 5_000 };
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

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

// Opens the app with a fake accounts backend; `routes(page)` adds more fakes before load.
async function open(accounts, { routes, ...opts } = {}) {
  session = await openPage(browser, server.baseURL, {
    ...opts,
    setup: async (page) => {
      await accounts.install(page);
      await routes?.(page);
    },
  });
  return session.page;
}

async function waitAnswered(page, count = 1) {
  await page.waitForFunction(
    (n) => document.querySelectorAll(".msg-jev").length === n && !document.querySelector(".msg-jev.typing") && !document.querySelector("#send.stop"),
    count,
    T,
  );
}

async function ask(page, question) {
  await page.fill("#input", question);
  await page.click("#send");
}

const FIVE = Array.from({ length: 5 }, (_, i) => ({
  id: `chat-${i + 1}`,
  title: `Chat number ${i + 1}`,
  updatedAt: minutesAgo(i * 90 + 5),
  turns: [],
}));

describe("signed out", () => {
  test("shows the sign-in card with Google's button instead of the composer, and posts the credential", async () => {
    const accounts = fakeAccounts({ user: null });
    const page = await open(accounts);
    const card = page.locator(".signin-card");
    await card.waitFor(T);
    assert.ok(await page.locator(".composer-wrap").isHidden(), "composer hidden");
    assert.ok(await page.locator("#sidebar").isHidden());
    assert.ok(await page.locator("#account").isHidden());

    await page.locator(".fake-gsi").waitFor(T);
    const calls = await page.evaluate(() => window.gisCalls);
    assert.deepEqual(calls[0], ["initialize", { client_id: "test-client" }]);
    assert.equal(calls[1][0], "renderButton");
    assert.equal(calls[1][1].theme, "filled_black");
    assert.equal(calls[1][1].shape, "pill");

    await page.click(".fake-gsi");
    await page.locator("#account").waitFor({ state: "visible", ...T });
    const post = accounts.log.find((l) => l.call === "POST /api/auth/google");
    assert.deepEqual(post.body, { credential: FAKE_CREDENTIAL });
    assert.equal(post.headers["content-type"], "application/json");
    assert.ok(await card.isHidden(), "card gone");
    assert.ok(await page.locator(".composer-wrap").isVisible(), "composer back");
    assert.ok(await page.locator("#sidebar").isVisible());
    assert.ok(accounts.calls().includes("GET /api/chats"), "chats loaded after sign-in");
  });

  test("not_invited says the request was sent", async () => {
    const accounts = fakeAccounts({
      user: null,
      signIn: { status: 403, body: { error: "You're not on the list yet. Ask the owner for access.", code: "not_invited" } },
    });
    const page = await open(accounts);
    await page.click(".fake-gsi", T);
    const message = page.locator("#signin-message");
    await message.waitFor({ state: "visible", ...T });
    assert.equal(await message.locator("strong").textContent(), "Request sent — the owner will let you in");
    assert.match(await message.textContent(), /not on the list yet/);
    assert.ok(await page.locator(".composer-wrap").isHidden());
  });

  test("a 401 mid-chat brings the sign-in card back", async () => {
    const accounts = fakeAccounts();
    const page = await open(accounts, {
      routes: (p) => p.route("**/api/next", failing(401, { error: "Sign in to keep going.", code: "signed_out" })),
    });
    await page.locator("#account").waitFor({ state: "visible", ...T });
    await ask(page, "Hello?");
    await page.locator(".signin-card").waitFor({ state: "visible", ...T });
    assert.match(await page.locator("#signin-message").textContent(), /Sign in again/);
    assert.ok(await page.locator(".composer-wrap").isHidden());
    assert.ok(await page.locator("#account").isHidden());
  });
});

describe("avatar menu", () => {
  test("shows email, usage against the budget, and signs out", async () => {
    const accounts = fakeAccounts();
    const page = await open(accounts);
    const avatar = page.locator("#account-btn");
    await avatar.waitFor(T);
    assert.equal(await avatar.textContent(), "F", "initial when there's no picture");
    await avatar.click();
    const menu = page.locator("#account-menu");
    await menu.waitFor({ state: "visible", ...T });
    assert.equal(await menu.locator("#account-email").textContent(), "friend@example.com");
    assert.equal(await menu.locator("#usage-text").textContent(), "Usage: $0.12 of $1.00 this month");
    assert.ok(await menu.locator("#usage-bar").isVisible());
    assert.equal(await page.locator("#usage-fill").evaluate((n) => n.style.width), "12%");
    assert.ok(await page.locator("#admin-link").isHidden(), "no Admin link for users");
    assert.ok(await page.locator("#cost-meter").isHidden(), "chat cost meter still there, hidden until used");

    await menu.locator("#sign-out").click();
    await page.locator(".signin-card").waitFor({ state: "visible", ...T });
    assert.ok(accounts.calls().includes("POST /api/logout"));
    assert.ok(await page.locator("#account").isHidden());
  });

  test("admins see the Admin link and 'no limit' instead of a bar", async () => {
    const accounts = fakeAccounts({ user: { ...ADMIN, picture: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" } });
    const page = await open(accounts);
    await page.locator("#account-btn img").waitFor(T);
    await page.click("#account-btn");
    await page.locator("#account-menu").waitFor({ state: "visible", ...T });
    assert.equal(await page.locator("#usage-text").textContent(), "Usage: $0.12 this month · no limit");
    assert.ok(await page.locator("#usage-bar").isHidden());
    assert.ok(await page.locator("#admin-link").isVisible());
    assert.equal(await page.locator("#admin-link").getAttribute("href"), "/admin.html");
  });
});

describe("chats sidebar", () => {
  test("lists chats; switching loads their turns with rating chips", async () => {
    const chats = [
      {
        id: "chat-a",
        title: "Capital of France",
        updatedAt: minutesAgo(3),
        turns: [
          { question: "Capital of France?", answer: "Paris", label: "Perfect", score: 3.9, tokens: 700, cost: 0.0007 },
          { question: "And Germany?", answer: "Berlin", label: "Good", score: 3.1 },
        ],
      },
      { id: "chat-b", title: "Sky", updatedAt: minutesAgo(180), turns: [{ question: "Why is the sky blue?", answer: "Light", label: "Bad", score: 1 }] },
    ];
    const accounts = fakeAccounts({ chats });
    const page = await open(accounts);
    const items = page.locator(".chat-item");
    await items.first().waitFor(T);
    assert.deepEqual(await page.locator(".chat-title").allTextContents(), ["Capital of France", "Sky"]);
    assert.deepEqual(await page.locator(".chat-time").allTextContents(), ["3m ago", "3h ago"]);
    assert.equal(await page.locator("#chat-count").textContent(), "2/5");

    await items.nth(0).locator(".chat-open").click();
    await page.locator(".msg-jev").nth(1).waitFor(T);
    assert.deepEqual(await page.locator(".msg-user").allTextContents(), ["Capital of France?", "And Germany?"]);
    assert.deepEqual(await page.locator(".msg-jev .answer").allTextContents(), ["Paris", "Berlin"]);
    assert.deepEqual(await page.locator(".msg-jev .rating").allTextContents(), ["Perfect", "Good"]);
    assert.match(await page.locator(".msg-jev .meta").first().innerText(), /5 characters/);
    assert.ok(await items.nth(0).evaluate((n) => n.classList.contains("active")));
    assert.match(await page.locator("#cost-meter").textContent(), /700 tokens/);

    await items.nth(1).locator(".chat-open").click();
    await page.waitForFunction(() => document.querySelector(".msg-user")?.textContent === "Why is the sky blue?", null, T);
    assert.equal(await page.locator(".msg-jev").count(), 1);
    assert.equal(await page.locator(".rating").textContent(), "Bad");
    assert.ok(accounts.calls().includes("GET /api/chats/chat-a") && accounts.calls().includes("GET /api/chats/chat-b"));
  });

  test("New chat is disabled at 5 chats, with a tooltip", async () => {
    const accounts = fakeAccounts({ chats: FIVE });
    const page = await open(accounts);
    await page.locator(".chat-item").nth(4).waitFor(T);
    assert.equal(await page.locator("#chat-count").textContent(), "5/5");
    assert.ok(await page.locator("#sidebar-new").isDisabled());
    assert.equal(await page.locator("#sidebar-new-wrap").getAttribute("title"), "You can keep up to 5 chats. Delete one to start another.");
  });

  test("delete asks first; cancelling keeps the chat", async () => {
    const accounts = fakeAccounts({ chats: FIVE });
    const page = await open(accounts);
    await page.locator(".chat-item").nth(4).waitFor(T);

    page.confirmAnswer = false;
    await page.locator(".chat-item").nth(1).hover();
    await page.locator(".chat-item").nth(1).locator(".chat-delete").click();
    await page.waitForTimeout(100);
    assert.equal(await page.locator(".chat-item").count(), 5);
    assert.ok(!accounts.calls().some((c) => c.startsWith("DELETE")));

    page.confirmAnswer = true;
    await page.locator(".chat-item").nth(1).hover();
    await page.locator(".chat-item").nth(1).locator(".chat-delete").click();
    await page.waitForFunction(() => document.querySelectorAll(".chat-item").length === 4, null, T);
    assert.ok(accounts.calls().includes("DELETE /api/chats/chat-2"));
    assert.ok(!(await page.locator(".chat-title").allTextContents()).includes("Chat number 2"));
    assert.ok(await page.locator("#sidebar-new").isEnabled(), "room for a new chat again");
  });

  test("asking creates the chat lazily, sends chatId, then saves the turn and then the rating", async () => {
    const accounts = fakeAccounts();
    const next = scripted("Paris");
    const rate = rated({ label: "Perfect", score: 3.8, tokens: 200, cost: 0.0002 });
    const page = await open(accounts, {
      routes: async (p) => {
        await p.route("**/api/next", next);
        await p.route("**/api/rate", rate);
      },
    });
    await page.locator("#account").waitFor({ state: "visible", ...T });
    assert.ok(!accounts.calls().includes("POST /api/chats"), "nothing created before the first question");

    await ask(page, "Capital of France?");
    await waitAnswered(page);
    await page.locator(".rating-perfect").waitFor(T);
    await page.waitForFunction(() => document.querySelector(".chat-title")?.textContent === "Capital of France?", null, T);
    const waitForRatingPut = async () => {
      for (let i = 0; i < 50 && !accounts.log.some((l) => l.body?.lastTurnRating); i++) await page.waitForTimeout(20);
    };
    await waitForRatingPut();

    const writes = accounts.log.filter((l) => l.call !== "GET /api/me" && l.call !== "GET /api/chats");
    assert.deepEqual(writes.map((l) => l.call), ["POST /api/chats", "PUT /api/chats/new-1", "PUT /api/chats/new-1"]);
    assert.ok(next.requests.every((r) => r.chatId === "new-1" && !("history" in r)), "chatId instead of history");
    assert.deepEqual(rate.requests[0], { question: "Capital of France?", answer: "Paris", chatId: "new-1" });

    const [, turnPut, ratingPut] = writes;
    assert.deepEqual(Object.keys(turnPut.body), ["turn"]);
    assert.equal(turnPut.body.turn.question, "Capital of France?");
    assert.equal(turnPut.body.turn.answer, "Paris");
    assert.equal(turnPut.body.turn.tokens, 600);
    assert.equal(ratingPut.body.lastTurnRating.label, "Perfect");
    assert.equal(ratingPut.body.lastTurnRating.score, 3.8);

    // The follow-up goes to the same chat.
    await ask(page, "And Germany?");
    await waitAnswered(page, 2);
    assert.equal(accounts.calls().filter((c) => c === "POST /api/chats").length, 1);
    assert.equal(next.requests.at(-1).chatId, "new-1");
  });

  test("budget_exhausted shows the monthly budget notice", async () => {
    const accounts = fakeAccounts();
    const message = "You've used this month's ChatJevPT budget ($1.00). It resets on November 1.";
    const page = await open(accounts, {
      routes: (p) => p.route("**/api/next", failing(402, { error: message, code: "budget_exhausted" })),
    });
    await page.locator("#account").waitFor({ state: "visible", ...T });
    await ask(page, "Anything");
    await waitAnswered(page);
    const notice = page.locator(".msg-jev .notice");
    await notice.waitFor(T);
    assert.equal(await notice.locator("strong").textContent(), "Monthly budget used");
    assert.equal(await notice.locator("p").textContent(), message);
    assert.equal(await page.locator(".error").count(), 0);
  });
});

describe("mobile (iPhone 13)", () => {
  test("the chats sidebar is a drawer behind the hamburger, with no horizontal overflow at 390px", async () => {
    const accounts = fakeAccounts({ chats: FIVE.map((c, i) => (i ? c : { ...c, title: "A very long chat title that goes on and on well past the drawer's width", turns: [{ question: "Q", answer: "A" }] })) });
    const page = await open(accounts, { device: "iPhone 13" });
    assert.equal(page.viewportSize().width, 390);
    await page.locator("#sidebar-toggle").waitFor({ state: "visible", ...T });
    const sidebar = page.locator("#sidebar");
    assert.ok(!(await sidebar.isVisible()) || (await sidebar.boundingBox()).x + (await sidebar.boundingBox()).width <= 0, "drawer closed");
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(await overflow(), 0, "no horizontal scroll with the drawer closed");

    await page.locator("#sidebar-toggle").tap();
    await page.locator("#sidebar-scrim").waitFor({ state: "visible", ...T });
    await page.waitForFunction(() => document.getElementById("sidebar").getBoundingClientRect().left >= 0, null, T);
    assert.equal(await overflow(), 0, "no horizontal scroll with the drawer open");
    const box = await sidebar.boundingBox();
    assert.ok(box.x + box.width <= 390, "drawer fits the screen");

    await page.locator(".chat-item").first().locator(".chat-open").tap();
    await page.locator("#sidebar-scrim").waitFor({ state: "hidden", ...T });
    await page.locator(".msg-user").waitFor(T);
    assert.equal(await overflow(), 0);

    await page.locator("#account-btn").tap();
    await page.locator("#account-menu").waitFor({ state: "visible", ...T });
    const menu = await page.locator("#account-menu").boundingBox();
    assert.ok(menu.x >= 0 && menu.x + menu.width <= 390, "account menu fits");
    assert.equal(await overflow(), 0);
  });
});

describe("admin page", () => {
  const LISTING = {
    users: [
      { email: "owner@example.com", name: "Owner", role: "admin", status: "allowed", monthCostMicros: 2_500_000, monthTokens: 61000, budgetMicros: null, lastSeenAt: minutesAgo(1) },
      { email: "friend@example.com", name: "Friend", role: "user", status: "allowed", monthCostMicros: 120_000, monthTokens: 3400, budgetMicros: 1_000_000, lastSeenAt: minutesAgo(120) },
      { email: "gone@example.com", name: null, role: "user", status: "blocked", monthCostMicros: 0, monthTokens: 0, budgetMicros: 1_000_000, lastSeenAt: null },
    ],
    requests: [{ email: "new@example.com", name: "Newbie", requestedAt: minutesAgo(10) }],
    defaultBudgetMicros: 1_000_000,
  };

  async function openAdmin({ device } = {}) {
    const accounts = fakeAccounts({ user: ADMIN });
    const writes = [];
    const page = await open(accounts, {
      device,
      path: "/admin.html",
      routes: (p) =>
        p.route("**/api/admin/users**", (route) => {
          const r = route.request();
          if (r.method() !== "GET") writes.push({ method: r.method(), url: new URL(r.url()).pathname + new URL(r.url()).search, body: r.postData() ? r.postDataJSON() : undefined, type: r.headers()["content-type"] });
          return fulfill(route, 200, LISTING);
        }),
    });
    await page.locator(".admin-user").first().waitFor(T);
    return { page, writes };
  }

  test("shows people with spend, budget or 'no limit', tokens and last seen", async () => {
    const { page } = await openAdmin();
    const rows = page.locator(".admin-user");
    assert.equal(await rows.count(), 3);
    const owner = rows.nth(0);
    assert.match(await owner.innerText(), /owner@example\.com/);
    assert.match(await owner.innerText(), /\$2\.50/);
    assert.match(await owner.innerText(), /no limit/);
    assert.equal(await owner.locator(".budget-input").count(), 0);
    const friend = rows.nth(1);
    assert.equal(await friend.locator(".budget-input").inputValue(), "1.00");
    assert.match(await friend.innerText(), /\$0\.12/);
    assert.match(await friend.innerText(), /3\.4k/);
    assert.match(await friend.innerText(), /2h ago/);
    assert.match(await rows.nth(2).innerText(), /Blocked/);
    assert.equal(await rows.nth(2).locator("button", { hasText: "Unblock" }).count(), 1);
    assert.equal(await page.locator(".admin-request").count(), 1);
  });

  test("approve, edit a budget and block send the right requests", async () => {
    const { page, writes } = await openAdmin();
    await page.locator(".admin-request button", { hasText: "Approve" }).click();
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("can sign in"), null, T);

    const budget = page.locator(".admin-user").nth(1).locator(".budget-input");
    await budget.fill("2.5");
    await budget.press("Enter");
    await budget.blur();
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("Budget"), null, T);

    await page.locator(".admin-user").nth(1).locator("button", { hasText: "Block" }).click();
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("blocked"), null, T);

    await page.locator(".admin-user").nth(2).locator("button", { hasText: "Unblock" }).click();
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("again"), null, T);

    await page.fill("#add-email", "Pal@Example.com");
    await page.fill("#add-budget", "3");
    await page.click("#add-form button[type=submit]");
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("added"), null, T);

    assert.deepEqual(
      writes.map(({ method, url, body }) => [method, url, body]),
      [
        ["POST", "/api/admin/users", { email: "new@example.com" }],
        ["POST", "/api/admin/users", { email: "friend@example.com", budgetUsd: 2.5 }],
        ["DELETE", "/api/admin/users?email=friend%40example.com", undefined],
        ["POST", "/api/admin/users", { email: "gone@example.com", status: "allowed" }],
        ["POST", "/api/admin/users", { email: "pal@example.com", budgetUsd: 3 }],
      ],
    );
    assert.ok(writes.every((w) => w.type === "application/json"));
  });

  test("non-admins are turned away", async () => {
    session = await openPage(browser, server.baseURL, { path: "/admin.html", setup: (p) => fakeAccounts().install(p) });
    const page = session.page;
    await page.locator("#gate").waitFor({ state: "visible", ...T });
    assert.match(await page.locator("#gate").textContent(), /Admins only/);
    assert.ok(await page.locator("#panel").isHidden());
  });

  test("below 600px the table becomes cards that fit the screen", async () => {
    const { page } = await openAdmin({ device: "iPhone 13" });
    assert.ok(await page.locator(".admin-users thead").isHidden());
    const row = await page.locator(".admin-user").nth(1).boundingBox();
    assert.ok(row.width <= 390);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  });
});

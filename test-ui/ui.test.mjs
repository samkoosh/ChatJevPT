// Browser UI tests. Run: CHROMIUM_PATH=/path/to/chrome npm run test:ui
// Every POST /api/next is fulfilled by a scripted fake; none reach Jev.
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  byQuestion,
  COST_PER_CALL,
  deferred,
  failing,
  launchBrowser,
  openPage,
  rated,
  scripted,
  startServer,
  TOKENS_PER_CALL,
} from "./helpers.mjs";

const T = { timeout: 5_000 };

let server;
let browser;
let session; // the current test's { context, page, leaks, assertNoLeaks }

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

// Waits until `count` Jev messages exist and all have finished typing.
async function waitAnswered(page, count = 1) {
  await page.waitForFunction(
    (n) =>
      document.querySelectorAll(".msg-jev").length === n &&
      !document.querySelector(".msg-jev.typing") &&
      !document.querySelector("#send.stop"),
    count,
    T,
  );
}

async function askViaUI(page, question) {
  await page.fill("#input", question);
  await page.click("#send");
}

const answerText = (page, nth = 0) =>
  page.locator(".msg-jev .answer").nth(nth).evaluate((n) => [...n.querySelectorAll(".ch")].map((c) => c.textContent).join(""));

describe("desktop", () => {
  test("empty state shows hero and suggestions; send is disabled until text is typed", async () => {
    const page = await open();
    await page.route("**/api/next", scripted("x"));
    assert.equal(await page.locator("#main").getAttribute("class"), "empty");
    assert.ok(await page.locator("#hero").isVisible());
    assert.ok(await page.locator("#suggestions").isVisible());
    assert.equal(await page.locator("#suggestions button").count(), 4);
    assert.equal(await page.locator("#thread > *").count(), 0);
    assert.ok(await page.locator("#send").isDisabled());

    await page.fill("#input", "   ");
    assert.ok(await page.locator("#send").isDisabled(), "whitespace only keeps send disabled");
    await page.fill("#input", "Hello");
    assert.ok(await page.locator("#send").isEnabled());
    await page.fill("#input", "");
    assert.ok(await page.locator("#send").isDisabled());
  });

  test("asking a question types out the spoofed answer and shows meta", async () => {
    const page = await open();
    const fake = scripted("Paris");
    await page.route("**/api/next", fake);
    await askViaUI(page, "What is the capital of France?");

    await waitAnswered(page);
    assert.equal(await page.locator(".msg-user").textContent(), "What is the capital of France?");
    assert.equal(await answerText(page), "Paris");
    assert.equal(await page.locator(".answer .ch").count(), 5);
    assert.equal(await page.locator(".caret").count(), 0, "caret removed");
    assert.equal(await page.locator(".thinking").count(), 0, "thinking text removed");
    assert.equal(await page.locator(".msg-jev").getAttribute("class"), "msg-jev");
    assert.ok(!(await page.locator("#main").getAttribute("class"))?.includes("empty"));
    assert.ok(!(await page.locator("#hero").isVisible()), "hero hidden once chatting");

    const meta = await page.locator(".meta").innerText();
    assert.match(meta, /\b5 characters/, "finished answers show just the count");
    assert.doesNotMatch(meta, /\/200|Jev call/);
    assert.equal(await page.locator(".meta .bar").count(), 0, "progress bar gone once finished");
    assert.deepEqual(await page.locator(".meta .act").allInnerTexts(), ["Copy", "Retry"]);

    // One request per character plus the END call; answer grows each time.
    assert.deepEqual(
      fake.requests.map((r) => r.answer),
      ["", "P", "Pa", "Par", "Pari", "Paris"],
    );
    assert.ok(fake.requests.every((r) => r.question === "What is the capital of France?"));
    assert.equal(await page.locator("#input").inputValue(), "", "input cleared");
  });

  test("Retry asks the same question again", async () => {
    const page = await open();
    const fake = scripted("Hi");
    await page.route("**/api/next", fake);
    await askViaUI(page, "Greet me");
    await waitAnswered(page);
    await page.locator(".meta .act", { hasText: "Retry" }).click();
    await waitAnswered(page, 2);
    assert.deepEqual(await page.locator(".msg-user").allTextContents(), ["Greet me", "Greet me"]);
    assert.equal(await answerText(page, 1), "Hi");
  });

  test("follow-up sends history; New chat resets thread, history and cost meter", async () => {
    const page = await open();
    const first = scripted("Paris");
    const second = scripted("Lyon");
    const third = scripted("Rome");
    await page.route(
      "**/api/next",
      byQuestion({ "Capital of France?": first, "Second city?": second, "Capital of Italy?": third }),
    );

    await askViaUI(page, "Capital of France?");
    await waitAnswered(page);
    assert.ok(first.requests.every((r) => Array.isArray(r.history) && r.history.length === 0));

    await askViaUI(page, "Second city?");
    await waitAnswered(page, 2);
    assert.ok(second.requests.length > 0);
    for (const r of second.requests) {
      assert.deepEqual(r.history, [{ question: "Capital of France?", answer: "Paris" }]);
    }
    assert.ok(await page.locator("#cost-meter").isVisible());

    await page.click("#new-chat");
    assert.equal(await page.locator("#thread > *").count(), 0);
    assert.equal(await page.locator("#main").getAttribute("class"), "empty");
    assert.ok(await page.locator("#hero").isVisible());
    assert.ok(await page.locator("#suggestions").isVisible());
    assert.ok(await page.locator("#cost-meter").isHidden());

    await askViaUI(page, "Capital of Italy?");
    await waitAnswered(page);
    assert.ok(third.requests.every((r) => r.history.length === 0), "history cleared by New chat");
  });

  test("second New chat button also resets", async () => {
    const page = await open();
    await page.route("**/api/next", scripted("ok"));
    await askViaUI(page, "Hi");
    await waitAnswered(page);
    await page.click("#new-chat-2");
    assert.equal(await page.locator("#thread > *").count(), 0);
    assert.equal(await page.locator("#main").getAttribute("class"), "empty");
  });

  test("cost meter is hidden at start and accumulates across answers", async () => {
    const page = await open();
    await page.route("**/api/next", byQuestion({ One: scripted("Hi"), Two: scripted("Yo") }));
    assert.ok(await page.locator("#cost-meter").isHidden());

    await askViaUI(page, "One");
    await waitAnswered(page);
    // "Hi" = 2 chars + END = 3 calls.
    const meter = page.locator("#cost-meter");
    assert.ok(await meter.isVisible());
    assert.equal(await meter.locator("b").textContent(), `$${(3 * COST_PER_CALL).toFixed(4)}`);
    assert.match(await meter.textContent(), new RegExp(`${3 * TOKENS_PER_CALL} tokens`));

    await askViaUI(page, "Two");
    await waitAnswered(page, 2);
    assert.equal(await meter.locator("b").textContent(), `$${(6 * COST_PER_CALL).toFixed(4)}`);
    assert.match(await meter.textContent(), new RegExp(`${6 * TOKENS_PER_CALL} tokens`));
    // Per-answer cost in meta stays per answer.
    assert.match(await page.locator(".meta").nth(1).innerText(), /\$0\.0003/);
  });

  test("tooltip shows top picks, SPACE, and runoff ties", async () => {
    const page = await open();
    await page.route("**/api/next", scripted("ab cd", { overrides: { 3: { tied: 2, runoffs: 1, coinFlip: false } } }));
    await askViaUI(page, "Letters");
    await waitAnswered(page);

    const tooltip = page.locator("#tooltip");
    assert.ok(await tooltip.isHidden());
    const chars = page.locator(".answer .ch");

    await chars.nth(0).hover();
    await tooltip.waitFor({ state: "visible", ...T });
    assert.equal(await tooltip.locator("h4").textContent(), "Jev's top picks");
    assert.equal(await tooltip.locator(".row").count(), 3);
    assert.equal(await tooltip.locator(".row.picked").count(), 1);
    assert.match(await tooltip.locator(".row.picked").textContent(), /^a.*70\.0%$/);
    assert.ok(await chars.nth(0).evaluate((n) => n.classList.contains("active")));

    await chars.nth(2).hover(); // the space
    assert.equal(await chars.nth(2).getAttribute("data-pick"), "SPACE");
    assert.match(await tooltip.textContent(), /SPACE/);
    assert.match(await tooltip.locator(".row.picked").textContent(), /^SPACE/);

    await chars.nth(3).hover(); // the tied "c"
    assert.ok(await chars.nth(3).evaluate((n) => n.classList.contains("tied")));
    assert.equal(await tooltip.locator("h4").textContent(), "Jev's top picks · 2-way tie, runoff");

    // Moving the mouse off the letters hides it.
    await page.mouse.move(5, 790);
    await tooltip.waitFor({ state: "hidden", ...T });
  });

  test("coin-flip ties say coin flip", async () => {
    const page = await open();
    await page.route("**/api/next", scripted("xy", { overrides: { 1: { tied: 3, coinFlip: true } } }));
    await askViaUI(page, "Coin");
    await waitAnswered(page);
    await page.locator(".answer .ch").nth(1).hover();
    assert.equal(await page.locator("#tooltip h4").textContent(), "Jev's top picks · 3-way tie, coin flip");
  });

  test("Stop halts the answer early", async () => {
    const page = await open();
    const gate = deferred();
    const fake = scripted("Hello world", { gate: { 3: gate.promise } });
    await page.route("**/api/next", fake);
    await askViaUI(page, "Say hello");

    await page.waitForFunction(() => document.querySelectorAll(".answer .ch").length === 3, null, T);
    const send = page.locator("#send");
    assert.ok((await send.getAttribute("class")).includes("stop"));
    assert.equal(await send.getAttribute("aria-label"), "Stop");
    assert.ok(await send.isEnabled());
    assert.equal(await page.locator(".msg-jev.typing").count(), 1);
    assert.equal(await page.locator(".caret").count(), 1);

    await send.click();
    await waitAnswered(page);
    gate.resolve();

    assert.equal(await answerText(page), "Hel");
    assert.equal(await page.locator(".caret").count(), 0);
    assert.equal(await page.locator(".error").count(), 0, "abort is not an error");
    assert.match(await page.locator(".meta").innerText(), /\b3 characters/);
    assert.equal(await send.getAttribute("aria-label"), "Send");
    assert.ok(await send.isDisabled());
    // Nothing further was requested after the stop.
    await page.waitForTimeout(50);
    assert.equal(fake.requests.length, 4);
  });

  test("402 out_of_credits shows the credits notice", async () => {
    const page = await open();
    await page.route("**/api/next", failing(402, { error: "Jev is out of credits for today.", code: "out_of_credits" }));
    await askViaUI(page, "Anything");
    await waitAnswered(page);
    const notice = page.locator(".msg-jev .notice");
    assert.ok(await notice.isVisible());
    assert.equal(await notice.locator("strong").textContent(), "Out of Jev credits");
    assert.equal(await notice.locator("p").textContent(), "Jev is out of credits for today.");
    assert.equal(await page.locator(".error").count(), 0);
    assert.equal(await page.locator(".answer").count(), 0, "empty answer removed");
  });

  test("a generic 502 shows an error", async () => {
    const page = await open();
    await page.route("**/api/next", failing(502, { error: "Jev is unavailable" }));
    await askViaUI(page, "Anything");
    await waitAnswered(page);
    assert.equal(await page.locator(".msg-jev .error").textContent(), "Jev is unavailable");
    assert.equal(await page.locator(".notice").count(), 0);
  });

  test("an error mid-answer keeps the partial answer", async () => {
    const page = await open();
    const ok = scripted("Hey");
    await page.route("**/api/next", (route) => {
      const { answer } = route.request().postDataJSON();
      if (answer.length < 2) return ok(route);
      return failing(500, {})(route);
    });
    await askViaUI(page, "Partial");
    await waitAnswered(page);
    assert.equal(await answerText(page), "He");
    assert.equal(await page.locator(".error").textContent(), "Request failed (500)");
  });

  test("NEWLINE renders as a line break", async () => {
    const page = await open();
    await page.route("**/api/next", scripted("Hi\nthere"));
    await askViaUI(page, "Two lines");
    await waitAnswered(page);
    const answer = page.locator(".answer");
    assert.equal(await page.locator(".answer .ch").nth(2).getAttribute("data-pick"), "NEWLINE");
    assert.match(await answer.innerText(), /Hi\nthere/);
    const [first, after] = await Promise.all([
      page.locator(".answer .ch").nth(0).boundingBox(),
      page.locator(".answer .ch").nth(3).boundingBox(),
    ]);
    assert.ok(after.y > first.y + first.height / 2, `"t" (${after.y}) should be below "H" (${first.y})`);
  });

  test("clicking a suggestion chip asks that question", async () => {
    const page = await open();
    const fake = scripted("Paris");
    await page.route("**/api/next", fake);
    await page.locator("#suggestions button", { hasText: "What is the capital of France?" }).click();
    await waitAnswered(page);
    assert.equal(await page.locator(".msg-user").textContent(), "What is the capital of France?");
    assert.equal(fake.requests[0].question, "What is the capital of France?");
    assert.equal(await answerText(page), "Paris");
    assert.ok(await page.locator("#suggestions").isHidden());
  });

  test("Enter sends; Shift+Enter inserts a newline", async () => {
    const page = await open();
    const fake = scripted("ok");
    await page.route("**/api/next", fake);
    const input = page.locator("#input");
    await input.click();
    await input.type("line one");
    await input.press("Shift+Enter");
    await input.type("line two");
    assert.equal(await input.inputValue(), "line one\nline two");
    assert.equal(fake.requests.length, 0);
    assert.equal(await page.locator(".msg-user").count(), 0);

    await input.press("Enter");
    await waitAnswered(page);
    assert.equal(await page.locator(".msg-user").textContent(), "line one\nline two");
    assert.equal(fake.requests[0].question, "line one\nline two");
    assert.equal(await input.inputValue(), "");
  });
});

describe("answer row", () => {
  test("while typing: progress bar, X/200 characters and a Stop button that ends the answer", async () => {
    const page = await open();
    const gate = deferred();
    const fake = scripted("Hello world", { gate: { 4: gate.promise } });
    await page.route("**/api/next", fake);
    await askViaUI(page, "Say hello");
    await page.waitForFunction(() => document.querySelectorAll(".answer .ch").length === 4, null, T);

    const meta = page.locator(".meta");
    assert.equal(await meta.locator(".bar").count(), 1);
    assert.match(await meta.innerText(), /4\/200 characters/);
    assert.doesNotMatch(await meta.innerText(), /Jev call/);
    await meta.locator(".stop-answer").click();
    await waitAnswered(page);
    gate.resolve();

    assert.equal(await answerText(page), "Hell");
    assert.equal(await meta.locator(".stop-answer").count(), 0);
    assert.equal(await meta.locator(".bar").count(), 0);
    assert.match(await meta.innerText(), /\b4 characters/);
    await page.waitForTimeout(50);
    assert.equal(fake.requests.length, 5, "nothing requested after Stop");
  });

  test("a spicy END shows the 'Jev got too spicy' notice", async () => {
    const page = await open();
    await page.route("**/api/next", scripted("Music and", { overrides: { 9: { pick: "END", char: "", spicy: true } } }));
    await askViaUI(page, "Name three muppets.");
    await page.locator(".notice.spicy").waitFor(T);
    assert.match(await page.locator(".notice.spicy").innerText(), /Jev got too spicy/);
    assert.equal(await answerText(page), "Music and");
  });

  test("the tooltip says how many options passed screening", async () => {
    const page = await open();
    await page.route("**/api/next", scripted("Hi", { overrides: { 0: { screened: 3 }, 1: { screened: 1 } } }));
    await askViaUI(page, "Q");
    await waitAnswered(page);
    await page.locator(".answer .ch").nth(0).hover();
    await page.locator("#tooltip .screen-note").waitFor(T);
    assert.equal(await page.locator("#tooltip .screen-note").textContent(), "3 options passed screening");
    await page.locator(".answer .ch").nth(1).hover();
    await page.waitForFunction(() => document.querySelector("#tooltip .screen-note")?.textContent === "Only option to pass screening", null, T);
  });
});

describe("answer rating", () => {
  test("each finished answer gets Jev's rating, sent with the chat context", async () => {
    const page = await open();
    const gate = deferred();
    const rate = rated({ label: "Perfect", score: 3.8, tokens: 200, cost: 0.0002 }, { gate: gate.promise });
    await page.route("**/api/rate", rate);
    await page.route("**/api/next", byQuestion({ One: scripted("Paris"), Two: scripted("Berlin") }));

    await askViaUI(page, "One");
    await waitAnswered(page);
    const chip = page.locator(".msg-jev .rating").first();
    await chip.waitFor(T);
    assert.equal(await chip.textContent(), "Rating…", "pending while Jev grades it");
    gate.resolve();
    await page.locator(".msg-jev .rating-perfect").first().waitFor(T);
    assert.equal(await chip.textContent(), "Perfect");
    assert.match(await chip.getAttribute("title"), /Perfect \(3\.8 of 4\)/);
    assert.deepEqual(rate.requests[0], { question: "One", answer: "Paris", history: [] });

    // Rating cost counts toward the answer and the chat: 6 calls + 1 rating.
    assert.match(await page.locator(".meta").first().innerText(), /\$0\.0008/);
    assert.match(await page.locator("#cost-meter").textContent(), /800 tokens/);

    await askViaUI(page, "Two");
    await waitAnswered(page, 2);
    await page.locator(".msg-jev").nth(1).locator(".rating-perfect").waitFor(T);
    assert.deepEqual(rate.requests[1].history, [{ question: "One", answer: "Paris" }], "rated with the context it answered with");
  });

  test("every label gets its own style", async () => {
    for (const [label, score] of [["Terrible", 0.2], ["Bad", 1.1], ["Solid", 2], ["Good", 3], ["Perfect", 4]]) {
      const page = await open();
      await page.route("**/api/rate", rated({ label, score, tokens: 0, cost: 0 }));
      await page.route("**/api/next", scripted("Ok"));
      await askViaUI(page, "Q");
      await page.locator(`.rating-${label.toLowerCase()}`).waitFor(T);
      assert.equal(await page.locator(".rating").textContent(), label);
      await session.context.close();
      session.assertNoLeaks();
      session = null;
    }
  });

  test("a failed rating just leaves the answer unrated", async () => {
    const page = await open();
    await page.route("**/api/rate", failing(502, { error: "Jev didn't answer." }));
    await page.route("**/api/next", scripted("Paris"));
    await askViaUI(page, "Q");
    await waitAnswered(page);
    await page.waitForFunction(() => !document.querySelector(".rating"), null, T);
    assert.equal(await page.locator(".error").count(), 0);
    assert.equal(await answerText(page), "Paris");
  });

  test("an answer with no text isn't rated", async () => {
    const page = await open();
    const rate = rated({ label: "Bad", score: 1, tokens: 0, cost: 0 });
    await page.route("**/api/rate", rate);
    await page.route("**/api/next", failing(502, { error: "Jev didn't answer." }));
    await askViaUI(page, "Q");
    await page.locator(".error").waitFor(T);
    assert.equal(rate.requests.length, 0, "nothing to rate");
  });
});

describe("mobile (iPhone 13)", () => {
  test("Enter inserts a newline instead of sending", async () => {
    const page = await open({ device: "iPhone 13" });
    const fake = scripted("ok");
    await page.route("**/api/next", fake);
    assert.ok(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "emulates a touch pointer");
    const input = page.locator("#input");
    await input.tap();
    await input.type("first");
    await input.press("Enter");
    await input.type("second");
    assert.equal(await input.inputValue(), "first\nsecond");
    assert.equal(fake.requests.length, 0);
    assert.equal(await page.locator(".msg-user").count(), 0);

    await page.locator("#send").tap();
    await waitAnswered(page);
    assert.equal(fake.requests[0].question, "first\nsecond");
  });

  // Every element inside the chat column (and the tooltip) must fit the viewport.
  const overflowingInChat = (page) =>
    page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      return [...document.querySelectorAll("#main *, #tooltip:not([hidden]) *")]
        .filter((n) => n.getBoundingClientRect().right > width + 0.5 || n.getBoundingClientRect().left < -0.5)
        .map((n) => `${n.tagName}.${n.getAttribute("class")}`);
    });

  test("chat column doesn't overflow horizontally, and tapping a letter shows the tooltip", async () => {
    const page = await open({ device: "iPhone 13" });
    const long = "Supercalifragilisticexpialidocious_and_an_unbroken_run_of_letters_wider_than_any_phone";
    await page.route("**/api/next", scripted(`${long} ok`));
    assert.deepEqual(await overflowingInChat(page), [], "empty state fits");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      0,
      "empty page has no horizontal scroll",
    );

    await page.fill("#input", `${long} ${long}`);
    await page.locator("#send").tap();
    await waitAnswered(page);
    assert.deepEqual(await overflowingInChat(page), [], "long question and answer wrap");

    const tooltip = page.locator("#tooltip");
    const ch = page.locator(".answer .ch").nth(0);
    await ch.scrollIntoViewIfNeeded();
    await ch.tap();
    await tooltip.waitFor({ state: "visible", ...T });
    assert.match(await tooltip.locator("h4").textContent(), /^Jev's top picks/);
    assert.match(await tooltip.locator(".row.picked").textContent(), /^S/);
    const box = await tooltip.boundingBox();
    const width = page.viewportSize().width;
    assert.ok(box.x >= 0 && box.x + box.width <= width, `tooltip within viewport (${box.x}, ${box.width}, ${width})`);
    assert.deepEqual(await overflowingInChat(page), [], "tooltip fits");

    // Tapping elsewhere dismisses it.
    await page.locator(".msg-user").tap();
    await tooltip.waitFor({ state: "hidden", ...T });
  });

  test(
    "top bar fits a 390px screen when the cost meter shows sub-cent cost",
    async () => {
      const page = await open({ device: "iPhone 13" });
      // 89 chars + END = 90 calls -> 9000 tokens, $0.0090.
      await page.route("**/api/next", scripted("x".repeat(89)));
      await page.fill("#input", "Long");
      await page.locator("#send").tap();
      await waitAnswered(page);
      assert.match(await page.locator("#cost-meter").textContent(), /\$0\.0090 · 9\.0k tokens/);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        0,
        "page scrolls horizontally",
      );
    },
  );
});

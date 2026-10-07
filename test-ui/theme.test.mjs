// Theme tests: Modern (default) vs Y2K. Run with the UI suite:
//   CHROMIUM_PATH=/path/to/chrome npm run test:ui
// Every /api/* call is spoofed by helpers.mjs; none reach Jev.
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { byQuestion, deferred, failing, launchBrowser, openPage, rated, scripted, startServer } from "./helpers.mjs";

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

// Opens the app. `theme: "y2k"` saves that choice before every load, and
// `audio: true` swaps in a fake AudioContext that counts what gets played.
async function open({ theme, audio, ...opts } = {}) {
  session = await openPage(browser, server.baseURL, opts);
  const { context, page } = session;
  if (theme || audio) {
    if (theme) await context.addInitScript((t) => localStorage.setItem("jev-ui-theme", t), theme);
    if (audio) await context.addInitScript(fakeAudio);
    await page.reload();
  }
  return page;
}

function fakeAudio() {
  const stats = { created: 0, tones: 0, noises: 0 };
  window.__audio = stats;
  const param = () => ({
    value: 0,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
    setTargetAtTime() {},
  });
  const node = (extra) => ({ connect: (n) => n, disconnect() {}, ...extra });
  class FakeAudioContext {
    constructor() {
      stats.created++;
      this.state = "running";
      this.currentTime = 0;
      this.sampleRate = 8000;
      this.destination = node();
    }
    resume() {
      return Promise.resolve();
    }
    createGain() {
      return node({ gain: param() });
    }
    createOscillator() {
      return node({ type: "sine", frequency: param(), start: () => stats.tones++, stop() {} });
    }
    createBiquadFilter() {
      return node({ type: "lowpass", frequency: param(), Q: param() });
    }
    createBuffer(_channels, length) {
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    }
    createBufferSource() {
      return node({ buffer: null, start: () => stats.noises++, stop() {} });
    }
  }
  window.AudioContext = FakeAudioContext;
  window.webkitAudioContext = FakeAudioContext;
}

const theme = (page) => page.evaluate(() => document.documentElement.dataset.uiTheme ?? "modern");

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

// WCAG contrast of an element's text against the nearest opaque background behind it.
const contrastOf = (locator) =>
  locator.evaluate((node) => {
    const rgb = (s) => s.match(/[\d.]+/g).map(Number);
    const lum = ([r, g, b]) => {
      const c = [r, g, b].map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    let bg = null;
    for (let n = node; n && !bg; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (rgb(c).length === 3 || rgb(c)[3] === 1) bg = rgb(c).slice(0, 3);
    }
    const fg = rgb(getComputedStyle(node).color).slice(0, 3);
    const [a, b] = [lum(fg), lum(bg ?? [0, 0, 34])].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });

describe("theme switch", () => {
  test("the default theme is Modern, with a visible switch to Y2K", async () => {
    const page = await open();
    await page.route("**/api/next", scripted("x"));
    assert.equal(await theme(page), "modern");
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-ui-theme")), false);
    const toggle = page.locator("#theme-switch");
    assert.ok(await toggle.isVisible());
    assert.equal(await toggle.innerText(), "✨ Y2K");
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    assert.ok(!(await page.locator("#sound-toggle").isVisible()), "no mute button in Modern");
    assert.equal(await page.locator(".y2k-only:visible").count(), 0, "no Y2K decorations in Modern");
  });

  test("switching flips the attribute without a reload and leaves the chat alone", async () => {
    const page = await open();
    await page.route("**/api/next", scripted("Paris"));
    await page.route("**/api/rate", rated({ label: "Perfect", score: 3.9, tokens: 100, cost: 0.0001 }));
    await askViaUI(page, "Capital of France?");
    await waitAnswered(page);
    await page.locator(".rating-perfect").waitFor(T);
    await page.fill("#input", "half-typed follow-up");
    await page.evaluate(() => (window.__sentinel = "still here"));

    const snapshot = () =>
      page.evaluate(() => ({
        thread: document.getElementById("thread").innerHTML,
        input: document.getElementById("input").value,
        cost: document.getElementById("cost-meter").textContent,
        costHidden: document.getElementById("cost-meter").hidden,
        main: document.getElementById("main").className,
        sentinel: window.__sentinel,
      }));
    const before = await snapshot();
    assert.equal(before.input, "half-typed follow-up");

    await page.click("#theme-switch");
    assert.equal(await theme(page), "y2k");
    assert.equal(await page.locator("#theme-switch").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#theme-switch").innerText(), "Modern");
    assert.deepEqual(await snapshot(), before, "nothing changed but the look");

    await page.click("#theme-switch");
    assert.equal(await theme(page), "modern");
    assert.deepEqual(await snapshot(), before, "and back again");

    // The chat still works afterwards, with history intact.
    await page.route("**/api/next", scripted("Berlin"));
    await page.click("#send");
    await waitAnswered(page, 2);
    assert.equal(await answerText(page, 1), "Berlin");
  });

  test("switching mid-answer keeps the answer typing", async () => {
    const page = await open();
    const gate = deferred();
    await page.route("**/api/next", scripted("Hello", { gate: { 3: gate.promise } }));
    await askViaUI(page, "Greet me");
    await page.waitForFunction(() => document.querySelectorAll(".answer .ch").length === 3, null, T);

    await page.click("#theme-switch");
    assert.equal(await theme(page), "y2k");
    assert.equal(await page.locator(".msg-jev.typing").count(), 1, "still typing");
    assert.ok(await page.locator(".meta .stop-answer").isVisible(), "Stop still shown");
    assert.ok(await page.locator("#send.stop").isVisible());

    gate.resolve();
    await waitAnswered(page);
    assert.equal(await answerText(page), "Hello");
    assert.match(await page.locator(".meta").innerText(), /\b5 characters/);
  });

  test("the choice persists across reloads and applies before first paint", async () => {
    const page = await open();
    await page.click("#theme-switch");
    assert.equal(await page.evaluate(() => localStorage.getItem("jev-ui-theme")), "y2k");

    // Record when the attribute first appears: it should be set while <head> is parsed.
    await session.context.addInitScript(() => {
      window.__themeSetBeforeBody = null;
      new MutationObserver((_, observer) => {
        if (document.documentElement?.dataset.uiTheme) {
          window.__themeSetBeforeBody = !document.body;
          observer.disconnect();
        }
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-ui-theme"] });
    });
    await page.reload();
    assert.equal(await theme(page), "y2k");
    assert.equal(await page.evaluate(() => window.__themeSetBeforeBody), true, "set from <head>, before <body> exists");
    assert.equal(await page.locator("#theme-switch").getAttribute("aria-pressed"), "true");

    await page.click("#theme-switch");
    await page.reload();
    assert.equal(await theme(page), "modern");
    assert.equal(await page.evaluate(() => localStorage.getItem("jev-ui-theme")), "modern");
  });

  test("a blocked localStorage doesn't break the switch", async () => {
    session = await openPage(browser, server.baseURL);
    await session.context.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new Error("SecurityError");
        },
      });
    });
    const page = session.page;
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.reload();
    await page.click("#theme-switch");
    assert.equal(await theme(page), "y2k");
    assert.deepEqual(errors, []);
  });
});

describe("Y2K keeps everything usable", () => {
  test("answer text, rating chip, answer row, tooltip and cost meter are visible and readable", async () => {
    const page = await open({ theme: "y2k" });
    assert.equal(await theme(page), "y2k");
    for (const sel of ["#hero", "#suggestions", "#input", "#send", "#new-chat", "#new-chat-2", "#theme-switch", "#sound-toggle"]) {
      assert.ok(await page.locator(sel).isVisible(), `${sel} visible`);
    }
    assert.ok(await page.locator(".y2k-marquee").isVisible(), "marquee banner");
    assert.ok(await page.locator(".y2k-counter").isVisible(), "hit counter");

    const gate = deferred();
    await page.route("**/api/next", scripted("Paris", { gate: { 3: gate.promise }, overrides: { 0: { screened: 3 } } }));
    await page.route("**/api/rate", rated({ label: "Perfect", score: 3.9, tokens: 100, cost: 0.0001 }));
    await askViaUI(page, "Capital of France?");
    await page.waitForFunction(() => document.querySelectorAll(".answer .ch").length === 3, null, T);
    for (const sel of [".meta .bar", ".meta .stop-answer", "#send.stop"]) {
      assert.ok(await page.locator(sel).isVisible(), `${sel} visible while typing`);
    }
    assert.match(await page.locator(".meta").innerText(), /3\/200 characters/);
    gate.resolve();
    await waitAnswered(page);
    await page.locator(".rating-perfect").waitFor(T);

    assert.ok(await page.locator(".msg-user").isVisible());
    assert.equal(await page.locator(".msg-user").textContent(), "Capital of France?");
    assert.ok(await page.locator(".answer").isVisible());
    assert.equal(await answerText(page), "Paris");
    assert.ok(await page.locator(".rating-perfect").isVisible());
    assert.equal(await page.locator(".rating-perfect").textContent(), "Perfect");
    assert.deepEqual(await page.locator(".meta .act").allInnerTexts(), ["Copy", "Retry"]);
    for (const act of await page.locator(".meta .act").all()) assert.ok(await act.isVisible());
    const meta = await page.locator(".meta").innerText();
    assert.match(meta, /5 characters/);
    assert.match(meta, /\d\.\ds/);
    assert.match(meta, /\$0\.\d{4}/);
    assert.ok(await page.locator("#cost-meter").isVisible());
    assert.match(await page.locator("#cost-meter").textContent(), /tokens/);

    await page.locator(".answer .ch").nth(0).hover();
    const tooltip = page.locator("#tooltip");
    await tooltip.waitFor({ state: "visible", ...T });
    assert.match(await tooltip.locator("h4").textContent(), /^Jev's top picks/);
    assert.equal(await tooltip.locator(".screen-note").textContent(), "3 options passed screening");
    assert.ok(await tooltip.locator(".row.picked").isVisible());

    // About 4.5:1 or better for the text people need to read.
    for (const sel of [".answer .ch", ".msg-user", ".meta > span:not(.rating)", ".meta .act", ".rating", "#cost-meter b", "#tooltip h4", "#tooltip .row.picked", "#input"]) {
      const ratio = await contrastOf(page.locator(sel).first());
      assert.ok(ratio >= 4.5, `${sel} contrast ${ratio.toFixed(2)}`);
    }
  });

  test("every rating label, the spicy notice, the credits notice and errors stay readable", async () => {
    for (const label of ["Terrible", "Bad", "Solid", "Good", "Perfect"]) {
      const page = await open({ theme: "y2k" });
      await page.route("**/api/rate", rated({ label, score: 2, tokens: 0, cost: 0 }));
      await page.route("**/api/next", scripted("Ok"));
      await askViaUI(page, "Q");
      const chip = page.locator(`.rating-${label.toLowerCase()}`);
      await chip.waitFor(T);
      assert.ok(await chip.isVisible());
      assert.ok((await contrastOf(chip)) >= 4.5, `${label} chip contrast`);
      await session.context.close();
      session.assertNoLeaks();
      session = null;
    }

    const page = await open({ theme: "y2k" });
    await page.route("**/api/next", scripted("Music and", { overrides: { 9: { pick: "END", char: "", spicy: true } } }));
    await askViaUI(page, "Name three muppets.");
    const spicy = page.locator(".notice.spicy");
    await spicy.waitFor(T);
    assert.ok(await spicy.isVisible());
    assert.match(await spicy.innerText(), /Jev got too spicy/);
    assert.ok((await contrastOf(spicy.locator("p"))) >= 4.5, "spicy notice text contrast");

    await page.route("**/api/next", failing(402, { error: "This TypeSafe account is out of credits.", code: "out_of_credits" }));
    await askViaUI(page, "Q2");
    const credits = page.locator(".notice:not(.spicy)");
    await credits.waitFor(T);
    assert.match(await credits.innerText(), /Out of Jev credits/);
    assert.ok((await contrastOf(credits.locator("p"))) >= 4.5, "credits notice contrast");

    await page.route("**/api/next", failing(502, { error: "Jev didn't answer." }));
    await askViaUI(page, "Q3");
    const error = page.locator(".error");
    await error.waitFor(T);
    assert.match(await error.innerText(), /Jev didn't answer\./);
    assert.ok((await contrastOf(error)) >= 4.5, "error contrast");
  });

  test("New chat still resets the thread and cost meter in Y2K", async () => {
    const page = await open({ theme: "y2k" });
    await page.route("**/api/next", scripted("Hi"));
    await askViaUI(page, "Q");
    await waitAnswered(page);
    await page.click("#new-chat-2");
    assert.equal(await page.locator("#thread > *").count(), 0);
    assert.ok(await page.locator("#cost-meter").isHidden());
    assert.ok(await page.locator("#suggestions").isVisible());
  });

  test("the mute toggle persists", async () => {
    const page = await open();
    await page.click("#theme-switch");
    const mute = page.locator("#sound-toggle");
    assert.ok(await mute.isVisible());
    assert.equal(await mute.getAttribute("aria-pressed"), "true", "sound is on by default");
    await mute.click();
    assert.equal(await mute.getAttribute("aria-pressed"), "false");
    assert.equal(await page.evaluate(() => localStorage.getItem("jev-sound")), "off");
    await page.reload();
    assert.equal(await page.locator("#sound-toggle").getAttribute("aria-pressed"), "false", "still muted after reload");
    await page.click("#sound-toggle");
    await page.reload();
    assert.equal(await page.locator("#sound-toggle").getAttribute("aria-pressed"), "true");
  });
});

describe("Y2K on a phone (iPhone 13)", () => {
  test("no horizontal overflow at 390px, and tapping a letter shows the tooltip", async () => {
    const page = await open({ theme: "y2k", device: "iPhone 13" });
    const scrollX = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(page.viewportSize().width, 390);
    assert.equal(await scrollX(), 0, "empty state");

    const long = "Supercalifragilisticexpialidocious_and_an_unbroken_run_of_letters_wider_than_any_phone";
    await page.route("**/api/next", scripted(`${long} ok`));
    await page.fill("#input", `${long} ${long}`);
    await page.locator("#send").tap();
    await waitAnswered(page);
    assert.equal(await scrollX(), 0, "after a long answer");
    for (const sel of ["#theme-switch", "#sound-toggle", "#new-chat-2", "#cost-meter", ".meta .act >> nth=0"]) {
      const box = await page.locator(sel).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `${sel} on screen`);
    }

    const ch = page.locator(".answer .ch").nth(0);
    await ch.scrollIntoViewIfNeeded();
    await ch.tap();
    const tooltip = page.locator("#tooltip");
    await tooltip.waitFor({ state: "visible", ...T });
    const box = await tooltip.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, "tooltip within viewport");
    assert.equal(await scrollX(), 0, "with the tooltip open");
  });

  test("no sparkle trail on touch screens", async () => {
    const page = await open({ theme: "y2k", device: "iPhone 13" });
    await page.locator("#hero").tap();
    await page.mouse.move(100, 300);
    await page.mouse.move(200, 400, { steps: 8 });
    assert.equal(await page.locator(".y2k-sparkle").count(), 0);
  });
});

describe("sound", () => {
  test("Y2K plays synthesized sounds, but only after a user gesture", async () => {
    const page = await open({ theme: "y2k", audio: true });
    await page.mouse.move(300, 300);
    await page.mouse.move(500, 400, { steps: 10 });
    assert.ok((await page.locator(".y2k-sparkle").count()) > 0, "sparkle trail follows the mouse");
    assert.equal((await page.evaluate(() => window.__audio)).created, 0, "no audio before a gesture");

    await page.route("**/api/next", scripted("Paris"));
    await page.route("**/api/rate", rated({ label: "Terrible", score: 0.2, tokens: 0, cost: 0 }));
    await askViaUI(page, "Capital of France?");
    await waitAnswered(page);
    await page.locator(".rating-terrible").waitFor(T);
    const stats = await page.evaluate(() => window.__audio);
    assert.equal(stats.created, 1, "one AudioContext, reused");
    assert.ok(stats.tones >= 6, `send, blips, ding and trombone played (${stats.tones} tones)`);
    assert.ok(stats.noises >= 1, "the send whoosh uses noise");

    // Muting stops it.
    await page.click("#sound-toggle");
    const muted = await page.evaluate(() => window.__audio.tones + window.__audio.noises);
    await page.route("**/api/next", scripted("Lyon"));
    await askViaUI(page, "Second city?");
    await waitAnswered(page, 2);
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => window.__audio.tones + window.__audio.noises), muted, "nothing plays while muted");
  });

  test("Modern never plays sound", async () => {
    const page = await open({ audio: true });
    await page.route(
      "**/api/next",
      byQuestion({
        Paris: scripted("Paris"),
        Spicy: scripted("Hot", { overrides: { 3: { pick: "END", char: "", spicy: true } } }),
        Broken: failing(502, { error: "Jev didn't answer." }),
      }),
    );
    await page.route("**/api/rate", rated({ label: "Perfect", score: 3.9, tokens: 0, cost: 0 }));
    await askViaUI(page, "Paris");
    await waitAnswered(page);
    await page.locator(".rating-perfect").waitFor(T);
    await askViaUI(page, "Spicy");
    await page.locator(".notice.spicy").waitFor(T);
    await askViaUI(page, "Broken");
    await page.locator(".error").waitFor(T);
    await page.mouse.move(100, 100);
    await page.mouse.move(400, 400, { steps: 8 });
    assert.equal(await page.locator(".y2k-sparkle").count(), 0, "no sparkles in Modern");
    assert.deepEqual(await page.evaluate(() => window.__audio), { created: 0, tones: 0, noises: 0 });
  });

  test("switching back to Modern silences an answer in progress", async () => {
    const page = await open({ theme: "y2k", audio: true });
    const gate = deferred();
    await page.route("**/api/next", scripted("Hello", { gate: { 2: gate.promise } }));
    await askViaUI(page, "Greet me");
    await page.waitForFunction(() => document.querySelectorAll(".answer .ch").length === 2, null, T);
    await page.click("#theme-switch");
    assert.equal(await theme(page), "modern");
    const before = await page.evaluate(() => window.__audio.tones + window.__audio.noises);
    gate.resolve();
    await waitAnswered(page);
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => window.__audio.tones + window.__audio.noises), before);
  });
});

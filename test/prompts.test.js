// Admins edit every prompt step from the "How it works" page; saved edits reach every level.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

const AUTH_ENV = { GOOGLE_CLIENT_ID: "x.apps.googleusercontent.com", SESSION_SECRET: "test-secret-0123456789", STORE: "memory", ADMIN_EMAILS: "owner@example.com" };
for (const name of ["DATABASE_URL", "DEV_LOGIN_EMAIL", "VERCEL", "JEV_MOCK"]) delete process.env[name];
Object.assign(process.env, AUTH_ENV, { TYPESAFE_API_KEY: "unused-the-tests-inject-jev" });

const auth = await import("../lib/auth.js");
const { memoryStore, setStore, getStore } = await import("../lib/store.js");
const { PROMPT_DEFAULTS, PROMPT_KEYS, fromText, toText } = await import("../lib/jev.js");
const { forgetLabCache, savedPrompts } = await import("../lib/lab.js");
const promptsApi = await import("../api/admin/prompts.js");
const how = await import("../api/how.js");
const next = await import("../api/next.js");
const rate = await import("../api/rate.js");
const { fakeJev } = await import("./helpers.js");

const ORIGIN = "https://chat.test";
const req = (method, path, { body, cookie } = {}) =>
  new Request(ORIGIN + path, {
    method,
    headers: { origin: ORIGIN, ...(method !== "GET" ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (cookie) => promptsApi.GET(req("GET", "/api/admin/prompts", { cookie }));
const put = (body, cookie) => promptsApi.PUT(req("PUT", "/api/admin/prompts", { cookie, body }));

async function signIn(email) {
  await getStore().saveUser(email, {});
  await getStore().signIn({ email, googleSub: null, name: email, picture: null }, { admin: email === "owner@example.com" });
  return `__Host-session=${await auth.signSession(email)}`;
}

beforeEach(() => {
  setStore(memoryStore());
  forgetLabCache();
});

test("rules round-trip through the editable text, so the defaults send exactly what they did", () => {
  const original = { task: "Pick one.", rules: ["Be brief.", "Use digits."] };
  assert.equal(toText(original), "Pick one.\n\n- Be brief.\n- Use digits.");
  assert.deepEqual(fromText(toText(original)), original);
  assert.equal(fromText("Just a sentence."), "Just a sentence.");
  assert.deepEqual(fromText("Task.\n\n• one\n* two\nthree"), { task: "Task.", rules: ["one", "two", "three"] });
  for (const key of ["rank", "kind"]) assert.equal(toText(fromText(PROMPT_DEFAULTS[key])), PROMPT_DEFAULTS[key]);
});

test("only admins read and save prompts; unknown keys and empty text are refused", async () => {
  const owner = await signIn("owner@example.com");
  const friend = await signIn("friend@example.com");
  assert.equal((await get(friend)).status, 403);
  assert.equal((await put({ key: "done", text: "hi" }, friend)).status, 403);

  const { prompts } = await (await get(owner)).json();
  assert.deepEqual(Object.keys(prompts), PROMPT_KEYS);
  assert.deepEqual(prompts.done, { key: "done", text: PROMPT_DEFAULTS.done, default: PROMPT_DEFAULTS.done, isDefault: true });

  assert.equal((await put({ key: "nope", text: "hi" }, owner)).status, 400);
  assert.equal((await put({ key: "done", text: "  " }, owner)).status, 400);

  const saved = await (await put({ key: "done", text: "Finished?" }, owner)).json();
  assert.deepEqual(saved, { key: "done", text: "Finished?", default: PROMPT_DEFAULTS.done, isDefault: false });
  forgetLabCache();
  assert.equal((await savedPrompts()).done, "Finished?", "saved, not just cached");
  assert.equal((await (await how.GET()).json()).prompts.done, "Finished?", "the public page shows the edit");

  const reset = await (await put({ key: "done", text: null }, owner)).json();
  assert.equal(reset.isDefault, true);
  assert.equal(await getStore().getSetting("prompt_done"), null);
  assert.equal((await put({ key: "rock", text: "Rock edit." }, owner)).status, 200);
  assert.equal(await getStore().getSetting("rock_level_instructions"), "Rock edit.", "shares the lab's storage");
});

test("everyone's Stump, Post and rating requests use the saved prompts", async () => {
  const owner = await signIn("owner@example.com");
  const friend = await signIn("friend@example.com");
  const edits = {
    screen: "Screen edit.",
    done: "Done edit.",
    word_done: "Word edit.",
    sense: "Sense edit.",
    rank: "Rank edit.\n\n- Rule one.",
    kind: "Kind edit.",
    rating: "Rating edit.",
  };
  for (const [key, text] of Object.entries(edits)) assert.equal((await put({ key, text }, owner)).status, 200);

  const stump = fakeJev((o) => (o === "R" ? 5 : 1), { wordDone: 0.1 });
  const ask = (body, jev) => next.handle(req("POST", "/api/next", { cookie: friend, body: { question: "Q", ...body } }), jev);
  assert.equal((await ask({ answer: "Pa", level: "stump" }, stump)).status, 200);
  const screen = stump.screens[0].questions;
  assert.equal(screen.c0.instructions.task, "Screen edit.");
  assert.equal(screen.done.instructions, "Done edit.");
  assert.equal(screen.word_done.instructions, "Word edit.");
  assert.deepEqual(stump.choices[0].questions.next.instructions, { task: "Rank edit.", rules: ["Rule one."] });

  const sense = fakeJev(() => 1);
  await ask({ answer: "Paris is ", level: "stump" }, sense);
  assert.equal(sense.senses[0].questions.sensible.instructions, "Sense edit.");

  const post = fakeJev(() => 1, { kind: (k) => (k === "SPACE" ? 5 : 1) });
  await ask({ answer: "Paris", level: "post" }, post);
  assert.equal(post.kinds[0].questions.kind.instructions, "Kind edit.");

  const rated = fakeJev(() => 1);
  const rater = async (request) => (rated.requests.push(request), { answers: { rating: { score: 3 } }, usage: {} });
  await rate.handle(req("POST", "/api/rate", { cookie: friend, body: { question: "Q", answer: "Paris" } }), { systemOne: rater });
  assert.equal(rated.requests[0].questions.rating.instructions, "Rating edit.");
});

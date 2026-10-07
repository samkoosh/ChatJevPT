// Rock lab: admins edit Rock's instructions (saved for everyone, or a draft for their own answers).
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

const AUTH_ENV = { GOOGLE_CLIENT_ID: "x.apps.googleusercontent.com", SESSION_SECRET: "test-secret-0123456789", STORE: "memory", ADMIN_EMAILS: "owner@example.com" };
for (const name of ["DATABASE_URL", "DEV_LOGIN_EMAIL", "VERCEL", "JEV_MOCK"]) delete process.env[name];
Object.assign(process.env, AUTH_ENV, { TYPESAFE_API_KEY: "unused-the-tests-inject-jev" });

const auth = await import("../lib/auth.js");
const { memoryStore, setStore, getStore } = await import("../lib/store.js");
const { ROCK_INSTRUCTIONS } = await import("../lib/jev.js");
const { forgetRockCache, rockInstructions } = await import("../lib/rock.js");
const rockApi = await import("../api/admin/rock.js");
const next = await import("../api/next.js");

const ORIGIN = "https://chat.test";
const req = (method, path, { body, cookie } = {}) =>
  new Request(ORIGIN + path, {
    method,
    headers: { origin: ORIGIN, ...(method !== "GET" ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function signIn(email) {
  await getStore().saveUser(email, {});
  await getStore().signIn({ email, googleSub: null, name: email, picture: null }, { admin: email === "owner@example.com" });
  return `__Host-session=${await auth.signSession(email)}`;
}

// Records the Rock instructions each request carried.
function rockJev() {
  const seen = [];
  const systemOne = async (request) => {
    seen.push(request.questions.next.instructions);
    const labels = Object.keys(request.questions.next.criteria);
    return { answers: { next: { type: "choice", probabilities: Object.fromEntries(labels.map((l) => [l, l === "B" ? 0.9 : 0.001])) } }, usage: { input_tokens: 10, output_tokens: 0 } };
  };
  return { systemOne, seen };
}

beforeEach(() => {
  setStore(memoryStore());
  forgetRockCache();
});

test("the store keeps settings, and null removes them", async () => {
  const store = getStore();
  assert.equal(await store.getSetting("k"), null);
  await store.setSetting("k", "v");
  assert.equal(await store.getSetting("k"), "v");
  await store.setSetting("k", null);
  assert.equal(await store.getSetting("k"), null);
});

test("admins read, save and reset Rock's instructions; others can't", async () => {
  const owner = await signIn("owner@example.com");
  const friend = await signIn("friend@example.com");
  assert.equal((await rockApi.GET(req("GET", "/api/admin/rock", { cookie: friend }))).status, 403);
  assert.equal((await rockApi.PUT(req("PUT", "/api/admin/rock", { cookie: friend, body: { instructions: "hi" } }))).status, 403);

  let data = await (await rockApi.GET(req("GET", "/api/admin/rock", { cookie: owner }))).json();
  const { questions, ...rest } = data;
  assert.deepEqual(rest, { instructions: ROCK_INSTRUCTIONS, default: ROCK_INSTRUCTIONS, isDefault: true });
  assert.equal(questions.next.type, "choice");
  assert.equal(questions.next.instructions, ROCK_INSTRUCTIONS);
  assert.equal(Object.keys(questions.next.criteria).length, 47, "every option, END included");

  data = await (await rockApi.PUT(req("PUT", "/api/admin/rock", { cookie: owner, body: { instructions: "Spell like a pirate." } }))).json();
  assert.equal(data.instructions, "Spell like a pirate.");
  assert.equal(data.isDefault, false);
  forgetRockCache();
  assert.equal(await rockInstructions(), "Spell like a pirate.", "saved, not just cached");

  data = await (await rockApi.PUT(req("PUT", "/api/admin/rock", { cookie: owner, body: { instructions: null } }))).json();
  assert.equal(data.isDefault, true);
  assert.equal(await getStore().getSetting("rock_instructions"), null);
});

test("instructions are validated", async () => {
  const owner = await signIn("owner@example.com");
  for (const instructions of ["", "   ", 42, "x".repeat(4001)]) {
    assert.equal((await rockApi.PUT(req("PUT", "/api/admin/rock", { cookie: owner, body: { instructions } }))).status, 400, String(instructions).slice(0, 10));
  }
});

test("everyone's Rock answers use the saved instructions", async () => {
  const owner = await signIn("owner@example.com");
  const friend = await signIn("friend@example.com");
  await rockApi.PUT(req("PUT", "/api/admin/rock", { cookie: owner, body: { instructions: "Saved prompt." } }));
  const jev = rockJev();
  const res = await next.handle(req("POST", "/api/next", { cookie: friend, body: { question: "Hi", answer: "", level: "rock" } }), jev);
  assert.equal(res.status, 200);
  assert.deepEqual(jev.seen, ["Saved prompt."]);
});

test("an admin's draft applies to their own Rock answers only; others' drafts are ignored", async () => {
  const owner = await signIn("owner@example.com");
  const friend = await signIn("friend@example.com");
  const jev = rockJev();
  await next.handle(req("POST", "/api/next", { cookie: owner, body: { question: "Hi", answer: "", level: "rock", rockInstructions: "My draft." } }), jev);
  await next.handle(req("POST", "/api/next", { cookie: friend, body: { question: "Hi", answer: "", level: "rock", rockInstructions: "Sneaky." } }), jev);
  assert.deepEqual(jev.seen, ["My draft.", ROCK_INSTRUCTIONS]);

  const bad = await next.handle(req("POST", "/api/next", { cookie: owner, body: { question: "Hi", answer: "", level: "rock", rockInstructions: "  " } }), jev);
  assert.equal(bad.status, 400);
});

test("with accounts off, Rock uses the default", async () => {
  const saved = { ...process.env };
  try {
    for (const k of ["GOOGLE_CLIENT_ID", "SESSION_SECRET", "STORE"]) delete process.env[k];
    forgetRockCache();
    assert.equal(await rockInstructions(), ROCK_INSTRUCTIONS);
  } finally {
    Object.assign(process.env, saved);
  }
});

test("the lab's request view is exactly what Rock sends", async () => {
  const owner = await signIn("owner@example.com");
  await rockApi.PUT(req("PUT", "/api/admin/rock", { cookie: owner, body: { instructions: "Saved prompt." } }));
  const { questions } = await (await rockApi.GET(req("GET", "/api/admin/rock", { cookie: owner }))).json();
  const sent = [];
  const systemOne = async (request) => {
    sent.push(request.questions);
    const labels = Object.keys(request.questions.next.criteria);
    return { answers: { next: { type: "choice", probabilities: Object.fromEntries(labels.map((l) => [l, l === "B" ? 0.9 : 0.001])) } }, usage: { input_tokens: 1, output_tokens: 0 } };
  };
  forgetRockCache();
  await next.handle(req("POST", "/api/next", { cookie: owner, body: { question: "Hi", answer: "A", level: "rock" } }), { systemOne });
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), questions);
});

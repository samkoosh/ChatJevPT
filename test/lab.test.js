// Lab: admins edit Doornail's and Rock's instructions (saved for everyone, or a draft for their own answers).
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

const AUTH_ENV = { GOOGLE_CLIENT_ID: "x.apps.googleusercontent.com", SESSION_SECRET: "test-secret-0123456789", STORE: "memory", ADMIN_EMAILS: "owner@example.com" };
for (const name of ["DATABASE_URL", "DEV_LOGIN_EMAIL", "VERCEL", "JEV_MOCK"]) delete process.env[name];
Object.assign(process.env, AUTH_ENV, { TYPESAFE_API_KEY: "unused-the-tests-inject-jev" });

const auth = await import("../lib/auth.js");
const { memoryStore, setStore, getStore } = await import("../lib/store.js");
const { DOORNAIL_INSTRUCTIONS, LAB_EXAMPLE, MAX_LENGTH, ROCK_INSTRUCTIONS } = await import("../lib/jev.js");
const { forgetLabCache, labInstructions } = await import("../lib/lab.js");
const labApi = await import("../api/admin/lab.js");
const next = await import("../api/next.js");

const ORIGIN = "https://chat.test";
const req = (method, path, { body, cookie } = {}) =>
  new Request(ORIGIN + path, {
    method,
    headers: { origin: ORIGIN, ...(method !== "GET" ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (level, cookie) => labApi.GET(req("GET", `/api/admin/lab?level=${level}`, { cookie }));
const put = (body, cookie) => labApi.PUT(req("PUT", "/api/admin/lab", { cookie, body }));

async function signIn(email) {
  await getStore().saveUser(email, {});
  await getStore().signIn({ email, googleSub: null, name: email, picture: null }, { admin: email === "owner@example.com" });
  return `__Host-session=${await auth.signSession(email)}`;
}

// Records every request, and the instructions each one carried.
function recordingJev() {
  const seen = [];
  const sent = [];
  const systemOne = async (request) => {
    sent.push(request);
    seen.push(request.questions.next.instructions);
    const labels = Object.keys(request.questions.next.criteria);
    return { answers: { next: { type: "choice", probabilities: Object.fromEntries(labels.map((l) => [l, l === "B" ? 0.9 : 0.001])) } }, usage: { input_tokens: 10, output_tokens: 0 } };
  };
  return { systemOne, seen, sent };
}

beforeEach(() => {
  setStore(memoryStore());
  forgetLabCache();
});

test("the store keeps settings, and null removes them", async () => {
  const store = getStore();
  assert.equal(await store.getSetting("k"), null);
  await store.setSetting("k", "v");
  assert.equal(await store.getSetting("k"), "v");
  await store.setSetting("k", null);
  assert.equal(await store.getSetting("k"), null);
});

test("admins read, save and reset each level's instructions; others can't", async () => {
  const owner = await signIn("owner@example.com");
  const friend = await signIn("friend@example.com");
  assert.equal((await get("doornail", friend)).status, 403);
  assert.equal((await put({ level: "rock", instructions: "hi" }, friend)).status, 403);
  assert.equal((await get("stump", owner)).status, 400, "only Doornail and Rock have a lab");

  for (const [level, fallback] of [["doornail", DOORNAIL_INSTRUCTIONS], ["rock", ROCK_INSTRUCTIONS]]) {
    let data = await (await get(level, owner)).json();
    const { request, ...rest } = data;
    assert.deepEqual(rest, { level, instructions: fallback, default: fallback, isDefault: true, example: LAB_EXAMPLE });
    assert.equal(request.questions.next.instructions, fallback);
    assert.equal(Object.keys(request.questions.next.criteria).length, 47, "every option, END included");

    data = await (await put({ level, instructions: `${level} like a pirate.` }, owner)).json();
    assert.equal(data.instructions, `${level} like a pirate.`);
    assert.equal(data.request.questions.next.instructions, `${level} like a pirate.`);
    assert.equal(data.isDefault, false);
  }
  forgetLabCache();
  assert.equal(await labInstructions("doornail"), "doornail like a pirate.", "saved, not just cached");
  assert.equal(await labInstructions("rock"), "rock like a pirate.", "each level keeps its own");
  assert.equal(await getStore().getSetting("rock_instructions"), "doornail like a pirate.", "Doornail keeps its old settings key");

  const data = await (await put({ level: "rock", instructions: null }, owner)).json();
  assert.equal(data.isDefault, true);
  assert.equal(await labInstructions("rock"), ROCK_INSTRUCTIONS);
  assert.equal(await labInstructions("doornail"), "doornail like a pirate.", "resetting Rock leaves Doornail alone");
});

test("the example state is made-up data in the shape each level sends", async () => {
  const owner = await signIn("owner@example.com");
  const doornail = await (await get("doornail", owner)).json();
  assert.deepEqual(doornail.request.state, { question: LAB_EXAMPLE.question, answer_so_far: LAB_EXAMPLE.answer });
  const rock = await (await get("rock", owner)).json();
  assert.deepEqual(rock.request.state, { question: LAB_EXAMPLE.question, characters_remaining: MAX_LENGTH - 2 });
  assert.ok('"Par"' in rock.request.questions.next.criteria, "Rock's options use the example answer");
});

test("instructions are validated", async () => {
  const owner = await signIn("owner@example.com");
  for (const instructions of ["", "   ", 42, "x".repeat(4001)]) {
    assert.equal((await put({ level: "doornail", instructions }, owner)).status, 400, String(instructions).slice(0, 10));
  }
  assert.equal((await put({ level: "boulder", instructions: "hi" }, owner)).status, 400);
});

test("everyone's Doornail and Rock answers use the saved instructions", async () => {
  const owner = await signIn("owner@example.com");
  const friend = await signIn("friend@example.com");
  await put({ level: "doornail", instructions: "Saved doornail." }, owner);
  await put({ level: "rock", instructions: "Saved rock." }, owner);
  const jev = recordingJev();
  for (const level of ["doornail", "rock"]) {
    const res = await next.handle(req("POST", "/api/next", { cookie: friend, body: { question: "Hi", answer: "", level } }), jev);
    assert.equal(res.status, 200);
  }
  assert.deepEqual(jev.seen, ["Saved doornail.", "Saved rock."]);
});

test("an admin's draft applies to their own answers at that level only; others' drafts are ignored", async () => {
  const owner = await signIn("owner@example.com");
  const friend = await signIn("friend@example.com");
  const jev = recordingJev();
  const ask = (cookie, level, labInstructions) => next.handle(req("POST", "/api/next", { cookie, body: { question: "Hi", answer: "", level, labInstructions } }), jev);
  await ask(owner, "doornail", "My doornail draft.");
  await ask(owner, "rock", "My rock draft.");
  await ask(friend, "rock", "Sneaky.");
  assert.deepEqual(jev.seen, ["My doornail draft.", "My rock draft.", ROCK_INSTRUCTIONS]);

  assert.equal((await ask(owner, "rock", "  ")).status, 400);
});

test("with accounts off, both use their defaults", async () => {
  const saved = { ...process.env };
  try {
    for (const k of ["GOOGLE_CLIENT_ID", "SESSION_SECRET", "STORE"]) delete process.env[k];
    forgetLabCache();
    assert.equal(await labInstructions("doornail"), DOORNAIL_INSTRUCTIONS);
    assert.equal(await labInstructions("rock"), ROCK_INSTRUCTIONS);
  } finally {
    Object.assign(process.env, saved);
  }
});

test("the lab's request view is exactly what each level sends for the same question and answer", async () => {
  const owner = await signIn("owner@example.com");
  for (const level of ["doornail", "rock"]) {
    await put({ level, instructions: `Saved ${level}.` }, owner);
    const { request } = await (await get(level, owner)).json();
    const jev = recordingJev();
    forgetLabCache();
    await next.handle(req("POST", "/api/next", { cookie: owner, body: { question: LAB_EXAMPLE.question, answer: LAB_EXAMPLE.answer, level } }), jev);
    assert.deepEqual(JSON.parse(JSON.stringify({ state: jev.sent[0].state, questions: jev.sent[0].questions })), request, level);
  }
});

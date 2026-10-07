import { test } from "node:test";
import assert from "node:assert/strict";
import { nextCharacter, normalizeHistory, END, MAX_HISTORY } from "../lib/jev.js";
import { fakeJev } from "./helpers.js";

test("the highest-probability option wins", async () => {
  const jev = fakeJev((o) => (o === "P" ? 10 : 1));
  const r = await nextCharacter("Capital of France?", "", [], jev);
  assert.equal(r.pick, "P");
  assert.equal(r.char, "P");
  assert.equal(r.tied, 1);
  assert.equal(jev.requests.length, 1);
});

test("ties go to a runoff between only the tied options", async () => {
  // Round 1: A, B, C tie. Runoff: B wins.
  const jev = fakeJev((o, _a, call) => (call === 1 ? (["A", "B", "C"].includes(o) ? 5 : 1) : o === "B" ? 5 : 1));
  const r = await nextCharacter("q", "", [], jev);
  assert.equal(r.pick, "B");
  assert.equal(r.tied, 3);
  assert.equal(r.runoffs, 1);
  assert.equal(r.coinFlip, false);
  assert.equal(Object.keys(jev.requests[1].questions.next.criteria).length, 3, "runoff only has the tied options");
  assert.equal(jev.requests[1].questions.done, undefined, "runoff doesn't re-ask done");
});

test("a coin flip only happens after two runoffs stay tied", async () => {
  const jev = fakeJev((o) => (["X", "Y"].includes(o) ? 5 : 1));
  const r = await nextCharacter("q", "", [], jev);
  assert.ok(["X", "Y"].includes(r.pick));
  assert.equal(r.runoffs, 2);
  assert.equal(r.coinFlip, true);
  assert.equal(jev.requests.length, 3);
});

test("a confident 'done' ends the answer", async () => {
  const jev = fakeJev(() => 1, { done: 0.9 });
  const r = await nextCharacter("Capital of France?", "Paris", [], jev);
  assert.equal(r.pick, END);
  assert.equal(r.char, "");
});

test("a weak 'done' doesn't end the answer", async () => {
  const jev = fakeJev((o) => (o === "SPACE" ? 5 : 1), { done: 0.3 });
  const r = await nextCharacter("q", "Paris", [], jev);
  assert.equal(r.pick, "SPACE");
});

test("done isn't asked when ending isn't allowed", async () => {
  const jev = fakeJev(() => 1);
  await nextCharacter("q", "The b", [], jev);
  assert.equal(jev.requests[0].questions.done, undefined);
});

test("previous turns are sent as state, newest last and capped", async () => {
  const jev = fakeJev(() => 1);
  const history = Array.from({ length: 10 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` }));
  await nextCharacter("What about Germany?", "", history, jev);
  const turns = jev.requests[0].state.previous_turns;
  assert.equal(turns.length, MAX_HISTORY);
  assert.equal(turns.at(-1).question, "q9");
});

test("no previous_turns key on the first question", async () => {
  const jev = fakeJev(() => 1);
  await nextCharacter("q", "", [], jev);
  assert.equal("previous_turns" in jev.requests[0].state, false);
});

test("malformed history is dropped", () => {
  assert.deepEqual(normalizeHistory("nope"), []);
  assert.deepEqual(normalizeHistory([{ question: 1 }, null, { question: "q", answer: "a" }]), [{ question: "q", answer: "a" }]);
  assert.equal(normalizeHistory([{ question: "x".repeat(900), answer: "a" }])[0].question.length, 500);
});

test("option order is shuffled between calls", async () => {
  const jev = fakeJev(() => 1);
  for (let i = 0; i < 5; i++) await nextCharacter("q", "Paris", [], jev);
  const orders = new Set(jev.requests.filter((r) => r.questions.done).map((r) => Object.keys(r.questions.next.criteria).join("|")));
  assert.ok(orders.size > 1);
});

test("an unfinished word can't be ended with a space, punctuation or END", async () => {
  // Jev "prefers" SPACE, but says "bl" isn't a finished word.
  const jev = fakeJev((o) => (o === "SPACE" ? 10 : o === "U" ? 5 : 1), { wordDone: 0.1 });
  const r = await nextCharacter("What color is the sky?", "The sky is bl", [], jev);
  assert.equal(r.pick, "U");
  assert.equal(jev.requests[0].state.word_in_progress, "bl");
});

test("a finished word can be ended", async () => {
  const jev = fakeJev((o) => (o === "SPACE" ? 10 : 1), { wordDone: 0.9 });
  const r = await nextCharacter("q", "The sky is blue", [], jev);
  assert.equal(r.pick, "SPACE");
});

test("word_done isn't asked between words or inside numbers", async () => {
  const jev = fakeJev(() => 1);
  await nextCharacter("q", "The ", [], jev);
  await nextCharacter("q", "It is 4", [], jev);
  assert.ok(jev.requests.every((r) => !r.questions.word_done));
});

test("token usage and cost include runoff calls", async () => {
  const base = fakeJev((o) => (["X", "Y"].includes(o) ? 5 : 1));
  const systemOne = async (req) => ({ ...(await base.systemOne(req)), usage: { input_tokens: 1000, output_tokens: 0 } });
  const r = await nextCharacter("q", "", [], { systemOne });
  assert.equal(r.tokens, 3000, "first round plus two runoffs");
  assert.ok(Math.abs(r.cost - 3000 / 1e6 * 0.042) < 1e-12);
});

test("the word-complete check only holds short words open", async () => {
  const jev = fakeJev((o) => (o === "SPACE" ? 10 : 1), { wordDone: 0.1 });
  const r = await nextCharacter("q", "Because", [], jev);
  assert.equal(r.pick, "SPACE", "7-letter word isn't held open");
  assert.equal(jev.requests[0].questions.word_done, undefined);
});

test("repetition is allowed when Jev says the question asks for it", async () => {
  const jev = fakeJev((o) => (o === "SPACE" ? 10 : 1), { repeatOk: 0.9 });
  const r = await nextCharacter("Say duck 6 times", "Duck duck", [], jev);
  assert.equal(r.pick, "SPACE");
  assert.ok(jev.requests[0].questions.repeat_ok, "asked because the answer repeats");
});

test("repetition is blocked when Jev says it's a loop", async () => {
  const jev = fakeJev((o) => (o === "SPACE" ? 10 : o === "S" ? 5 : 1), { repeatOk: 0.1 });
  const r = await nextCharacter("Why is the sky blue?", "from the there and from the there", [], jev);
  assert.notEqual(r.pick, "SPACE");
  assert.equal(r.pick, "S", "has to become a different word (theres)");
});

test("repeat_ok is only asked when the answer repeats", async () => {
  const jev = fakeJev(() => 1);
  await nextCharacter("q", "The sky is blue", [], jev);
  assert.equal(jev.requests[0].questions.repeat_ok, undefined);
});

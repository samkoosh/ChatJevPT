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
  assert.equal(jev.screens.length, 1, "one screening request");
  assert.equal(jev.choices.length, 1, "one ranking request");
});

test("ties go to a runoff between only the tied options", async () => {
  // Round 1: A, B, C tie. Runoff: B wins.
  const jev = fakeJev((o, _a, call) => (call === 1 ? (["A", "B", "C"].includes(o) ? 5 : 1) : o === "B" ? 5 : 1));
  const r = await nextCharacter("q", "", [], jev);
  assert.equal(r.pick, "B");
  assert.equal(r.tied, 3);
  assert.equal(r.runoffs, 1);
  assert.equal(r.coinFlip, false);
  assert.equal(Object.keys(jev.choices[1].questions.next.criteria).length, 3, "runoff only has the tied options");
  assert.equal(jev.choices[1].questions.done, undefined, "runoff doesn't re-ask done");
});

test("a coin flip only happens after two runoffs stay tied", async () => {
  const jev = fakeJev((o) => (["X", "Y"].includes(o) ? 5 : 1));
  const r = await nextCharacter("q", "", [], jev);
  assert.ok(["X", "Y"].includes(r.pick));
  assert.equal(r.runoffs, 2);
  assert.equal(r.coinFlip, true);
  assert.equal(jev.choices.length, 3, "ranking plus two runoffs");
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
  const orders = new Set(jev.choices.map((r) => Object.keys(r.questions.next.criteria).join("|")));
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
  assert.equal(r.tokens, 4000, "screening, ranking, and two runoffs");
  assert.ok(Math.abs(r.cost - 4000 / 1e6 * 0.042) < 1e-12);
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

test("screening drops candidates Jev doesn't think are heading somewhere sensible", async () => {
  // Ranking would prefer Q, but screening only passes U and E.
  const jev = fakeJev((o) => (o === "Q" ? 10 : o === "U" ? 3 : 1), { screen: (o) => (["U", "E"].includes(o) ? 0.8 : 0.1) });
  const r = await nextCharacter("What color is the sky?", "The sky is bl", [], jev);
  assert.equal(r.pick, "U");
  const ranked = Object.keys(jev.choices[0].questions.next.criteria);
  assert.equal(ranked.length, 2, "only U and E reach the ranking (\"bl\" isn't a word, so no END)");
  assert.equal(r.screened, 2);
});

test("if too few pass screening, the best ones still go through", async () => {
  const jev = fakeJev((o) => (o === "E" ? 5 : 1), { screen: (o) => (o === "U" ? 0.2 : o === "E" ? 0.15 : 0.01) });
  const r = await nextCharacter("q", "The sky is bl", [], jev);
  assert.equal(r.pick, "E");
  assert.equal(Object.keys(jev.choices[0].questions.next.criteria).length, 2, "the best two");
});

test("a single option is picked without a ranking call", async () => {
  // "Jupite" can only continue as "Jupiter".
  const jev = fakeJev(() => 1);
  const r = await nextCharacter("Largest planet?", "Jupite", [], jev);
  assert.equal(r.pick, "R");
  assert.equal(r.screened, 1);
  assert.equal(jev.choices.length, 0);
});

test("each screening question shows the candidate text", async () => {
  const jev = fakeJev(() => 1);
  await nextCharacter("q", "The sky is bl", [], jev);
  const qs = Object.values(jev.screens[0].questions).filter((q) => q.instructions?.candidate);
  assert.ok(qs.some((q) => q.instructions.candidate === '"The sky is blu…"'));
});

test("after a word ends, a sense check reads the answer alone and stops nonsense", async () => {
  const jev = fakeJev(() => 1, { sensible: 0.1 });
  const r = await nextCharacter("Name three muppets.", "Music and ands's the there ", [], jev);
  assert.equal(r.pick, END);
  assert.equal(r.spicy, true);
  assert.equal(jev.senses.length, 1);
  assert.deepEqual(jev.senses[0].state, { text: "Music and ands's the there" }, "no question or chat context");
});

test("a sensible answer keeps going, and the check only runs after a space", async () => {
  const sensible = fakeJev((o) => (o === "B" ? 5 : 1), { sensible: 0.9 });
  const r = await nextCharacter("q", "The sky is ", [], sensible);
  assert.notEqual(r.spicy, true);
  assert.equal(sensible.senses.length, 1);
  const midWord = fakeJev(() => 1, { sensible: 0.1 });
  await nextCharacter("q", "The sky is bl", [], midWord);
  assert.equal(midWord.senses.length, 0);
});

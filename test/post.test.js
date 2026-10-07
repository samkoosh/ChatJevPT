import { test } from "node:test";
import assert from "node:assert/strict";
import { END, LETTER, NUMBER, PUNCTUATION, SPACE, kindOf, postCharacter } from "../lib/jev.js";
import { fakeJev } from "./helpers.js";

const prefers = (winner) => (k) => (k === winner ? 10 : 1);

test("round 1 is a Choice over the kinds of character code allows here", async () => {
  const jev = fakeJev((o) => (o === "P" ? 10 : 1), { kind: prefers(LETTER) });
  await postCharacter("Capital of France?", "", [], jev);
  const labels = Object.keys(jev.kinds[0].questions.kind.criteria).sort();
  assert.deepEqual(labels, ["Letter", "Number"], "nothing to end or space after yet");

  const later = fakeJev(() => 1, { kind: prefers(SPACE) });
  await postCharacter("q", "It is 4", [], later);
  const criteria = later.kinds[0].questions.kind.criteria;
  assert.deepEqual(Object.keys(criteria).sort(), ["End of answer", "Line break", "Number", "Punctuation", "Space"]);
  assert.equal(criteria.Number, 'Another digit in the number "4".');
  assert.match(criteria.Punctuation, /\. , ! \? : ;$/);
});

test("a letter: the kind, then Stump's screening and ranking among letters only", async () => {
  const jev = fakeJev((o) => (o === "P" ? 10 : 1), { kind: prefers(LETTER) });
  const r = await postCharacter("Capital of France?", "", [], jev);
  assert.equal(r.kind, LETTER);
  assert.equal(r.pick, "P");
  assert.equal(r.char, "P");
  assert.equal(jev.kinds.length, 1);
  assert.equal(jev.screens.length, 1);
  const screened = Object.values(jev.screens[0].questions).map((q) => q.instructions.candidate);
  assert.ok(screened.every((c) => /^"[A-Z]…"$/.test(c)), "only letters are screened");
  assert.equal(jev.choices.length, 1);
  assert.ok(Object.keys(jev.choices[0].questions.next.criteria).every((l) => /^"[A-Z]…"$/.test(l)), "only letters are ranked");
  assert.deepEqual(r.kinds.map((k) => k.option).sort(), [LETTER, NUMBER]);
});

test("a space, a line break or the end needs no second round", async () => {
  const jev = fakeJev(() => 1, { kind: prefers(SPACE) });
  const r = await postCharacter("q", "Paris", [], jev);
  assert.equal(r.pick, SPACE);
  assert.equal(r.char, " ");
  assert.equal(jev.requests.length, 1);

  const end = fakeJev(() => 1, { kind: prefers(END) });
  const e = await postCharacter("q", "Paris", [], end);
  assert.equal(e.pick, END);
  assert.equal(e.char, "");
});

test("a single punctuation mark that fits is picked without screening", async () => {
  const jev = fakeJev(() => 1, { kind: prefers(PUNCTUATION) });
  const r = await postCharacter("q", "Paris.", [], jev); // after "." only another "." is punctuation
  assert.equal(r.pick, ".");
  assert.equal(jev.screens.length, 0);
});

test("Stump's checks run alongside round 1: done, word_done, repeat_ok, sense", async () => {
  const done = fakeJev(() => 1, { kind: prefers(LETTER), done: 0.9 });
  const d = await postCharacter("q", "Paris", [], done);
  assert.equal(d.pick, END);
  assert.ok(done.kinds[0].questions.done, "done is in the same request as the kind");

  // "Be" isn't finished: Space wins the kind round but is masked, so the best open kind (Letter) goes on.
  const word = fakeJev((o) => (o === "R" ? 10 : 1), { kind: (k) => (k === SPACE ? 10 : k === LETTER ? 5 : 1), wordDone: 0.1 });
  const w = await postCharacter("q", "Be", [], word);
  assert.ok(word.kinds[0].questions.word_done);
  assert.equal(w.kind, LETTER);
  assert.equal(w.pick, "R");

  const spicy = fakeJev(() => 1, { kind: prefers(LETTER), sensible: 0.1 });
  const s = await postCharacter("q", "Blue cheese ", [], spicy);
  assert.equal(spicy.senses.length, 1);
  assert.equal(s.pick, END);
  assert.equal(s.spicy, true);

  const loop = fakeJev((o) => (o === SPACE ? 10 : 1), { kind: prefers(SPACE), repeatOk: 0 });
  const l = await postCharacter("q", "the cat the cat the cat", [], loop);
  assert.ok(loop.kinds[0].questions.repeat_ok);
  assert.notEqual(l.kind, SPACE, "a loop can't be finished");
});

test("kinds that tie go to a runoff between only the tied kinds", async () => {
  const jev = fakeJev(() => 1, { kind: (k, _a, call) => (call === 1 ? (k === SPACE || k === END ? 5 : 1) : k === END ? 5 : 1) });
  const r = await postCharacter("q", "Paris", [], jev);
  assert.equal(r.kindTied, 2);
  assert.equal(r.kindRunoffs, 1);
  assert.deepEqual(Object.keys(jev.kinds[1].questions.kind.criteria).sort(), ["End of answer", "Space"]);
  assert.equal(jev.kinds[1].questions.done, undefined, "the runoff doesn't re-ask the checks");
  assert.equal(r.pick, END);
});

test("kindOf", () => {
  assert.equal(kindOf("A"), LETTER);
  assert.equal(kindOf("7"), NUMBER);
  assert.equal(kindOf("'"), PUNCTUATION);
  assert.equal(kindOf(","), PUNCTUATION);
  assert.equal(kindOf(SPACE), SPACE);
  assert.equal(kindOf(END), END);
});

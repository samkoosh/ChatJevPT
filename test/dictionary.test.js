import { test } from "node:test";
import assert from "node:assert/strict";
import { examples, isPrefix, isWord } from "../lib/dictionary.js";

test("knows common words and the proper nouns answers need", () => {
  for (const w of ["blue", "paris", "berlin", "jupiter", "shakespeare", "hello", "a", "I"]) assert.ok(isWord(w), w);
  for (const w of ["bl", "th", "barl", "t"]) assert.ok(!isWord(w), w);
});

test("prefixes", () => {
  assert.ok(isPrefix("shakesp"));
  assert.ok(!isPrefix("ndn"));
  assert.ok(isPrefix("t", { afterApostrophe: true }));
  assert.ok(!isPrefix("x", { afterApostrophe: true }));
});

test("examples are the most common words with that start", () => {
  assert.deepEqual(examples("blu"), ["blue", "blues", "bluff"]);
  assert.equal(examples("jup")[0], "jupiter");
  assert.deepEqual(examples("zzzq"), []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { score } from "../lib/eval.js";

test("eval scoring wants the answer early and short", () => {
  assert.ok(score({ expect: ["paris"] }, "Paris"));
  assert.ok(score({ expect: ["blue"] }, "The sky is blue."));
  assert.ok(!score({ expect: ["blue"] }, "Be bee a be bee be bee be bee be bee be blue"));
  assert.ok(!score({ expect: ["4"] }, "14"), "whole-number match only at a word start");
});

test("repeat cases count exact repetitions", () => {
  const c = { repeat: { word: "duck", times: 6 } };
  assert.ok(score(c, "Duck duck duck duck duck duck"));
  assert.ok(score(c, "Duck, duck, duck, duck, duck, duck!"));
  assert.ok(!score(c, "Duck duck duck"));
  assert.ok(!score(c, "Duck duck duck duck duck duck duck"));
});

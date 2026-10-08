import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LEVELS, explainer } from "../lib/jev.js";
import { GET } from "../api/how.js";

// The "How it works" page has to keep up with the code: a section per level, and every number it
// shows is a real setting whose fallback in the HTML matches the code.
const html = readFileSync(new URL("../public/how.html", import.meta.url), "utf8");

test("how.html has a section for every level", () => {
  for (const level of LEVELS) assert.ok(html.includes(`id="level-${level}"`), `missing a section for ${level}`);
  const sections = [...html.matchAll(/id="level-([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sections, LEVELS, "sections in level order, and no levels that no longer exist");
});

test("how.html's numbers are real settings, and its fallbacks match the code", () => {
  const { numbers } = explainer();
  const shown = [...html.matchAll(/data-n="([A-Z_]+)">([^<]*)</g)];
  assert.ok(shown.length > 5);
  for (const [, key, fallback] of shown) {
    assert.ok(key in numbers, `${key} isn't a setting`);
    assert.equal(fallback, String(numbers[key]), `${key}: the page says ${fallback}, the code says ${numbers[key]}`);
  }
});

test("how.html's prompts all exist", () => {
  const { prompts } = explainer();
  const keys = [...html.matchAll(/data-prompt="([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 5);
  for (const key of keys) assert.equal(typeof prompts[key], "string", `no prompt called ${key}`);
});

test("GET /api/how serves the explainer", async () => {
  const res = await GET();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.levels, LEVELS);
  assert.equal(body.numbers.DONE_THRESHOLD, explainer().numbers.DONE_THRESHOLD);
  assert.match(body.prompts.doornail, /answer_so_far/);
});

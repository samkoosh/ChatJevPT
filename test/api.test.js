import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JEV_MOCK = "1";
const { POST, isOutOfCredits } = await import("../api/next.js");

const call = (body) => POST(new Request("http://x/api/next", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));

test("returns one character for a valid request", async () => {
  const res = await call({ question: "Hi", answer: "", history: [{ question: "a", answer: "b" }] });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(typeof data.pick, "string");
  assert.equal(typeof data.char, "string");
  assert.ok(Array.isArray(data.top));
});

test("rejects bad input", async () => {
  assert.equal((await call("not json")).status, 400);
  assert.equal((await call({ question: "", answer: "" })).status, 400);
  assert.equal((await call({ question: "x".repeat(2001), answer: "" })).status, 400);
  assert.equal((await call({ question: "Hi" })).status, 400);
  assert.equal((await call({ question: "Hi", answer: "<b>" })).status, 400);
  assert.equal((await call({ question: "Hi", answer: "x".repeat(200) })).status, 400);
});

test("explains a missing API key", async () => {
  delete process.env.JEV_MOCK;
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const res = await call({ question: "Hi", answer: "" });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /TYPESAFE_API_KEY/);
  } finally {
    process.env.JEV_MOCK = "1";
    if (saved) process.env.TYPESAFE_API_KEY = saved;
  }
});

test("recognizes an exhausted balance", () => {
  assert.ok(isOutOfCredits({ status: 402 }));
  assert.ok(isOutOfCredits({ status: 403, body: { error: { message: "Insufficient credits" } } }));
  assert.ok(isOutOfCredits({ status: 400, message: "Quota exceeded" }));
  assert.ok(!isOutOfCredits({ status: 500, message: "boom" }));
  assert.ok(!isOutOfCredits(new Error("network down")));
});

const { POST: RATE } = await import("../api/rate.js");
const rate = (body) => RATE(new Request("http://x/api/rate", { method: "POST", body: JSON.stringify(body) }));

test("rate returns a label for a valid answer", async () => {
  const res = await rate({ question: "Hi", answer: "Hello", history: [] });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(["Terrible", "Bad", "Solid", "Good", "Perfect"].includes(data.label));
  assert.equal(typeof data.score, "number");
});

test("rate rejects bad input", async () => {
  assert.equal((await rate({ question: "Hi", answer: "" })).status, 400);
  assert.equal((await rate({ question: "", answer: "Hello" })).status, 400);
  assert.equal((await rate({ question: "Hi", answer: "<b>" })).status, 400);
});

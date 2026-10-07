import { test } from "node:test";
import assert from "node:assert/strict";
import { rateAnswer, RATINGS } from "../lib/jev.js";

const fakeRater = (score) => {
  const requests = [];
  const systemOne = async (req) => {
    requests.push(req);
    return { answers: { rating: { type: "score", score, confidence: 0.5 } }, usage: { input_tokens: 500, output_tokens: 0 } };
  };
  return { systemOne, requests };
};

test("rating asks one five-level Score question with the chat context", async () => {
  const jev = fakeRater(3.2);
  const history = [{ question: "What is the capital of France?", answer: "Paris" }];
  const r = await rateAnswer("What about Germany?", "Berlin", history, jev);
  assert.equal(r.label, "Good");
  assert.equal(r.score, 3.2);
  assert.equal(r.tokens, 500);
  assert.ok(Math.abs(r.cost - (500 / 1e6) * 0.042) < 1e-12);
  const req = jev.requests[0];
  assert.deepEqual(req.state, { previous_turns: history, question: "What about Germany?", answer: "Berlin" });
  assert.equal(req.questions.rating.type, "score");
  assert.equal(req.questions.rating.criteria.length, 5);
});

test("scores round to the nearest label", async () => {
  const cases = [[0, "Terrible"], [0.4, "Terrible"], [0.6, "Bad"], [2.49, "Solid"], [3.5, "Perfect"], [4, "Perfect"]];
  for (const [score, label] of cases) assert.equal((await rateAnswer("q", "a", [], fakeRater(score))).label, label, String(score));
  assert.deepEqual(RATINGS, ["Terrible", "Bad", "Solid", "Good", "Perfect"]);
});

test("no previous_turns key without history", async () => {
  const jev = fakeRater(2);
  await rateAnswer("q", "a", [], jev);
  assert.equal("previous_turns" in jev.requests[0].state, false);
});

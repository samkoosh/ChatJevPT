import { test } from "node:test";
import assert from "node:assert/strict";
import { END, pickNext, rockCharacter } from "../lib/jev.js";
import { handle } from "../api/next.js";
import { handle as handleRate } from "../api/rate.js";

// A fake Jev that records requests and answers any Choice/Noul/Score with fixed values.
function recorder(favorite = "B") {
  const requests = [];
  const systemOne = async (req) => {
    requests.push(req);
    const answers = {};
    for (const [k, q] of Object.entries(req.questions)) {
      if (q.type === "choice") {
        const labels = Object.keys(q.criteria);
        answers[k] = { type: "choice", probabilities: Object.fromEntries(labels.map((l) => [l, l === favorite || l.includes(`${favorite.toLowerCase()}…`) ? 0.9 : 0.01])) };
      } else if (q.type === "noul") answers[k] = { type: "noul", noul: 0.9 };
      else if (q.type === "score") answers[k] = { type: "score", score: 3 };
    }
    return { answers, usage: { input_tokens: 10, output_tokens: 0 } };
  };
  return { systemOne, requests };
}

test("Rock: one Choice over every character, with only the question and the answer so far", async () => {
  const jev = recorder("B");
  const r = await rockCharacter("What color is the sky?", "", jev);
  assert.equal(jev.requests.length, 1);
  assert.deepEqual(jev.requests[0].state, { question: "What color is the sky?", answer_so_far: "" });
  const labels = Object.keys(jev.requests[0].questions.next.criteria);
  for (const o of ["A", "Z", "0", "9", "SPACE", "NEWLINE", ".", "?", "'", "-"]) assert.ok(labels.includes(o), o);
  assert.ok(!labels.includes(END), "can't end before writing anything");
  assert.equal(r.pick, "B");
  assert.equal(r.char, "B");
  assert.equal(r.tokens, 10);
});

test("Rock offers END once something is written, and has no other rules", async () => {
  const jev = recorder("SPACE");
  const r = await rockCharacter("q", "zzq ", jev);
  assert.ok(Object.keys(jev.requests[0].questions.next.criteria).includes(END));
  assert.equal(r.pick, "SPACE", "double spaces are fine for a rock");
});

test("pickNext: Rock ignores memory; Stump drops history when memory is off", async () => {
  const history = [{ question: "What is the capital of France?", answer: "Paris" }];
  const rock = recorder();
  await pickNext("What about Germany?", "", history, { level: "rock", ...rock });
  assert.equal(rock.requests.length, 1);
  assert.equal("previous_turns" in rock.requests[0].state, false);

  const on = recorder();
  await pickNext("What about Germany?", "", history, { level: "stump", memory: true, ...on });
  assert.deepEqual(on.requests[0].state.previous_turns, history);

  const off = recorder();
  await pickNext("What about Germany?", "", history, { level: "stump", memory: false, ...off });
  assert.ok(off.requests.every((r) => !("previous_turns" in r.state)));
});

const post = (body) =>
  new Request("http://localhost/api/next", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("API: level and memory", async () => {
  process.env.JEV_MOCK = "1";
  try {
    const history = [{ question: "a", answer: "b" }];
    const locked = await handle(post({ question: "Hi", answer: "", level: "post" }));
    assert.equal(locked.status, 400);
    assert.equal((await locked.json()).code, "level_locked");
    assert.equal((await handle(post({ question: "Hi", answer: "", level: "boulder" }))).status, 400);

    const rock = recorder();
    assert.equal((await handle(post({ question: "Hi", answer: "", level: "rock", history }), rock)).status, 200);
    assert.equal(rock.requests.length, 1);
    assert.deepEqual(Object.keys(rock.requests[0].state), ["question", "answer_so_far"]);

    const forgetful = recorder();
    await handle(post({ question: "Hi", answer: "", memory: false, history }), forgetful);
    assert.ok(forgetful.requests.every((r) => !("previous_turns" in r.state)));

    const stump = recorder();
    await handle(post({ question: "Hi", answer: "", history }), stump);
    assert.ok(stump.requests.some((r) => r.state.previous_turns), "Stump with memory is the default");

    const rate = recorder();
    const rateReq = new Request("http://localhost/api/rate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Hi", answer: "Hello", memory: false, history }),
    });
    assert.equal((await handleRate(rateReq, rate)).status, 200);
    assert.equal("previous_turns" in rate.requests[0].state, false, "rated without memory too");
  } finally {
    delete process.env.JEV_MOCK;
  }
});

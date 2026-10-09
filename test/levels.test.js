import { test } from "node:test";
import assert from "node:assert/strict";
import { END, MAX_LENGTH, pickNext, doornailCharacter, rockCharacter } from "../lib/jev.js";
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

test("Doornail: one Choice over every character, with only the question and the answer so far", async () => {
  const jev = recorder("B");
  const r = await doornailCharacter("What color is the sky?", "", jev);
  assert.equal(jev.requests.length, 1);
  assert.deepEqual(jev.requests[0].state, { question: "What color is the sky?", answer_so_far: "" });
  const criteria = jev.requests[0].questions.next.criteria;
  const labels = Object.keys(criteria);
  for (const o of ["A", "Z", "0", "9", "space", "NEWLINE", ".", "?", "'", "-"]) assert.ok(labels.includes(o), JSON.stringify(o));
  assert.ok(!labels.includes(" ") && !labels.includes("SPACE"), "a space is labelled with the word space");
  for (const [label, description] of Object.entries(criteria)) assert.ok(description, `${JSON.stringify(label)} is described`);
  assert.equal(criteria.A, "The letter A.");
  assert.equal(criteria["7"], "The digit 7.");
  assert.equal(criteria["?"], "A question mark.");
  assert.equal(criteria.space, "A space between words (as though the keyboard's space bar was pressed).");
  assert.equal(criteria.NEWLINE, "A line break (as though the keyboard's Return key was pressed).");
  assert.ok(!labels.includes(END), "can't end before writing anything");
  assert.equal(r.pick, "B");
  assert.equal(r.char, "B");
  assert.equal(r.tokens, 10);
});

test("Doornail offers END once something is written, and has no other rules", async () => {
  const jev = recorder("space");
  const r = await doornailCharacter("q", "zzq ", jev);
  const criteria = jev.requests[0].questions.next.criteria;
  assert.equal(criteria[END], "The end of the answer, used to immediately stop generation. Use when the answer is satisfactory and complete.");
  assert.deepEqual(Object.keys(jev.requests[0].state), ["question", "answer_so_far"], "no character count");
  assert.equal(r.pick, "SPACE", "the space label maps back to a space");
  assert.equal(r.char, " ", "double spaces are fine for a doornail");
});

test("Rock: one Choice whose options are the whole answers they'd make, plus characters left", async () => {
  const jev = recorder('"Par"');
  const r = await rockCharacter("What is the capital of France?", "Pa", jev);
  assert.equal(jev.requests.length, 1, "R is 90% sure in round one, so the tournament stops there");
  assert.equal(r.stoppedEarly, true);
  const { state, questions } = jev.requests[0];
  assert.deepEqual(state, { question: "What is the capital of France?", characters_remaining: MAX_LENGTH - 2 }, "the options carry the answer");
  const { criteria, instructions } = questions.next;
  const labels = Object.keys(criteria);
  for (const label of ['"Par"', '"Pa "', '"Pa / "', '"Pa."', '"Pa4"', '"Pa" (done)']) assert.ok(labels.includes(label), label);
  assert.ok(!labels.includes('"PaR"'), "letters are cased as they'd be typed");
  assert.equal(criteria['"Par"'], null, "a letter needs no description");
  assert.match(criteria['"Pa" (done)'], /finished/);
  assert.match(instructions, /possible answer/);
  assert.equal(r.pick, "R");
  assert.equal(r.char, "r");

  const first = recorder('"P"');
  const opening = await rockCharacter("q", "", first);
  assert.equal(opening.pick, "P");
  assert.ok(!Object.keys(first.requests[0].questions.next.criteria).some((l) => l.endsWith("(done)")), "can't end before writing anything");
});

test("Rock's tournament: the top 5 of round one go on, then the top 2, and the final decides", async () => {
  // Round one prefers A > B > C > D > E > F; round two flips to E; the final flips again to B.
  const prefs = [
    { '"A"': 0.3, '"B"': 0.25, '"C"': 0.2, '"D"': 0.1, '"E"': 0.08, '"F"': 0.07 },
    { '"A"': 0.1, '"B"': 0.3, '"C"': 0.05, '"D"': 0.05, '"E"': 0.5 },
    { '"B"': 0.7, '"E"': 0.3 },
  ];
  const requests = [];
  const systemOne = async (req) => {
    const labels = Object.keys(req.questions.next.criteria);
    const p = prefs[requests.length];
    requests.push(labels);
    return { answers: { next: { type: "choice", probabilities: Object.fromEntries(labels.map((l) => [l, p[l] ?? 0])) } }, usage: { input_tokens: 10, output_tokens: 0 } };
  };
  const r = await rockCharacter("q", "", { systemOne });
  assert.equal(requests.length, 3);
  assert.ok(requests[0].length > 40, "round one is every option");
  assert.deepEqual(requests[1].slice().sort(), ['"A"', '"B"', '"C"', '"D"', '"E"'].sort());
  assert.deepEqual(requests[2].slice().sort(), ['"B"', '"E"']);
  assert.equal(r.pick, "B", "the final's winner, not round one's");
  assert.equal(r.tokens, 30, "all three rounds are counted");
  assert.deepEqual(r.rounds.map((round) => round.size), [requests[0].length, 5, 2], "each round's size, for the tooltip");
  assert.deepEqual(r.rounds[0].top.map((t) => t.option), ["A", "B", "C", "D", "E"]);
  assert.deepEqual(r.rounds[2].top, [{ option: "B", p: 0.7 }, { option: "E", p: 0.3 }]);
  assert.equal(r.stoppedEarly, false, "a sure final isn't stopping early");
});

test("Rock's tournament stops as soon as a round is 90% sure", async () => {
  const prefs = [{ '"A"': 0.6, '"B"': 0.3 }, { '"B"': 0.92, '"A"': 0.08 }];
  const requests = [];
  const systemOne = async (req) => {
    const labels = Object.keys(req.questions.next.criteria);
    const p = prefs[requests.length];
    requests.push(labels);
    return { answers: { next: { type: "choice", probabilities: Object.fromEntries(labels.map((l) => [l, p[l] ?? 0])) } } };
  };
  const r = await rockCharacter("q", "", { systemOne });
  assert.equal(requests.length, 2, "no final");
  assert.equal(r.pick, "B");
  assert.equal(r.stoppedEarly, true);
  assert.equal(r.rounds.length, 2);
});

test("Rock lists its options in a fresh random order every request", async () => {
  const orders = new Set();
  const systemOne = async (req) => {
    orders.add(Object.keys(req.questions.next.criteria).join("|"));
    return { answers: { next: { type: "choice", probabilities: {} } } };
  };
  for (let i = 0; i < 5; i++) await rockCharacter("q", "Pa", { systemOne });
  assert.ok(orders.size > 5, `only ${orders.size} different orders across 15 requests`);
});

test("pickNext: Doornail ignores memory; Stump drops history when memory is off", async () => {
  const history = [{ question: "What is the capital of France?", answer: "Paris" }];
  const doornail = recorder();
  await pickNext("What about Germany?", "", history, { level: "doornail", ...doornail });
  assert.equal(doornail.requests.length, 1);
  assert.equal("previous_turns" in doornail.requests[0].state, false);
  const rock = recorder();
  await pickNext("What about Germany?", "", history, { level: "rock", memory: true, ...rock });
  assert.equal(rock.requests.length, 3);
  assert.ok(rock.requests.every((r) => !("previous_turns" in r.state)), "Rock ignores memory too");

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
    const postLevel = recorder();
    assert.equal((await handle(post({ question: "Hi", answer: "", level: "post", history }), postLevel)).status, 200);
    assert.ok(postLevel.requests[0].questions.kind, "Post asks for the kind first");
    assert.deepEqual(postLevel.requests[0].state.previous_turns, history);
    assert.equal((await handle(post({ question: "Hi", answer: "", level: "boulder" }))).status, 400);

    const doornail = recorder();
    assert.equal((await handle(post({ question: "Hi", answer: "", level: "doornail", history }), doornail)).status, 200);
    assert.equal(doornail.requests.length, 1);
    assert.deepEqual(Object.keys(doornail.requests[0].state), ["question", "answer_so_far"]);

    const rock = recorder();
    assert.equal((await handle(post({ question: "Hi", answer: "", level: "rock", history }), rock)).status, 200);
    assert.equal(rock.requests.length, 3);
    assert.deepEqual(Object.keys(rock.requests[0].state), ["question", "characters_remaining"]);

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

test("saved turns keep their level and whether they were stopped", async () => {
  const { cleanTurn } = await import("../lib/chats.js");
  const base = { question: "Q", answer: "Hel", tokens: 1, cost: 0 };
  assert.equal(cleanTurn({ ...base, level: "doornail", stopped: true }).level, "doornail");
  assert.equal(cleanTurn({ ...base, level: "doornail", stopped: true }).stopped, true);
  assert.equal(cleanTurn({ ...base, level: "post" }).level, "post");
  assert.equal("level" in cleanTurn({ ...base, level: "boulder" }), false, "only playable levels");
  assert.equal("stopped" in cleanTurn({ ...base, stopped: "yes" }), false, "only a real true");
  assert.equal("stopped" in cleanTurn(base), false);
});

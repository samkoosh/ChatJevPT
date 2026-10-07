import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedOptions, labelFor, textFor, ANSWER_PATTERN } from "../lib/jev.js";

const extras = (answer) => allowedOptions(answer).filter((o) => !/^[A-Z0-9]$/.test(o));
const has = (answer, kind) => allowedOptions(answer).some((o) => (kind === "letters" ? /^[A-Z]$/ : /^[0-9]$/).test(o));

test("an empty answer starts with a letter or digit, never punctuation, space or END", () => {
  assert.deepEqual(extras(""), []);
  assert.ok(has("", "letters") && has("", "digits"));
});

test("a space or newline only follows a real word", () => {
  assert.ok(extras("Paris").includes("SPACE"));
  assert.ok(extras("Paris").includes("NEWLINE"));
  assert.ok(!extras("The b").includes("SPACE"), "one-letter fragments can't end a word");
  assert.ok(extras("So a").includes("SPACE"), '"a" is a real word');
  assert.ok(extras("I").includes("SPACE"), '"I" is a real word');
});

test("no double spaces, no space or newline right after a newline", () => {
  assert.deepEqual(extras("Paris "), []);
  assert.deepEqual(extras("Soft paws\n"), []);
});

test("a word can't repeat back to back", () => {
  assert.ok(!extras("So a a").includes("SPACE"));
  assert.ok(!extras("the the").includes("END"));
  assert.ok(!extras("5 5").includes("SPACE"));
});

test("END only after a complete word, number or sentence", () => {
  assert.ok(extras("Paris").includes("END"));
  assert.ok(extras("Paris.").includes("END"));
  assert.ok(extras("It is 4").includes("END"));
  assert.ok(!extras("The b").includes("END"));
  assert.ok(!extras("Hi,").includes("END"));
  assert.ok(!extras("don'").includes("END"));
});

test("punctuation placement", () => {
  assert.deepEqual(extras("Hi,"), ["SPACE", "NEWLINE"]);
  assert.ok(!extras("Yes!").includes(","));
  assert.ok(extras("Wait.").includes("."), "ellipsis can grow");
  assert.ok(!extras("Wait...").includes("."), "but stops at three");
  assert.ok(!has("Paris.", "letters"), "no letters glued to a period");
});

test("numbers: digits continue, decimals and thousands work, no letters glued on", () => {
  assert.ok(has("It is 4", "digits"));
  assert.ok(!has("It is 4", "letters"));
  assert.ok(has("3.", "digits"));
  assert.ok(has("1,", "digits"));
  assert.ok(!has("Hi,", "digits"));
  assert.ok(!has("Paris", "digits"));
});

test("capitalization is decided by code", () => {
  assert.equal(textFor("P", ""), "P");
  assert.equal(textFor("A", "P"), "a");
  assert.equal(textFor("T", "Yes. "), "T");
  assert.equal(textFor("N", "Soft paws\n"), "N");
  assert.equal(textFor("SPACE", "Hi"), " ");
  assert.equal(textFor("NEWLINE", "Hi"), "\n");
  assert.equal(textFor("7", "It is "), "7");
});

test("labels show the resulting text, not bare letters", () => {
  assert.equal(labelFor("U", "The sky is bl"), '"The sky is blu…"');
  assert.equal(labelFor("END", "Paris"), '"Paris" (done)');
  assert.equal(labelFor("NEWLINE", "Soft paws"), '"Soft paws / …"');
  assert.match(labelFor("E", "x".repeat(60)), /^"….{28}…"$/);
});

test("every option's label is unique for a given answer", () => {
  for (const answer of ["", "Paris", "It is 4", "Hi.", "Soft paws\n", "3."]) {
    const labels = allowedOptions(answer).map((o) => labelFor(o, answer));
    assert.equal(new Set(labels).size, labels.length, answer);
  }
});

test("answers the server accepts", () => {
  assert.ok(ANSWER_PATTERN.test("Paris, 1969!\nYes"));
  assert.ok(!ANSWER_PATTERN.test('He said "hi"'));
  assert.ok(!ANSWER_PATTERN.test("<script>"));
});

test("no stutters: a character three times or a short pattern three times", () => {
  assert.ok(!allowedOptions("Yess").includes("S"), "sss");
  assert.ok(allowedOptions("Les").includes("S"), "two in a row is fine");
  assert.ok(!allowedOptions("Seses").includes("E"), "sesese");
  assert.ok(!allowedOptions("Endndn").includes("D"), "ndndnd");
  assert.ok(!allowedOptions("Abcabcab").includes("C"), "abcabcabc");
});

test("a runaway word has to end at 18 letters", () => {
  const long = "Supercalifragilist"; // 18 letters
  assert.ok(!allowedOptions(long).some((o) => /^[A-Z]$/.test(o)));
  assert.ok(allowedOptions(long).includes("SPACE"));
});

test("letters only go where they keep spelling a real word", () => {
  const letters = (answer) => allowedOptions(answer).filter((o) => /^[A-Z]$/.test(o)).join("");
  assert.equal(letters("Barl"), "EO", "barley, barlow");
  assert.ok(letters("The bl").includes("U"));
  assert.ok(!letters("The bl").includes("Z"));
  assert.equal(letters("don'"), "DLMRSTV", "contractions after an apostrophe");
});

test("a word can only end once it's a real word", () => {
  assert.ok(!allowedOptions("The bl").includes("SPACE"), '"bl" is not a word');
  assert.ok(!allowedOptions("It is th").includes("END"));
  assert.ok(allowedOptions("Be").includes("SPACE"));
  assert.ok(allowedOptions("Shakespeare").includes("END"));
});

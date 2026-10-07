// TEMPORARY (preview only): compares labels for the space option in Rock. Removed before merging.
import { TypeSafeClient, choice } from "@typesafe-ai/sdk";

const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
const DIGITS = [..."0123456789"];
const PUNCT = [".", ",", "!", "?", ":", ";", "'", "-"];
const INSTRUCTIONS = "Which character should come next in `answer_so_far` to answer `question`?";
const NEWLINE = "A line break (as though the keyboard's Return key was pressed).";
const END = "The end of the answer, used to immediately stop generation. Use when the answer is satisfactory and complete.";

const SPACE_DESC = "A space between words (as though the keyboard's space bar was pressed).";
// [space label, space description, include characters_remaining, describe NEWLINE/END]
const VARIANTS = {
  "old Rock (SPACE, nothing described, no remaining)": ["SPACE", null, false, false],
  "space described, no remaining, no NEWLINE/END text": [" ", SPACE_DESC, false, false],
  "space described + remaining, no NEWLINE/END text": [" ", SPACE_DESC, true, false],
  "space described + NEWLINE/END text, no remaining": [" ", SPACE_DESC, false, true],
  "everything (what you asked for)": [" ", SPACE_DESC, true, true],
};

export async function GET() {
  if (process.env.VERCEL_ENV !== "preview") return new Response("Not found", { status: 404 });
  const client = new TypeSafeClient();
  const questions = ["What is the capital of France?", "What color is the sky?", "Say hi to Bob"];
  const out = {};
  await Promise.all(
    Object.entries(VARIANTS).map(async ([name, [label, desc, remaining, described]]) => {
      out[name] = await Promise.all(
        questions.map(async (question) => {
          let answer = "";
          for (let i = 0; i < 30; i++) {
            const criteria = Object.fromEntries([...LETTERS, ...DIGITS, ...PUNCT].map((c) => [c, null]));
            criteria[label] = desc;
            criteria.NEWLINE = described ? NEWLINE : null;
            if (answer.trim()) criteria.END = described ? END : null;
            const state = { question, answer_so_far: answer };
            if (remaining) state.characters_remaining = 200 - answer.length;
            const { answers } = await client.systemOne({
              state,
              questions: { next: choice(INSTRUCTIONS, criteria) },
            });
            const p = answers.next.probabilities;
            const pick = Object.keys(p).reduce((a, b) => (p[b] > p[a] ? b : a));
            if (pick === "END") break;
            answer += pick === label ? " " : pick === "NEWLINE" ? "\n" : pick;
          }
          return JSON.stringify(answer);
        }),
      );
    }),
  );
  return Response.json(out);
}

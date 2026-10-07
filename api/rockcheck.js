// TEMPORARY (preview only): compares labels for the space option in Rock. Removed before merging.
import { TypeSafeClient, choice } from "@typesafe-ai/sdk";

const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
const DIGITS = [..."0123456789"];
const PUNCT = [".", ",", "!", "?", ":", ";", "'", "-"];
const INSTRUCTIONS = "Which character should come next in `answer_so_far` to answer `question`?";
const NEWLINE = "A line break (as though the keyboard's Return key was pressed).";
const END = "The end of the answer, used to immediately stop generation. Use when the answer is satisfactory and complete.";

const VARIANTS = {
  "bare space": { label: " ", desc: null },
  "space + description": { label: " ", desc: "A space between words." },
  "SPACE + description": { label: "SPACE", desc: "A space between words (as though the keyboard's space bar was pressed)." },
  "␣ + description": { label: "␣", desc: "A space between words (as though the keyboard's space bar was pressed)." },
};

export async function GET() {
  if (process.env.VERCEL_ENV !== "preview") return new Response("Not found", { status: 404 });
  const client = new TypeSafeClient();
  const questions = ["What is the capital of France?", "What color is the sky?", "Say hi to Bob"];
  const out = {};
  await Promise.all(
    Object.entries(VARIANTS).map(async ([name, v]) => {
      out[name] = await Promise.all(
        questions.map(async (question) => {
          let answer = "";
          for (let i = 0; i < 30; i++) {
            const criteria = Object.fromEntries([...LETTERS, ...DIGITS, ...PUNCT].map((c) => [c, null]));
            criteria[v.label] = v.desc;
            criteria.NEWLINE = NEWLINE;
            if (answer.trim()) criteria.END = END;
            const { answers } = await client.systemOne({
              state: { question, answer_so_far: answer, characters_remaining: 200 - answer.length },
              questions: { next: choice(INSTRUCTIONS, criteria) },
            });
            const p = answers.next.probabilities;
            const pick = Object.keys(p).reduce((a, b) => (p[b] > p[a] ? b : a));
            if (pick === "END") break;
            answer += pick === v.label ? " " : pick === "NEWLINE" ? "\n" : pick;
          }
          return JSON.stringify(answer);
        }),
      );
    }),
  );
  return Response.json(out);
}

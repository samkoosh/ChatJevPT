# ChatGPJev

A fake transformer. Ask a question and [Jev](https://typesafe.ai) (TypeSafe AI's System One model) writes a
140-character answer **one letter at a time**: every character is its own Jev **Choice** question over
`A`–`Z`, plus `SPACE` and `END`. The site takes the most probable letter (a random one on a tie),
appends it, and asks again with the answer so far and the characters remaining.

Hover or tap any letter to see the other letters Jev considered and their probabilities.

## How it works

- `public/` — the chat UI (plain HTML/CSS/JS). It loops, calling `/api/next` once per character, so the
  answer types out live and Stop works instantly.
- `api/next.js` — Vercel function. Validates input and returns `{ pick, top, tied }`.
- `lib/jev.js` — builds the Choice question and picks the letter. Code, not Jev, enforces the mechanical
  rules: no leading or double spaces, and no `END` before anything has been written.

## Setup

1. Create an API key at <https://console.typesafe.ai>.
2. **Vercel:** Project → Settings → Environment Variables → add `TYPESAFE_API_KEY`, then redeploy.
3. **Local:** `cp .env.example .env`, paste the key, `npm install`, `npm run dev` → <http://localhost:3000>.

`npm run dev:mock` runs the UI against a fake Jev, no key needed.

The key stays on the server; the browser only talks to `/api/next`. Each answer costs up to 140 Jev
calls, which at TypeSafe's list price is a fraction of a cent.

## Claude Code

`.claude/settings.json` registers the `typesafe-ai` plugin marketplace (`typesafe-ai/skills`) and enables
the `typesafe` plugin, so cloud sessions on this repo get the `/typesafe-ai` skill.

# ChatJevPT

**A fake transformer, built out of a classifier.**

Ask ChatJevPT a question and it answers the way a language model does: one token at a time. Except the
"model" is [Jev](https://typesafe.ai), TypeSafe AI's System One model, which doesn't generate text at
all. It answers typed questions with probabilities. So ChatJevPT asks Jev the same multiple-choice
question over and over:

> Given this question, the answer so far, and the characters remaining, what's the best next letter?
> **A, B, C … Z, SPACE, or END?**

The most probable letter wins (a coin flip on ties), gets appended, and Jev is asked again, up to an
old-school tweet's **140 characters**. The answer types out live in a dark, Claude-style chat UI.

## Features

- **Live, letter-by-letter answers** with a running counter of characters, Jev calls and time.
- **See inside the "model"**: hover (or tap, on mobile) any letter to see Jev's top five candidates and
  their probabilities. Letters that won a tie are underlined.
- **Stop, Retry, Copy and New chat**, like the chat apps it's imitating.
- **Out-of-credits notice**: if the TypeSafe account runs dry, visitors see a clear "Out of Jev credits"
  message instead of a generic error.
- **Works on mobile, Chrome and Safari**: on touch screens Enter adds a newline (tap send instead) and
  the keyboard stays out of the way while an answer types out.

## How it works

```
browser (public/app.js)                    Vercel function (api/next.js)          TypeSafe
  loop until END or 140 chars:
    POST /api/next {question, answer}  ──▶  build one Choice question      ──▶   Jev
                                       ◀──  pick highest-probability       ◀──   probabilities
    append letter, show it                  option (random on tie)
```

- **`public/`**: the chat UI in plain HTML, CSS and JS, with no build step. The browser drives the loop,
  one request per character, so the answer streams naturally, Stop is instant, and no single server
  request runs long.
- **`api/next.js`**: validates input, calls Jev, and maps errors (rate limits, out of credits).
- **`lib/jev.js`**: builds the Choice question and picks the letter. Code, not Jev, enforces the
  mechanical rules: no leading or double spaces, and no `END` before anything has been written.
- The API key lives only on the server. The browser never sees it.

Answers are uppercase letters and spaces only; the UI shows them in sentence case. Punctuation and
digits could be added as extra Choice options.

## Setup

### 1. Get a TypeSafe API key

Create one at <https://console.typesafe.ai> under API Keys. Treat it like a password: don't commit it.

### 2. Deploy on Vercel

1. Import this repo at <https://vercel.com/new> with the framework preset **Other** (no build command).
2. In **Project → Settings → Environment Variables**, add `TYPESAFE_API_KEY` with your key.
3. Redeploy so the function picks up the variable.

Every push to `main` deploys to production, and other branches get preview URLs.

### 3. Run locally (optional)

Needs Node.js 20+.

```sh
npm install
cp .env.example .env   # then paste your key into .env
npm run dev            # http://localhost:3000
```

Or try the UI with a fake Jev, no key needed:

```sh
npm run dev:mock
```

## Cost

Each answer is up to 140 Jev calls, one per character. Every call sends the question and the answer so
far, so it's small, and a whole answer costs a fraction of a cent at TypeSafe's list pricing. The
`/api/next` endpoint is public, so anyone with the link spends your credits. If that becomes a problem,
add rate limiting to `/api/next`.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | Yes | Your TypeSafe API key |
| `TYPESAFE_DEFAULT_MODEL` | No | Model override (defaults to `jev-latest`) |
| `JEV_MOCK` | No | Set to `1` to use the fake Jev (local dev only) |

## Working on this with Claude Code

`.claude/settings.json` registers TypeSafe's plugin marketplace
([`typesafe-ai/skills`](https://github.com/typesafe-ai/skills)) and enables its `typesafe` plugin, so
Claude Code sessions on this repo, including cloud sessions, get the `/typesafe-ai` skill with Jev's
docs and patterns.

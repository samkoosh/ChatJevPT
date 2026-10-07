# ChatJevPT

**A fake transformer, built out of a classifier.**

Ask ChatJevPT a question and it answers the way a language model does: one token at a time. Except the
"model" is [Jev](https://typesafe.ai), TypeSafe AI's System One model, which doesn't generate text at
all. It answers typed questions with probabilities. So ChatJevPT asks Jev the same multiple-choice
question over and over:

> Given this question, the answer so far, and the characters remaining, what's the best next character?
> **A–Z, 0–9, a space, a new line, punctuation, or END?**

The most probable character wins, gets appended, and Jev is asked again, up to **200 characters**. If letters tie, they go to a runoff round between just the tied options. Jev can
also stop early once the answer is complete. The answer types out live in a dark, Claude-style chat UI.

## Features

- **Live, letter-by-letter answers** with a progress bar and a Stop button while typing.
- **See inside the "model"**: hover (or tap, on mobile) any letter to see Jev's top five candidates and
  their probabilities. Characters that won a tie are underlined.
- **Follow-up questions**: earlier turns in the chat are sent along, so "What about Germany?" after
  "What is the capital of France?" gets "Berlin". New chat starts fresh.
- **Jev grades its own answers**: when an answer finishes, one more Jev call (a five-level Score
  question, with the chat context) tags it **Terrible, Bad, Solid, Good or Perfect**. In testing the
  tag tracked correctness well: right answers came back Perfect, rambling ones Bad or Terrible.
- **Running cost meter**: the header shows what the chat has cost so far in Jev tokens and dollars, and
  each answer shows its own cost.
- **Stop, Retry, Copy and New chat**, like the chat apps it's imitating.
- **Out-of-credits notice**: if the TypeSafe account runs dry, visitors see a clear "Out of Jev credits"
  message instead of a generic error.
- **Works on mobile, Chrome and Safari**: on touch screens Enter adds a newline (tap send instead) and
  the keyboard stays out of the way while an answer types out.

## How it works

```
browser (public/app.js)                    Vercel function (api/next.js)          TypeSafe
  loop until END or 200 chars:
    POST /api/next {question, answer,  ──▶  build one Choice question      ──▶   Jev
                    history}
                                       ◀──  pick highest-probability       ◀──   probabilities
    append letter, show it                  option (random on tie)
```

- **`public/`**: the chat UI in plain HTML, CSS and JS, with no build step. The browser drives the loop,
  one request per character, so the answer streams naturally, Stop is instant, and no single server
  request runs long.
- **`api/next.js`**: validates input, calls Jev, and maps errors (rate limits, out of credits).
- **`lib/jev.js`**: builds the questions and picks the character (details below).
- The API key lives only on the server. The browser never sees it.

### What Jev is asked, per character

Two rounds, still one character per step:

1. **Screening** (one parallel request of Nouls): every candidate character gets its own yes/no question, "is
   this still heading toward a sensible answer?", shown as the text it would produce. Alongside it:
   - **`done`**: "Does the answer already fully answer the question?" Above 0.6, the answer stops.
   - **`word_done`**, while a short word (4 letters or less) is being spelled: "Is `be` a finished word
     here?" If not, ending the word is masked out, so "Be…" can still become "Berlin".
   - **`repeat_ok`**, when the answer starts repeating itself: "Does the question ask for repetition?"
     If not, a repeating word can't be finished ("say duck 6 times" still works).
   - **The sense check**, after each finished word, as a separate request that sees only the answer
     text (no question or chat): "Does this make sense so far?" Below 0.35 the answer stops with a
     "Jev got too spicy" notice, unless the question asked for repetition.

   Candidates scoring 0.3 or more pass (at least the best 2 always do). If only one option exists, it's
   picked without a ranking call. Both thresholds live at the top of the screening code in `lib/jev.js`.
2. **Ranking**, a Choice over the survivors. Each option's label is the text it would produce, like
   `"The sky is blu…"`, not a bare letter: Jev treated labels like `A` and `B` as multiple-choice letters
   and picked them regardless of meaning. Option order is shuffled every call for the same reason. Each
   letter's description names real words it leads to, e.g. `Continue the word as "blu" (as in: blue,
   blues, bluff)`.

Ties in `next` go to up to two runoff Choices between only the tied options. A coin flip only happens
if they're still tied after that.

Code, not Jev, enforces the mechanical rules, so Jev never sees an option that breaks them:

- Capitalization at the start of sentences and lines.
- **Real words only.** A letter is offered only if the word so far can still become one of the 60,000
  most common English words ([SUBTLEX-US](https://www.npmjs.com/package/subtlex-word-frequencies)
  spoken-English frequencies, which include names like Paris, Jupiter and Shakespeare), and a word can
  end only once it is one. `lib/words.js` is generated by `scripts/build-words.mjs`.
- Spaces and new lines only after a word or number, never doubled.
- Numbers: digits continue, `3.14` and `1,000` work, no letters glued onto numbers.
- Punctuation `. , ! ? : ; ' -` only where it makes sense, e.g. no space before a period. Quotes and
  parentheses were left out because Jev looped on them.
- No word repeated back to back, no stutters ("sss", "ndndnd"), no word longer than 18 letters.

Jev is good at short factual answers ("Paris", "Blue", "1969") and drifts into real-but-rambling words
on long ones. That's the joke.

## Tests

Three suites, so the UI can be tested without spending Jev calls:

| Command | What it tests | Calls Jev? |
| --- | --- | --- |
| `npm test` | Option rules, picking, runoffs, history, cost, dictionary, API validation, with a fake Jev | No |
| `npm run test:ui` | The chat UI in headless Chromium; `/api/next` is spoofed in the browser | No |
| `npm run test:content` | Answer quality: a fixed question set (`lib/eval.js`) run 3 times each against real Jev, headless | Yes, about $0.07 a run |

`test:ui` needs Chromium: `npx playwright install chromium`, or point `CHROMIUM_PATH` at an existing
binary. `test:content` needs `TYPESAFE_API_KEY` in `.env`.

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

Each character takes about two Jev requests (screening, then ranking; plus a sense check after each word
and a runoff when letters tie), and each answer one more for its rating. Every request
sends the question and the answer so far, so it's small: a whole answer costs a fraction of a cent at
TypeSafe's list price ($0.042 per million input tokens; output is free). The header's cost meter shows
the running total. The
`/api/next` endpoint is public, so anyone with the link spends your credits. If that becomes a problem,
add rate limiting to `/api/next`.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | Yes | Your TypeSafe API key |
| `TYPESAFE_DEFAULT_MODEL` | No | Model override (defaults to `jev-latest`) |
| `JEV_PRICE_PER_MTOK` | No | Price per million tokens for the cost meter (defaults to `0.042`) |
| `JEV_MOCK` | No | Set to `1` to use the fake Jev (local dev only) |

## Working on this with Claude Code

`.claude/settings.json` registers TypeSafe's plugin marketplace
([`typesafe-ai/skills`](https://github.com/typesafe-ai/skills)) and enables its `typesafe` plugin, so
Claude Code sessions on this repo, including cloud sessions, get the `/typesafe-ai` skill with Jev's
docs and patterns.

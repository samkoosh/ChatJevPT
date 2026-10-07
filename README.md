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

## Themes

The switch in the top bar flips between two looks:

- **Modern** (the default): the dark, Claude-style UI.
- **✨ Y2K**: a lovingly bad 1999 homepage. Comic Sans, WordArt, a starfield, Windows 98 dialogs,
  a marquee, blinking NEW! badges, a hit counter, sparkle cursor trails and synthesized sound effects
  (a blip per letter, a dial-up chirp on send, a ding when done, a sad trombone for Terrible, a fanfare
  for Perfect, a sizzle when Jev gets too spicy). The speaker button next to the switch mutes it.

Switching never touches the chat: it only sets `<html data-ui-theme="y2k">`, so an answer that's
typing keeps typing. The choice (and the mute) is saved in `localStorage` and applied by a small
inline script in `<head>` before first paint. The theme lives in `public/themes/y2k.css` (everything
scoped under `[data-ui-theme="y2k"]`) and `public/theme.js` (switch, decorations, sounds), which
listens for `jev:send`, `jev:char`, `jev:done`, `jev:rated` and `jev:error` events from `app.js`.
Sounds play only in Y2K, only after you've clicked or typed, and `prefers-reduced-motion` turns the
animations off.

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
- **Accounts** (optional, see [Accounts](#accounts)): `lib/auth.js` (sign-in, sessions, budgets), `lib/store.js`
  (Postgres or in-memory), `lib/chats.js`, and the handlers in `api/me.js`, `api/auth/`, `api/chats/`, `api/admin/`.
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
| `npm test` | Option rules, picking, runoffs, history, cost, dictionary, API validation, accounts (sessions, Google tokens, CSRF, budgets, chats, admin), with a fake Jev and an in-memory store | No |
| `npm run test:ui` | The chat UI, both themes, accounts UI and admin page in headless Chromium; every `/api/*` route and Google's script are spoofed in the browser | No |
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
the running total. Without accounts,
`/api/next` is public, so anyone with the link spends your credits. Turn on [Accounts](#accounts) to
limit it to people you allow, each with a monthly budget.

## Accounts

Optional Google sign-in, so only people you allow can use ChatJevPT, each with a monthly budget and up
to 5 saved chats.

### How it works

- The page shows Google's **Sign in with Google** button. Google hands the browser an ID token, which it
  posts to `POST /api/auth/google`. The server verifies it against Google's public keys (issuer, audience
  = your client ID, expiry, verified email).
- **Allowlist**: you get in if you're in the `users` table with status `allowed`, or listed in
  `ADMIN_EMAILS` (added as an admin on first sign-in). Anyone else sees "You're not on the list yet" and
  shows up under **Waiting for access** on the admin page, where one click lets them in.
- The server then sets its own session cookie (`__Host-session`, HttpOnly, Secure, SameSite=Lax, 7 days,
  signed with `SESSION_SECRET`). On `http://localhost` it's called `session` and isn't Secure.
- Every Jev call checks the person's budget first and charges the actual tokens and cost afterwards.
  When the month's budget is used, they see "Monthly budget used" until the 1st (UTC).
- **Admins have no budget limit.** Everyone with role admin, including everyone in `ADMIN_EMAILS`, is
  never blocked; their usage is still recorded and shown ("Usage: $X this month · no limit").
- **Saved chats**: signed-in people get a sidebar with up to 5 chats (50 questions each). The server
  keeps the history: requests send a `chatId` and the server uses that chat's last 6 turns, ignoring any
  history from the browser.
- Writes (POST/PUT/DELETE) must come from the page itself: same `Origin` and a JSON content type,
  otherwise 403.
- `/admin.html` (admins only): everyone's spend this month, tokens, budget and last sign-in; edit
  budgets inline, block or unblock, approve requests, add people.

### Three modes

| `GOOGLE_CLIENT_ID`, `SESSION_SECRET`, `DATABASE_URL` | Behavior |
| --- | --- |
| **None** set | Accounts are off. The app works exactly as before (open demo); `/api/me` says `{authEnabled:false}`. |
| **All** set | Sign-in is required for everything. |
| **Some** set | Fails closed: Jev, chat and admin endpoints return 500 "Sign-in is half set up: missing X, Y." |

`STORE=memory` counts as a database (local dev and tests only: it forgets everything on restart).

### Data model

Neon Postgres; tables are created on first use (`CREATE TABLE IF NOT EXISTS`), no migrations to run.

- `users`: email (key), Google profile, `role` (`user`/`admin`), `status` (`allowed`/`blocked`),
  `monthly_budget_micros` (null = `DEFAULT_MONTHLY_BUDGET_USD`), created and last-seen times.
- `usage`: one row per person per UTC day (tokens, cost in micro-dollars, calls); the month is a sum.
  Charges are a single atomic upsert, so parallel requests can't lose usage.
- `chats`: id, owner, title, `turns` as JSON (question, answer, rating, tokens, cost).
- `access_requests`: who asked to get in, and when.

The budget check runs before each call, so a few parallel requests can overshoot it by a fraction of a
cent.

### Owner setup checklist

1. **Google Cloud Console** (<https://console.cloud.google.com>):
   1. Create a project.
   2. **Google Auth Platform → Get started**: app name, support email, audience **External**.
   3. **Clients → Create client → Web application**.
   4. **Authorized JavaScript origins**: `https://chatjevpt.vercel.app`, `http://localhost`,
      `http://localhost:3000`. No redirect URIs and no client secret are needed.
   5. Copy the client ID (`….apps.googleusercontent.com`).
2. **Vercel → Storage → Create Database → Neon → Free**, then connect it to the chatjevpt project for
   all environments. This sets `DATABASE_URL`.
3. **Vercel → Settings → Environment Variables**:
   - `GOOGLE_CLIENT_ID`: the client ID from step 1.
   - `SESSION_SECRET`: the output of `openssl rand -base64 32`. Use different values for Production and
     Preview.
   - `ADMIN_EMAILS`: your Google email (comma-separate several).
   - Optionally `DEFAULT_MONTHLY_BUDGET_USD` (defaults to `1.00`).
4. Redeploy.
5. Sign in, then open `/admin.html` to add people or approve requests.

Preview deployments have their own URLs; add one to the authorized origins if you want to sign in there.

### Local dev with accounts

```sh
npm run dev:accounts   # STORE=memory, DEV_LOGIN_EMAIL=dev@example.com, fake Jev
```

The sign-in card gets a "Sign in as the local dev user" button (`POST /api/auth/dev`), which signs in
`DEV_LOGIN_EMAIL` as an admin. Off Vercel, `DEV_LOGIN_EMAIL` stands in for `GOOGLE_CLIENT_ID`; dev login
is refused whenever `VERCEL` is set, so it can never work on a deployment. To try real Google sign-in
locally, set `GOOGLE_CLIENT_ID` as well and open `http://localhost:3000`.

### Vercel Hobby limits

Hobby includes about 1M function invocations a month. Each character is still one invocation of
`/api/next` (it makes about two Jev requests inside), and each answer one more for its rating, so a
full 200-character answer is roughly 200 invocations: about **5,000 answers a month**, fewer with the
chat and account requests around them. Jev's cost per answer stays a fraction of a cent.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | Yes | Your TypeSafe API key |
| `TYPESAFE_DEFAULT_MODEL` | No | Model override (defaults to `jev-latest`) |
| `JEV_PRICE_PER_MTOK` | No | Price per million tokens for the cost meter (defaults to `0.042`) |
| `JEV_MOCK` | No | Set to `1` to use the fake Jev (local dev only) |
| `GOOGLE_CLIENT_ID` | Accounts | OAuth web client ID from Google Cloud |
| `SESSION_SECRET` | Accounts | Signs session cookies; `openssl rand -base64 32`, different per environment |
| `DATABASE_URL` | Accounts | Neon Postgres connection string (set by the Vercel–Neon integration) |
| `ADMIN_EMAILS` | No | Comma-separated Google emails that are admins (no budget limit) |
| `DEFAULT_MONTHLY_BUDGET_USD` | No | Monthly budget for people without their own (defaults to `1.00`) |
| `STORE` | No | `memory` for an in-memory store (local dev and tests only) |
| `DEV_LOGIN_EMAIL` | No | Local dev only: enables `POST /api/auth/dev` for this email; ignored on Vercel |

## Working on this with Claude Code

`.claude/settings.json` registers TypeSafe's plugin marketplace
([`typesafe-ai/skills`](https://github.com/typesafe-ai/skills)) and enables its `typesafe` plugin, so
Claude Code sessions on this repo, including cloud sessions, get the `/typesafe-ai` skill with Jev's
docs and patterns.

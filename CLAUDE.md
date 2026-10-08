# ChatJevPT notes for Claude

- **Keep the "How it works" page current.** `public/how.html` explains every model level (Doornail,
  Rock, Stump, Post) with flowcharts. Whenever you change how a level picks a character in
  `lib/jev.js` (add or remove a level, a check, a round, a threshold, or change what Jev is asked),
  update that level's section and flowchart in the same change. Numbers (`data-n`) and prompts
  (`data-prompt`) are filled live from `/api/how` (`explainer()` in `lib/jev.js`); add new ones there.
  `test/how.test.js` fails if a level has no section or a number on the page doesn't match the code.
- **Prompts are editable by admins on that page.** Every prompt step is a key in `PROMPT_DEFAULTS`
  (`lib/jev.js`); saved edits come from `savedPrompts()` (`lib/lab.js`) and are passed to `pickNext` /
  `rateAnswer` as `prompts`. A new prompt step should get a key there and a `data-prompt` block on
  the page, rather than a hard-coded string.
- Tests: `npm test` (unit, fake Jev) and `npm run test:ui` (headless Chromium, every `/api/*` spoofed).

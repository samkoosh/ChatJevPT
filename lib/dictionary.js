// Word lookups for spelling: is this a word, could it become one, and common examples.
import WORDS from "./words.js";

const ranked = WORDS.split(" "); // most common first
const rank = new Map(ranked.map((w, i) => [w, i]));
const sorted = [...ranked].sort();

// Endings after an apostrophe, as in it's, don't, I'd, I'm, we're, I've, we'll.
const CONTRACTIONS = ["s", "t", "d", "m", "re", "ve", "ll"];

// Bounds of the alphabetical range of words starting with `prefix`.
function range(prefix) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < sorted.length && sorted[end].startsWith(prefix)) end++;
  return [lo, end];
}

// Subtitle data is full of two-letter fragments ("th", "ll", "bl"), so two-letter words must be
// real ones.
const TWO_LETTER = new Set(
  "to it of in me is we he on my do no be so go up if oh at as an or us by am hi ok ah ha yo ow eh hm ox ex lo ye ya ma pa aw uh um tv mr dr ms".split(" "),
);

export function isWord(word, { afterApostrophe = false } = {}) {
  const w = word.toLowerCase();
  if (afterApostrophe) return CONTRACTIONS.includes(w);
  if (w.length === 2) return TWO_LETTER.has(w);
  return rank.has(w);
}

export function isPrefix(prefix, { afterApostrophe = false } = {}) {
  const p = prefix.toLowerCase();
  if (afterApostrophe) return CONTRACTIONS.some((c) => c.startsWith(p));
  const [lo, end] = range(p);
  return end > lo;
}

// The `n` most common words starting with `prefix`.
export function examples(prefix, n = 3) {
  const [lo, end] = range(prefix.toLowerCase());
  const best = [];
  for (let i = lo; i < end; i++) {
    best.push(sorted[i]);
    if (best.length > n * 8) {
      best.sort((a, b) => rank.get(a) - rank.get(b));
      best.length = n;
    }
  }
  return best.sort((a, b) => rank.get(a) - rank.get(b)).slice(0, n);
}

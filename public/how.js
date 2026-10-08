// "How it works": fills the page's numbers ([data-n]) and prompts ([data-prompt]) from /api/how,
// so they always match the running code. The numbers written in how.html are the fallback.
const prompts = document.querySelectorAll("[data-prompt]");
for (const pre of prompts) pre.textContent = "Loading…";

try {
  const res = await fetch("/api/how");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { numbers, prompts: text } = await res.json();
  for (const el of document.querySelectorAll("[data-n]")) {
    if (numbers[el.dataset.n] !== undefined) el.textContent = numbers[el.dataset.n];
  }
  for (const pre of prompts) pre.textContent = text[pre.dataset.prompt] ?? "(not available)";
} catch {
  for (const pre of prompts) pre.textContent = "Couldn't load the prompts right now.";
}

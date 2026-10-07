const MAX_LENGTH = 140;

const main = document.getElementById("main");
const thread = document.getElementById("thread");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const send = document.getElementById("send");
const tooltip = document.getElementById("tooltip");

let controller = null; // AbortController for the answer being written

const label = (option) => (option === "SPACE" ? "␣" : option === "END" ? "END" : option);

// Jev only has capital letters; show them in sentence case so it reads like a reply.
const display = (raw, index) => (index === 0 ? raw : raw.toLowerCase());

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function icon(path) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
}

function setBusy(busy) {
  send.classList.toggle("stop", busy);
  send.setAttribute("aria-label", busy ? "Stop" : "Send");
  send.disabled = !busy && !input.value.trim();
}

function autosize() {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
  if (!controller) send.disabled = !input.value.trim();
}

function scrollToBottom() {
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
  if (nearBottom) window.scrollTo({ top: document.body.scrollHeight });
}

async function fetchNext(question, answer, signal) {
  const res = await fetch("/api/next", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, answer }),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function renderMeta(meta, { length, calls, ms, done, answerText, question }) {
  meta.innerHTML = "";
  const bar = el("span", "bar");
  const fill = el("i");
  fill.style.width = `${(length / MAX_LENGTH) * 100}%`;
  bar.append(fill);
  meta.append(bar, el("span", null, `${length}/${MAX_LENGTH}`));
  meta.append(el("span", null, `${calls} Jev call${calls === 1 ? "" : "s"}`));
  meta.append(el("span", null, `${(ms / 1000).toFixed(1)}s`));
  if (!done) return;

  const copy = el("button", "act");
  copy.innerHTML = `${icon('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>')}Copy`;
  copy.onclick = async () => {
    await navigator.clipboard.writeText(answerText());
    copy.lastChild.textContent = "Copied";
    setTimeout(() => (copy.lastChild.textContent = "Copy"), 1400);
  };
  const retry = el("button", "act");
  retry.innerHTML = `${icon('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>')}Retry`;
  retry.onclick = () => !controller && ask(question);
  meta.append(copy, retry);
}

async function ask(question) {
  main.classList.remove("empty");
  thread.append(el("div", "msg-user", question));

  const msg = el("div", "msg-jev typing");
  msg.innerHTML = `<svg class="spark avatar" viewBox="0 0 24 24" aria-hidden="true"><use href="#spark"/></svg>`;
  const body = el("div");
  const answerEl = el("div", "answer");
  const caret = el("span", "caret");
  const thinking = el("span", "thinking", "Jev is picking the first letter… ");
  answerEl.append(thinking, caret);
  const meta = el("div", "meta");
  body.append(answerEl, meta);
  msg.append(body);
  thread.append(msg);
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });

  controller = new AbortController();
  setBusy(true);
  const started = performance.now();
  let answer = "";
  let calls = 0;
  const text = () => [...answer].map(display).join("").trim();
  const stats = (done) => ({ length: answer.length, calls, ms: performance.now() - started, done, answerText: text, question });

  try {
    while (answer.length < MAX_LENGTH) {
      const { pick, top, tied } = await fetchNext(question, answer, controller.signal);
      calls++;
      thinking.remove();
      if (pick === "END") break;

      const raw = pick === "SPACE" ? " " : pick;
      const span = el("span", "ch new", display(raw, answer.length));
      span.dataset.top = JSON.stringify(top);
      span.dataset.pick = pick;
      if (tied > 1) {
        span.classList.add("tied");
        span.dataset.tied = tied;
      }
      answerEl.insertBefore(span, caret);
      answer += raw;
      renderMeta(meta, stats(false));
      scrollToBottom();
    }
  } catch (err) {
    thinking.remove();
    if (err.name !== "AbortError") body.insertBefore(el("div", "error", err.message), meta);
  } finally {
    caret.remove();
    msg.classList.remove("typing");
    if (!answer) answerEl.remove();
    renderMeta(meta, stats(true));
    controller = null;
    setBusy(false);
    input.focus();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (controller) return controller.abort();
  const question = input.value.trim();
  if (!question) return;
  input.value = "";
  autosize();
  ask(question);
});

input.addEventListener("input", autosize);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!controller) form.requestSubmit();
  }
});

document.getElementById("suggestions").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || controller) return;
  ask(button.textContent);
});

function newChat() {
  controller?.abort();
  thread.innerHTML = "";
  main.classList.add("empty");
  input.focus();
}
document.getElementById("new-chat").onclick = newChat;
document.getElementById("new-chat-2").onclick = newChat;

// Hover (or tap) a letter to see what else Jev considered.
function showTooltip(span) {
  const top = JSON.parse(span.dataset.top);
  tooltip.innerHTML = "";
  const tied = span.dataset.tied ? ` · ${span.dataset.tied}-way tie, coin flip` : "";
  tooltip.append(el("h4", null, `Jev's top picks${tied}`));
  for (const { option, p } of top) {
    const row = el("div", `row${option === span.dataset.pick ? " picked" : ""}`);
    const track = el("span", "track");
    const fill = el("i");
    fill.style.width = `${Math.max(p * 100, 1)}%`;
    track.append(fill);
    row.append(el("span", null, label(option)), track, el("span", null, `${(p * 100).toFixed(1)}%`));
    tooltip.append(row);
  }
  tooltip.hidden = false;
  const rect = span.getBoundingClientRect();
  const width = tooltip.offsetWidth;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
  const above = rect.top - tooltip.offsetHeight - 10;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${above > 8 ? above : rect.bottom + 10}px`;
  document.querySelector(".ch.active")?.classList.remove("active");
  span.classList.add("active");
}

function hideTooltip() {
  tooltip.hidden = true;
  document.querySelector(".ch.active")?.classList.remove("active");
}

thread.addEventListener("pointerover", (event) => {
  const span = event.target.closest(".ch");
  if (span) showTooltip(span);
});
thread.addEventListener("pointerout", (event) => {
  if (event.target.closest(".ch") && event.pointerType === "mouse") hideTooltip();
});
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".ch")) hideTooltip();
});
window.addEventListener("scroll", hideTooltip, { passive: true });

const MAX_LENGTH = 200;

const main = document.getElementById("main");
const thread = document.getElementById("thread");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const send = document.getElementById("send");
const tooltip = document.getElementById("tooltip");

let controller = null; // AbortController for the answer being written
let history = []; // finished turns in this chat, sent so Jev can follow up
const chatUsage = { tokens: 0, cost: 0 };
let chatId = 0; // bumped by New chat, so late ratings don't count toward the new chat's cost
const costMeter = document.getElementById("cost-meter");

const formatCost = (cost) => (cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`);
const formatTokens = (n) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`);

function addUsage(tokens = 0, cost = 0) {
  chatUsage.tokens += tokens;
  chatUsage.cost += cost;
  costMeter.hidden = chatUsage.tokens === 0;
  costMeter.innerHTML = `<span class="cost-label">This chat: </span><b>${formatCost(chatUsage.cost)}</b> · ${formatTokens(chatUsage.tokens)} tokens`;
}

// On touch devices, Enter inserts a newline and we don't refocus the input,
// which would pop the keyboard over the answer.
const touch = window.matchMedia("(pointer: coarse)").matches;
const refocus = () => !touch && input.focus();


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

async function fetchNext(question, answer, priorTurns, signal) {
  const res = await fetch("/api/next", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, answer, history: priorTurns }),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { code: data.code });
  return data;
}

async function fetchRating(question, answer, priorTurns) {
  const res = await fetch("/api/rate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, answer, history: priorTurns }),
  });
  if (!res.ok) throw new Error(`Rating failed (${res.status})`);
  return res.json();
}

const RATING_HINT = {
  Terrible: "wrong or gibberish",
  Bad: "mostly wrong or garbled",
  Solid: "gets the point across",
  Good: "correct and clear",
  Perfect: "exactly what was asked",
};

function ratingChip(rating) {
  if (rating === "pending") return el("span", "rating pending", "Rating…");
  const chip = el("span", `rating rating-${rating.label.toLowerCase()}`, rating.label);
  chip.title = `Jev rates this answer ${rating.label} (${rating.score.toFixed(1)} of 4): ${RATING_HINT[rating.label]}`;
  return chip;
}

function renderMeta(meta, { length, ms, cost, done, rating, answerText, question, stop }) {
  meta.innerHTML = "";
  if (rating) meta.append(ratingChip(rating));
  if (!done) {
    const bar = el("span", "bar");
    const fill = el("i");
    fill.style.width = `${(length / MAX_LENGTH) * 100}%`;
    bar.append(fill);
    meta.append(bar, el("span", null, `${length}/${MAX_LENGTH} characters`));
  } else {
    meta.append(el("span", null, `${length} character${length === 1 ? "" : "s"}`));
  }
  meta.append(el("span", null, `${(ms / 1000).toFixed(1)}s`));
  meta.append(el("span", null, formatCost(cost)));
  if (!done) {
    const halt = el("button", "act stop-answer");
    halt.innerHTML = `${icon('<rect x="6" y="6" width="12" height="12" rx="2"/>')}Stop`;
    halt.onclick = stop;
    meta.append(halt);
    return;
  }

  const copy = el("button", "act");
  copy.innerHTML = `${icon('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>')}Copy`;
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(answerText());
      copy.lastChild.textContent = "Copied";
    } catch {
      copy.lastChild.textContent = "Couldn't copy";
    }
    setTimeout(() => (copy.lastChild.textContent = "Copy"), 1400);
  };
  const retry = el("button", "act");
  retry.innerHTML = `${icon('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>')}Retry`;
  retry.onclick = () => !controller && ask(question);
  meta.append(copy, retry);
}

function spicyNotice() {
  const notice = el("div", "notice spicy");
  notice.innerHTML = icon('<path d="M12 3c1 3 4 4 4 8a4 4 0 0 1-8 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 0-7Z"/>');
  const text = el("div");
  text.append(el("strong", null, "Jev got too spicy"), el("p", null, "The answer stopped making sense, so Jev cut it off."));
  notice.append(text);
  return notice;
}

function creditsNotice(message) {
  const notice = el("div", "notice");
  notice.innerHTML = icon('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16.2v.3"/>');
  const text = el("div");
  text.append(el("strong", null, "Out of Jev credits"), el("p", null, message));
  notice.append(text);
  return notice;
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
  const myController = controller;
  setBusy(true);
  const started = performance.now();
  const priorTurns = history.slice(-6);
  let answer = "";
  let spicy = false;
  let cost = 0;
  let rating = null;
  let ms = 0;
  const text = () => answer.trim();
  const stats = (done) => {
    if (!done) ms = performance.now() - started; // the clock stops when the answer does
    return { length: answer.length, ms, cost, done, rating, answerText: text, question, stop: () => myController.abort() };
  };

  try {
    while (answer.length < MAX_LENGTH) {
      const step = await fetchNext(question, answer, priorTurns, controller.signal);
      const { pick, char, top, tied, coinFlip, screened, tokens, cost: stepCost } = step;
      cost += stepCost ?? 0;
      addUsage(tokens, stepCost);
      thinking.remove();
      if (pick === "END") {
        if (step.spicy) spicy = true;
        break;
      }

      const span = el("span", "ch new", char);
      span.dataset.top = JSON.stringify(top);
      span.dataset.pick = pick;
      if (screened) span.dataset.screened = screened;
      if (tied > 1) {
        span.classList.add("tied");
        span.dataset.tied = tied;
        if (coinFlip) span.dataset.coin = "1";
      }
      answerEl.insertBefore(span, caret);
      answer += char;
      renderMeta(meta, stats(false));
      scrollToBottom();
    }
  } catch (err) {
    thinking.remove();
    if (err.code === "out_of_credits") body.insertBefore(creditsNotice(err.message), meta);
    else if (err.name !== "AbortError") body.insertBefore(el("div", "error", err.message), meta);
  } finally {
    caret.remove();
    msg.classList.remove("typing");
    if (spicy) body.insertBefore(spicyNotice(), meta);
    stats(false);
    if (!answer) answerEl.remove();
    else history.push({ question, answer: answer.trim() });
    if (answer.trim()) rating = "pending";
    renderMeta(meta, stats(true));
    controller = null;
    setBusy(false);
    refocus();
  }

  // Once the answer is done, Jev grades it (with the same chat context it answered with).
  if (rating !== "pending") return;
  const myChat = chatId;
  try {
    const result = await fetchRating(question, answer.trim(), priorTurns);
    rating = result;
    cost += result.cost ?? 0;
    if (myChat === chatId) addUsage(result.tokens, result.cost);
  } catch {
    rating = null; // a missing grade shouldn't get in the way of the answer
  }
  renderMeta(meta, stats(true));
}

function submit() {
  if (controller) return controller.abort();
  const question = input.value.trim();
  if (!question) return;
  input.value = "";
  autosize();
  ask(question);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  submit();
});

input.addEventListener("input", autosize);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !touch) {
    event.preventDefault();
    if (!controller) submit();
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
  history = [];
  chatId++;
  chatUsage.tokens = 0;
  chatUsage.cost = 0;
  costMeter.hidden = true;
  main.classList.add("empty");
  refocus();
}
document.getElementById("new-chat").onclick = newChat;
document.getElementById("new-chat-2").onclick = newChat;

// Hover (or tap) a letter to see what else Jev considered.
function showTooltip(span) {
  const top = JSON.parse(span.dataset.top);
  tooltip.innerHTML = "";
  const how = span.dataset.coin ? "coin flip" : "runoff";
  const tied = span.dataset.tied ? ` · ${span.dataset.tied}-way tie, ${how}` : "";
  const passed = span.dataset.screened;
  tooltip.append(el("h4", null, `Jev's top picks${tied}`));
  if (passed) tooltip.append(el("p", "screen-note", passed === "1" ? "Only option to pass screening" : `${passed} options passed screening`));
  for (const { option, p } of top) {
    const row = el("div", `row${option === span.dataset.pick ? " picked" : ""}`);
    const track = el("span", "track");
    const fill = el("i");
    fill.style.width = `${Math.max(p * 100, 1)}%`;
    track.append(fill);
    row.append(el("span", null, option), track, el("span", null, `${(p * 100).toFixed(1)}%`));
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

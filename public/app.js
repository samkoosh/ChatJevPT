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
let chatEpoch = 0; // bumped by New chat, so late ratings don't count toward the new chat's cost
const costMeter = document.getElementById("cost-meter");

// Theme hooks: public/theme.js listens for these (Y2K sound effects).
const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
// Accounts, only when the server has them turned on (see /api/me). Signed in, chats are saved
// and the server reads a chat's history itself, so requests carry its id instead.
const MAX_CHATS = 5;
let me = { authEnabled: false };
let chats = []; // the signed-in person's saved chats, newest first
let activeChatId = null; // saved chat on screen; null = a new chat, saved on its first question
const signedIn = () => Boolean(me.user);

const formatCost = (cost) => (cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`);
const formatTokens = (n) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`);

function addUsage(tokens = 0, cost = 0) {
  chatUsage.tokens += tokens;
  chatUsage.cost += cost;
  costMeter.hidden = chatUsage.tokens === 0;
  costMeter.innerHTML = `<span class="cost-label">This chat: </span><b>${formatCost(chatUsage.cost)}</b> · ${formatTokens(chatUsage.tokens)} tokens`;
}

// Counts a Jev call toward their total usage in the account menu (the server charges it too).
function bill(tokens = 0, cost = 0) {
  if (!me.usage) return;
  me.usage.totalCostMicros += Math.round(cost * 1e6);
  me.usage.totalTokens += tokens;
  renderUsage();
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

async function api(method, path, body, signal) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { code: data.code, status: res.status });
  return data;
}

// A saved chat sends its id; the server ignores client history then.
const context = (priorTurns, savedChat) => (savedChat ? { chatId: savedChat } : { history: priorTurns });

function fetchNext(question, answer, priorTurns, signal, savedChat, { level, memory }) {
  return api("POST", "/api/next", { question, answer, level, memory, ...context(priorTurns, savedChat) }, signal);
}

function fetchRating(question, answer, priorTurns, savedChat, { memory }) {
  return api("POST", "/api/rate", { question, answer, memory, ...context(priorTurns, savedChat) });
}

// Model level ("dumb as a ___") and chat memory, chosen in the composer and remembered.
const LEVEL_NAMES = { rock: "Rock", stump: "Stump", post: "Post" };
const prefs = { level: "stump", memory: true };
try {
  const level = localStorage.getItem("jev-level");
  if (level === "rock" || level === "stump") prefs.level = level;
  if (localStorage.getItem("jev-memory") === "off") prefs.memory = false;
} catch {}

const levelButtons = [...document.querySelectorAll(".level-option")];
const memoryToggle = document.getElementById("memory-toggle");

function renderPrefs() {
  for (const b of levelButtons) b.setAttribute("aria-checked", String(b.dataset.level === prefs.level));
  const rock = prefs.level === "rock";
  memoryToggle.disabled = rock;
  memoryToggle.setAttribute("aria-pressed", String(prefs.memory && !rock));
  memoryToggle.title = rock
    ? "Rocks don't remember anything"
    : prefs.memory
      ? "Memory on: Jev sees earlier questions in this chat"
      : "Memory off: each question stands alone";
}

function savePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

for (const b of levelButtons) {
  b.addEventListener("click", () => {
    if (b.disabled || b.dataset.level === "post") return;
    prefs.level = b.dataset.level;
    savePref("jev-level", prefs.level);
    renderPrefs();
  });
}
memoryToggle.addEventListener("click", () => {
  prefs.memory = !prefs.memory;
  savePref("jev-memory", prefs.memory ? "on" : "off");
  renderPrefs();
});
renderPrefs();

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

function renderMeta(meta, { length, ms, cost, done, rating, answerText, question, level, stop }) {
  meta.innerHTML = "";
  if (rating) meta.append(ratingChip(rating));
  if (level) meta.append(el("span", `level-tag level-${level}`, LEVEL_NAMES[level]));
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
  appendActions(meta, answerText, question);
}

function appendActions(meta, answerText, question) {
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

// Errors that get a notice instead of a plain error line.
const NOTICES = {
  out_of_credits: "Out of Jev credits",
  budget_exhausted: "Allowance used up",
  chat_limit: "Chat limit reached",
  chat_full: "This chat is full",
};

function errorNotice(code, message) {
  const notice = el("div", `notice notice-${code.replace(/_/g, "-")}`);
  notice.innerHTML = icon('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16.2v.3"/>');
  const text = el("div");
  text.append(el("strong", null, NOTICES[code]), el("p", null, message));
  notice.append(text);
  return notice;
}

async function ask(question) {
  if (me.authEnabled && !signedIn()) return showSignIn();
  main.classList.remove("empty");
  thread.append(el("div", "msg-user", question));
  emit("jev:send");

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
  const settings = { level: prefs.level, memory: prefs.memory && prefs.level !== "rock" }; // fixed for this answer
  const myChat = chatEpoch;
  let savedChat = signedIn() ? activeChatId : null;
  let lostSession = null;
  let answer = "";
  let spicy = false;
  let tokens = 0;
  let cost = 0;
  let rating = null;
  let ms = 0;
  const text = () => answer.trim();
  const stats = (done) => {
    if (!done) ms = performance.now() - started; // the clock stops when the answer does
    return { length: answer.length, ms, cost, done, rating, answerText: text, question, level: settings.level, stop: () => myController.abort() };
  };

  try {
    if (signedIn() && !savedChat) savedChat = await createChat(controller.signal);
    while (answer.length < MAX_LENGTH) {
      const step = await fetchNext(question, answer, priorTurns, controller.signal, savedChat, settings);
      const { pick, char, top, tied, coinFlip, screened, cost: stepCost } = step;
      tokens += step.tokens ?? 0;
      cost += stepCost ?? 0;
      addUsage(step.tokens, stepCost);
      bill(step.tokens, stepCost);
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
      emit("jev:char", char);
      renderMeta(meta, stats(false));
      scrollToBottom();
    }
  } catch (err) {
    thinking.remove();
    if (err.status === 401 || err.code === "blocked") lostSession = err;
    else if (NOTICES[err.code]) body.insertBefore(errorNotice(err.code, err.message), meta);
    else if (err.name !== "AbortError") body.insertBefore(el("div", "error", err.message), meta);
    if (err.name !== "AbortError") emit("jev:error");
  } finally {
    caret.remove();
    msg.classList.remove("typing");
    if (spicy) body.insertBefore(spicyNotice(), meta);
    emit("jev:done", { spicy });
    stats(false);
    if (!answer) answerEl.remove();
    else history.push({ question, answer: answer.trim() });
    if (answer.trim()) rating = "pending";
    renderMeta(meta, stats(true));
    controller = null;
    setBusy(false);
    refocus();
  }

  if (lostSession) return endSession(lostSession.code === "blocked" ? lostSession.message : "Your session ended. Sign in again.");

  // Signed in, the finished turn is saved to its chat, then its rating once Jev gives one.
  const saved = savedChat && answer.trim() ? saveTurn(savedChat, { question, answer: answer.trim(), tokens, cost }) : null;

  // Once the answer is done, Jev grades it (with the same chat context it answered with).
  if (rating !== "pending") return;
  try {
    const result = await fetchRating(question, answer.trim(), priorTurns, savedChat, settings);
    rating = result;
    emit("jev:rated", result.label);
    tokens += result.tokens ?? 0;
    cost += result.cost ?? 0;
    bill(result.tokens, result.cost);
    if (myChat === chatEpoch) addUsage(result.tokens, result.cost);
    const index = await saved;
    if (index != null) {
      const patch = { label: result.label, score: result.score, index, tokens, cost };
      api("PUT", `/api/chats/${savedChat}`, { lastTurnRating: patch }).catch(() => {});
    }
  } catch (err) {
    rating = null; // a missing grade shouldn't get in the way of the answer
    if (err.status === 401) endSession("Your session ended. Sign in again.");
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

function clearThread() {
  controller?.abort();
  thread.innerHTML = "";
  history = [];
  chatEpoch++;
  chatUsage.tokens = 0;
  chatUsage.cost = 0;
  costMeter.hidden = true;
  main.classList.add("empty");
}

function newChat() {
  clearThread();
  activeChatId = null;
  if (signedIn()) renderChats();
  setDrawer(false);
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

// --- Accounts: sign-in, saved chats, usage ---------------------------------------------------

const page = document.body;
const chatList = document.getElementById("chat-list");
const sidebarNew = document.getElementById("sidebar-new");
const signin = document.getElementById("signin");
const signinMessage = document.getElementById("signin-message");
const accountMenu = document.getElementById("account-menu");
const accountBtn = document.getElementById("account-btn");
const narrow = window.matchMedia("(max-width: 760px)");
const GSI_SRC = "https://accounts.google.com/gsi/client";
const LIMIT_TITLE = `You can keep up to ${MAX_CHATS} chats. Delete one to start another.`;
const ENDED = "Your session ended. Sign in again.";

const formatUsd = (micros) => (micros > 0 && micros < 10000 ? formatCost(micros / 1e6) : `$${(micros / 1e6).toFixed(2)}`);

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function applyAccount() {
  const out = me.authEnabled && !signedIn();
  page.classList.toggle("signed-out", out);
  page.classList.toggle("signed-in", signedIn());
  signin.hidden = !out;
  input.disabled = out;
  for (const id of ["account", "sidebar", "sidebar-toggle"]) document.getElementById(id).hidden = !signedIn();
  if (!signedIn()) return closeMenu();
  const { email, name, picture, role } = me.user;
  accountBtn.innerHTML = "";
  const initial = el("span", "account-initial", (name || email).trim()[0].toUpperCase());
  if (picture) {
    const img = el("img");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = picture;
    img.onerror = () => img.replaceWith(initial);
    accountBtn.append(img);
  } else {
    accountBtn.append(initial);
  }
  accountBtn.title = email;
  document.getElementById("account-name").textContent = name || "";
  document.getElementById("account-email").textContent = email;
  document.getElementById("admin-link").hidden = role !== "admin";
  renderUsage();
}

// Admins have no budget (budgetMicros null): just their total spend, no bar.
function renderUsage() {
  if (!me.usage) return;
  const { totalCostMicros, budgetMicros } = me.usage;
  const unlimited = budgetMicros == null;
  document.getElementById("usage-text").textContent = unlimited
    ? `Usage: ${formatUsd(totalCostMicros)} total · no limit`
    : `Usage: ${formatUsd(totalCostMicros)} of ${formatUsd(budgetMicros)}`;
  document.getElementById("usage-bar").hidden = unlimited;
  if (unlimited) return;
  const share = budgetMicros > 0 ? Math.min(1, totalCostMicros / budgetMicros) : 1;
  const fill = document.getElementById("usage-fill");
  fill.style.width = `${share * 100}%`;
  fill.classList.toggle("full", share >= 1);
}

// Signed out (or the session ended): the sign-in card replaces the composer.
let gsiReady = null;
function loadGsi() {
  gsiReady ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GSI_SRC;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => {
      gsiReady = null;
      reject(new Error("Couldn't load Google sign-in"));
    };
    document.head.append(script);
  });
  return gsiReady;
}

function setSigninMessage(title, text) {
  signinMessage.innerHTML = "";
  signinMessage.hidden = !title;
  if (!title) return;
  signinMessage.append(el("strong", null, title));
  if (text) signinMessage.append(el("p", null, text));
}

let gsiInitialized = false;
async function showSignIn(message) {
  if (!me.authEnabled) return;
  applyAccount();
  setSigninMessage(message || "");
  document.getElementById("dev-login").hidden = !me.devLogin;
  if (!me.googleClientId) return;
  try {
    await loadGsi();
    if (!gsiInitialized) {
      window.google.accounts.id.initialize({ client_id: me.googleClientId, callback: onCredential });
      gsiInitialized = true;
    }
    const target = document.getElementById("gsi-button");
    target.innerHTML = "";
    window.google.accounts.id.renderButton(target, { theme: "filled_black", shape: "pill", size: "large", text: "signin_with" });
  } catch {
    setSigninMessage("Couldn't load Google sign-in.", "Check your connection, or allow accounts.google.com, then reload.");
  }
}

async function signInWith(path, payload) {
  setSigninMessage("");
  try {
    me = { ...(await api("POST", path, payload)), googleClientId: me.googleClientId, devLogin: me.devLogin };
  } catch (err) {
    if (err.code === "not_invited") return setSigninMessage("Request sent — the owner will let you in", err.message);
    return setSigninMessage(err.message);
  }
  applyAccount();
  loadChats();
  refocus();
}

const onCredential = ({ credential }) => signInWith("/api/auth/google", { credential });
document.getElementById("dev-login").onclick = () => signInWith("/api/auth/dev", {});

function endSession(message) {
  me = { authEnabled: true, googleClientId: me.googleClientId, devLogin: me.devLogin };
  chats = [];
  newChat();
  showSignIn(message);
}

document.getElementById("sign-out").onclick = async () => {
  await api("POST", "/api/logout", {}).catch(() => {});
  window.google?.accounts?.id?.disableAutoSelect?.();
  endSession();
};

// Account menu
function closeMenu() {
  accountMenu.hidden = true;
  accountBtn.setAttribute("aria-expanded", "false");
}
accountBtn.onclick = async () => {
  if (!accountMenu.hidden) return closeMenu();
  accountMenu.hidden = false;
  accountBtn.setAttribute("aria-expanded", "true");
  try {
    const fresh = await api("GET", "/api/me");
    if (fresh.user) {
      me = { ...me, ...fresh };
      renderUsage();
    }
  } catch {}
};
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("#account")) closeMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeMenu();
  setDrawer(false);
});

// Saved chats sidebar: a collapsible column on wide screens, an overlay drawer on phones.
function setDrawer(open) {
  page.classList.toggle("drawer-open", open && narrow.matches);
  document.getElementById("sidebar-scrim").hidden = !(open && narrow.matches);
}
document.getElementById("sidebar-toggle").onclick = () => {
  if (narrow.matches) setDrawer(!page.classList.contains("drawer-open"));
  else page.classList.toggle("sidebar-collapsed");
};
document.getElementById("sidebar-close").onclick = () => {
  if (narrow.matches) setDrawer(false);
  else page.classList.add("sidebar-collapsed");
};
document.getElementById("sidebar-scrim").onclick = () => setDrawer(false);
narrow.addEventListener("change", () => setDrawer(false));
sidebarNew.onclick = newChat;

function renderChats() {
  chatList.innerHTML = "";
  for (const chat of chats) {
    const title = chat.title || "New chat";
    const item = el("li", `chat-item${chat.id === activeChatId ? " active" : ""}`);
    item.dataset.id = chat.id;
    const open = el("button", "chat-open");
    open.append(el("span", "chat-title", title), el("span", "chat-time", ago(chat.updatedAt)));
    open.onclick = () => openChat(chat.id);
    const remove = el("button", "chat-delete");
    remove.innerHTML = icon('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>');
    remove.title = "Delete chat";
    remove.setAttribute("aria-label", `Delete ${title}`);
    remove.onclick = () => deleteChat(chat);
    item.append(open, remove);
    chatList.append(item);
  }
  if (!chats.length) chatList.append(el("li", "chat-empty", "No saved chats yet. Ask something to start one."));
  document.getElementById("chat-count").textContent = `${chats.length}/${MAX_CHATS}`;
  const full = chats.length >= MAX_CHATS;
  sidebarNew.disabled = full;
  document.getElementById("sidebar-new-wrap").title = full ? LIMIT_TITLE : "";
}

function upsertChat(summary) {
  chats = [summary, ...chats.filter((c) => c.id !== summary.id)];
  renderChats();
}

async function loadChats() {
  try {
    chats = (await api("GET", "/api/chats")).chats;
  } catch (err) {
    if (err.status === 401) return endSession(ENDED);
  }
  renderChats();
}

// A new chat is saved lazily, on its first question; its title comes from that question.
async function createChat(signal) {
  const { chat } = await api("POST", "/api/chats", {}, signal);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  activeChatId = chat.id;
  upsertChat(chat);
  return chat.id;
}

// Saves a finished turn; resolves to its index in the chat (or null if it couldn't be saved).
async function saveTurn(id, turn) {
  try {
    const { chat } = await api("PUT", `/api/chats/${id}`, { turn });
    upsertChat(chat);
    return chat.turnCount - 1;
  } catch {
    return null;
  }
}

async function openChat(id) {
  setDrawer(false);
  if (id === activeChatId && !controller) return;
  let chat;
  try {
    ({ chat } = await api("GET", `/api/chats/${id}`));
  } catch (err) {
    if (err.status === 401) return endSession(ENDED);
    if (err.status === 404) chats = chats.filter((c) => c.id !== id);
    return renderChats();
  }
  clearThread();
  activeChatId = chat.id;
  for (const turn of chat.turns) {
    thread.append(el("div", "msg-user", turn.question), savedAnswer(turn));
    history.push({ question: turn.question, answer: turn.answer });
    addUsage(turn.tokens ?? 0, turn.cost ?? 0);
  }
  if (chat.turns.length) main.classList.remove("empty");
  renderChats();
  window.scrollTo({ top: document.body.scrollHeight });
  refocus();
}

// A past answer from a saved chat: plain text with its rating, no per-letter details.
function savedAnswer(turn) {
  const msg = el("div", "msg-jev saved");
  msg.innerHTML = `<svg class="spark avatar" viewBox="0 0 24 24" aria-hidden="true"><use href="#spark"/></svg>`;
  const content = el("div");
  const meta = el("div", "meta");
  if (turn.label && typeof turn.score === "number") meta.append(ratingChip(turn));
  const length = turn.answer.length;
  meta.append(el("span", null, `${length} character${length === 1 ? "" : "s"}`));
  if (typeof turn.cost === "number") meta.append(el("span", null, formatCost(turn.cost)));
  appendActions(meta, () => turn.answer, turn.question);
  content.append(el("div", "answer", turn.answer), meta);
  msg.append(content);
  return msg;
}

async function deleteChat(chat) {
  if (!window.confirm(`Delete "${chat.title || "New chat"}"? This can't be undone.`)) return;
  try {
    await api("DELETE", `/api/chats/${chat.id}`);
  } catch (err) {
    if (err.status === 401) return endSession(ENDED);
    if (err.status !== 404) return;
  }
  chats = chats.filter((c) => c.id !== chat.id);
  if (chat.id === activeChatId) newChat();
  else renderChats();
}

// Accounts are optional: with them off, /api/me says so and the page stays an open demo.
async function init() {
  let data;
  try {
    const res = await fetch("/api/me");
    data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.code !== "auth_misconfigured") return;
      me = { authEnabled: true };
      applyAccount();
      return setSigninMessage("Sign-in isn't working yet.", data.error);
    }
  } catch {
    return;
  }
  me = data;
  if (!me.authEnabled) return;
  if (signedIn()) {
    applyAccount();
    loadChats();
  } else {
    showSignIn();
  }
}
init();

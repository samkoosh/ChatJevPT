// Admin page: who can sign in, their allowances, and pending access requests.
const usersBody = document.getElementById("users");
const requestsList = document.getElementById("requests");
const status = document.getElementById("status");

let me = null;
let state = { users: [], requests: [], defaultBudgetMicros: 1e6 };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, code: data.code });
  return data;
}

const usd = (micros) => (micros > 0 && micros < 10000 ? `$${(micros / 1e6).toFixed(4)}` : `$${(micros / 1e6).toFixed(2)}`);
const tokens = (n) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`);

function ago(iso) {
  if (!iso) return "Never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function say(text, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

// Every admin write returns the fresh listing.
async function change(method, path, body, done) {
  try {
    state = await api(method, path, body);
    render();
    say(done);
  } catch (err) {
    say(err.message, true);
  }
}

const save = (email, fields, done) => change("POST", "/api/admin/users", { email, ...fields }, done);
const block = (email, done) => change("DELETE", `/api/admin/users?email=${encodeURIComponent(email)}`, undefined, done);

function cell(label, ...children) {
  const td = el("td");
  td.dataset.label = label;
  td.append(...children);
  return td;
}

function renderUsers() {
  usersBody.innerHTML = "";
  for (const u of state.users) {
    const self = u.email === me.user.email;
    const tr = el("tr", `admin-user${u.status === "blocked" ? " blocked" : ""}`);
    tr.dataset.email = u.email;

    const role = el("select", "role-select");
    role.setAttribute("aria-label", `Role for ${u.email}`);
    for (const r of ["user", "admin"]) role.append(new Option(r === "admin" ? "Admin" : "User", r, false, u.role === r));
    role.disabled = self;
    role.onchange = () => save(u.email, { role: role.value }, `${u.email} is now ${role.value === "admin" ? "an admin" : "a user"}.`);

    const pill = el("span", `status-pill ${u.status}`, u.status === "allowed" ? "Allowed" : "Blocked");

    const spend = el("div", "spend");
    const line = el("span", "spend-line");
    if (u.budgetMicros == null) {
      // Admins have no budget; their usage still shows.
      line.append(el("span", "spent", usd(u.totalCostMicros)), el("span", "no-limit", "· no limit"));
      spend.append(line);
    } else {
      const budget = el("input", "budget-input");
      Object.assign(budget, { type: "number", min: "0", max: "1000", step: "0.01", value: (u.budgetMicros / 1e6).toFixed(2) });
      budget.setAttribute("aria-label", `Allowance for ${u.email}`);
      budget.onchange = () => {
        const value = budget.value.trim() === "" ? null : Number(budget.value);
        save(u.email, { budgetUsd: value }, `Budget for ${u.email} saved.`);
      };
      const bar = el("span", "usage-bar");
      const fill = el("i");
      const share = u.budgetMicros > 0 ? Math.min(1, u.totalCostMicros / u.budgetMicros) : 1;
      fill.style.width = `${share * 100}%`;
      if (share >= 1) fill.className = "full";
      bar.append(fill);
      line.append(el("span", "spent", usd(u.totalCostMicros)), el("span", null, " of $"), budget);
      spend.append(line, bar);
    }

    const action = el("button", `btn ${u.status === "allowed" ? "danger" : ""}`, u.status === "allowed" ? "Block" : "Unblock");
    action.disabled = self;
    action.onclick = () =>
      u.status === "allowed"
        ? block(u.email, `${u.email} is blocked.`)
        : save(u.email, { status: "allowed" }, `${u.email} can sign in again.`);

    tr.append(
      cell("Email", el("span", "who-email-cell", u.email)),
      cell("Name", el("span", "who-name", u.name || "—")),
      cell("Role", role),
      cell("Status", pill),
      cell("Spent", spend),
      cell("Tokens", tokens(u.totalTokens)),
      cell("Last seen", ago(u.lastSeenAt)),
      cell("", action),
    );
    usersBody.append(tr);
  }
}

function renderRequests() {
  requestsList.innerHTML = "";
  document.getElementById("requests-section").hidden = state.requests.length === 0;
  for (const r of state.requests) {
    const li = el("li", "admin-request");
    li.dataset.email = r.email;
    const who = el("div", "who");
    who.append(el("span", "who-name", r.name || r.email));
    who.append(el("span", "who-email", `${r.name ? `${r.email} · ` : ""}asked ${ago(r.requestedAt).toLowerCase()}`));
    const approve = el("button", "btn primary", "Approve");
    approve.onclick = () => save(r.email, {}, `${r.email} can sign in now.`);
    const deny = el("button", "btn", "Deny");
    deny.onclick = () => block(r.email, `${r.email} was turned down.`);
    const actions = el("div", "request-actions");
    actions.append(approve, deny);
    li.append(who, actions);
    requestsList.append(li);
  }
}

function render() {
  const def = usd(state.defaultBudgetMicros);
  document.getElementById("lede").textContent =
    `People on this list can sign in with Google. Each gets ${def} of Jev in total unless you set their own allowance. Admins have no limit.`;
  document.getElementById("add-budget").placeholder = (state.defaultBudgetMicros / 1e6).toFixed(2);
  renderRequests();
  renderUsers();
}

document.getElementById("add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.getElementById("add-email");
  const budget = document.getElementById("add-budget");
  const fields = budget.value.trim() === "" ? {} : { budgetUsd: Number(budget.value) };
  const address = email.value.trim().toLowerCase();
  await save(address, fields, `${address} added.`);
  if (!status.classList.contains("error")) {
    email.value = "";
    budget.value = "";
  }
});

function gate(title, text) {
  const box = document.getElementById("gate");
  box.hidden = false;
  box.innerHTML = "";
  const body = el("div");
  const back = el("a", null, "Back to ChatJevPT");
  back.href = "/";
  body.append(el("strong", null, title), el("p", null, text), back);
  box.append(body);
}

async function init() {
  try {
    me = await api("GET", "/api/me");
  } catch (err) {
    return gate("Admin isn't available.", err.message);
  }
  if (!me.authEnabled) return gate("Accounts are off.", "Set GOOGLE_CLIENT_ID, SESSION_SECRET and DATABASE_URL to turn them on (see the README).");
  if (!me.user) return gate("Sign in first.", "Sign in on the chat page, then come back here.");
  if (me.user.role !== "admin") return gate("Admins only.", "Your account isn't an admin.");
  try {
    state = await api("GET", "/api/admin/users");
  } catch (err) {
    return gate("Couldn't load people.", err.message);
  }
  document.getElementById("panel").hidden = false;
  render();
}
init();

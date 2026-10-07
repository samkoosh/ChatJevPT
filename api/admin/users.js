import { authDisabledResponse, authenticate, badRequest, budgetOf, defaultBudgetMicros, isAdmin, json, monthStart, readJson } from "../../lib/auth.js";
import { getStore } from "../../lib/store.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BUDGET_USD = 1000;

async function listing() {
  const store = getStore();
  const [users, requests] = await Promise.all([store.listUsers(monthStart()), store.listRequests()]);
  const usd = (micros) => (micros == null ? null : micros / 1e6);
  return {
    // budgetMicros is null for admins: no limit.
    users: users.map((u) => {
      const budgetMicros = budgetOf(u);
      return { ...u, role: isAdmin(u) ? "admin" : u.role, budgetMicros, monthUsd: usd(u.monthCostMicros), budgetUsd: usd(budgetMicros) };
    }),
    requests,
    defaultBudgetMicros: defaultBudgetMicros(),
  };
}

async function gate(request) {
  const auth = await authenticate(request, { admin: true });
  if (auth.off) return { response: authDisabledResponse() };
  return auth;
}

// GET -> { users: [{ email, name, role, status, monthCostMicros, monthUsd, monthTokens, budgetMicros, budgetUsd, lastSeenAt, … }],
//          requests: [{ email, name, requestedAt }], defaultBudgetMicros }
export async function GET(request) {
  const { response } = await gate(request);
  return response ?? json(await listing());
}

// POST { email, budgetUsd?, status?, role? } adds or updates a person (and clears their access
// request). budgetUsd: null goes back to the default budget. -> same shape as GET.
export async function POST(request) {
  const { response, user } = await gate(request);
  if (response) return response;
  const body = await readJson(request);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 254) return badRequest("Enter a valid email address.");

  const changes = {};
  if (body.budgetUsd !== undefined) {
    const usd = body.budgetUsd;
    if (usd !== null && !(typeof usd === "number" && Number.isFinite(usd) && usd >= 0 && usd <= MAX_BUDGET_USD)) {
      return badRequest(`Budget must be between $0 and $${MAX_BUDGET_USD}.`);
    }
    changes.budgetMicros = usd === null ? null : Math.round(usd * 1e6);
  }
  if (body.status !== undefined) {
    if (!["allowed", "blocked"].includes(body.status)) return badRequest("Status must be allowed or blocked.");
    changes.status = body.status;
  }
  if (body.role !== undefined) {
    if (!["user", "admin"].includes(body.role)) return badRequest("Role must be user or admin.");
    changes.role = body.role;
  }
  if (email === user.email && (changes.status === "blocked" || changes.role === "user")) {
    return badRequest("You can't block yourself or remove your own admin role.");
  }
  await getStore().saveUser(email, changes);
  return json(await listing());
}

// DELETE ?email= blocks that person (usage is kept). Also turns down a pending request.
export async function DELETE(request) {
  const { response, user } = await gate(request);
  if (response) return response;
  const email = (new URL(request.url).searchParams.get("email") ?? "").trim().toLowerCase();
  if (!EMAIL.test(email)) return badRequest("Enter a valid email address.");
  if (email === user.email) return badRequest("You can't block yourself.");
  await getStore().saveUser(email, { status: "blocked" });
  return json(await listing());
}

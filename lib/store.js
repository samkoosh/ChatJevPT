// Accounts data: users, daily usage, saved chats and access requests.
// Postgres (Neon) in production; an in-memory store for tests and `STORE=memory` local dev.
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";

let current;

export function getStore() {
  current ??= process.env.STORE === "memory" ? memoryStore() : postgresStore(neon(process.env.DATABASE_URL));
  return current;
}

// Tests inject their own store (or reset to a fresh one with `setStore(null)`).
export function setStore(store) {
  current = store;
}

const SCHEMA = (sql) => [
  sql`CREATE TABLE IF NOT EXISTS users (
    email text PRIMARY KEY,
    google_sub text,
    name text,
    picture text,
    role text NOT NULL DEFAULT 'user',
    status text NOT NULL DEFAULT 'allowed',
    monthly_budget_micros bigint,
    created_at timestamptz DEFAULT now(),
    last_seen_at timestamptz
  )`,
  sql`CREATE TABLE IF NOT EXISTS usage (
    email text,
    period date,
    tokens bigint DEFAULT 0,
    cost_micros bigint DEFAULT 0,
    calls int DEFAULT 0,
    PRIMARY KEY (email, period)
  )`,
  sql`CREATE TABLE IF NOT EXISTS chats (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    title text NOT NULL,
    turns jsonb NOT NULL DEFAULT '[]',
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  )`,
  sql`CREATE INDEX IF NOT EXISTS chats_email_updated ON chats (email, updated_at)`,
  sql`CREATE TABLE IF NOT EXISTS access_requests (
    email text PRIMARY KEY,
    name text,
    requested_at timestamptz DEFAULT now()
  )`,
];

const iso = (t) => (t == null ? null : new Date(t).toISOString());
const num = (n) => (n == null ? null : Number(n));

function userRow(r) {
  if (!r) return null;
  return {
    email: r.email,
    name: r.name ?? null,
    picture: r.picture ?? null,
    role: r.role,
    status: r.status,
    customBudgetMicros: num(r.monthly_budget_micros),
    totalCostMicros: num(r.month_cost) ?? 0,
    totalTokens: num(r.month_tokens) ?? 0,
    createdAt: iso(r.created_at),
    lastSeenAt: iso(r.last_seen_at),
  };
}

const chatSummary = (r) => ({ id: r.id, title: r.title, turnCount: Number(r.turn_count), updatedAt: iso(r.updated_at) });
const chatRow = (r) => (r ? { id: r.id, title: r.title, turns: r.turns, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) } : null);

// `sql` is a Neon tagged-template query function (anything with the same shape works).
export function postgresStore(sql) {
  let ready;
  const init = () => (ready ??= sql.transaction(SCHEMA(sql)).catch((err) => ((ready = null), Promise.reject(err))));
  const query = async (strings, ...values) => (await init(), sql(strings, ...values));
  const transaction = async (build) => (await init(), sql.transaction(build(sql)));

  return {
    async getUser(email, since) {
      const rows = await query`
        SELECT u.*, m.month_cost, m.month_tokens FROM users u
        LEFT JOIN LATERAL (
          SELECT sum(cost_micros) AS month_cost, sum(tokens) AS month_tokens
          FROM usage WHERE usage.email = u.email AND period >= ${since}::date
        ) m ON true
        WHERE u.email = ${email}`;
      return userRow(rows[0]);
    },

    async listUsers(since) {
      const rows = await query`
        SELECT u.*, m.month_cost, m.month_tokens FROM users u
        LEFT JOIN LATERAL (
          SELECT sum(cost_micros) AS month_cost, sum(tokens) AS month_tokens
          FROM usage WHERE usage.email = u.email AND period >= ${since}::date
        ) m ON true
        ORDER BY u.last_seen_at DESC NULLS LAST, u.email`;
      return rows.map(userRow);
    },

    // Sign-in: refresh the Google profile. `admin` also makes them an allowed admin (ADMIN_EMAILS).
    async signIn({ email, googleSub, name, picture }, { admin = false } = {}) {
      if (admin) {
        await query`
          INSERT INTO users (email, google_sub, name, picture, role, status, last_seen_at)
          VALUES (${email}, ${googleSub}, ${name}, ${picture}, 'admin', 'allowed', now())
          ON CONFLICT (email) DO UPDATE SET google_sub = excluded.google_sub, name = excluded.name,
            picture = excluded.picture, role = 'admin', status = 'allowed', last_seen_at = now()`;
      } else {
        await query`
          UPDATE users SET google_sub = ${googleSub}, name = ${name}, picture = ${picture}, last_seen_at = now()
          WHERE email = ${email}`;
      }
    },

    async saveUser(email, { role, status, budgetMicros }) {
      const setBudget = budgetMicros !== undefined;
      await transaction((sql) => [
        sql`
          INSERT INTO users (email, role, status, monthly_budget_micros)
          VALUES (${email}, coalesce(${role ?? null}::text, 'user'), coalesce(${status ?? null}::text, 'allowed'), ${budgetMicros ?? null}::bigint)
          ON CONFLICT (email) DO UPDATE SET
            role = coalesce(${role ?? null}::text, users.role),
            status = coalesce(${status ?? null}::text, users.status),
            monthly_budget_micros = CASE WHEN ${setBudget}::boolean THEN ${budgetMicros ?? null}::bigint ELSE users.monthly_budget_micros END`,
        sql`DELETE FROM access_requests WHERE email = ${email}`,
      ]);
    },

    async requestAccess(email, name) {
      await query`
        INSERT INTO access_requests (email, name) VALUES (${email}, ${name})
        ON CONFLICT (email) DO UPDATE SET name = excluded.name, requested_at = now()`;
    },

    async listRequests() {
      const rows = await query`SELECT email, name, requested_at FROM access_requests ORDER BY requested_at DESC`;
      return rows.map((r) => ({ email: r.email, name: r.name, requestedAt: iso(r.requested_at) }));
    },

    // One row per person per UTC day; the upsert adds atomically, so concurrent calls can't lose usage.
    async charge(email, day, tokens, costMicros) {
      await query`
        WITH seen AS (UPDATE users SET last_seen_at = now() WHERE email = ${email})
        INSERT INTO usage (email, period, tokens, cost_micros, calls) VALUES (${email}, ${day}::date, ${tokens}, ${costMicros}, 1)
        ON CONFLICT (email, period) DO UPDATE SET
          tokens = usage.tokens + excluded.tokens,
          cost_micros = usage.cost_micros + excluded.cost_micros,
          calls = usage.calls + 1`;
    },

    async listChats(email) {
      const rows = await query`
        SELECT id, title, jsonb_array_length(turns) AS turn_count, updated_at FROM chats
        WHERE email = ${email} ORDER BY updated_at DESC`;
      return rows.map(chatSummary);
    },

    // Returns null when the person already has `max` chats. The lock makes the count-then-insert atomic.
    async createChat(email, title, max) {
      const [, rows] = await transaction((sql) => [
        sql`SELECT pg_advisory_xact_lock(hashtext(${email}))`,
        sql`
          INSERT INTO chats (email, title) SELECT ${email}, ${title}
          WHERE (SELECT count(*) FROM chats WHERE email = ${email}) < ${max}
          RETURNING id, title, 0 AS turn_count, updated_at`,
      ]);
      return rows[0] ? chatSummary(rows[0]) : null;
    },

    async getChat(email, id) {
      const rows = await query`SELECT * FROM chats WHERE id = ${id}::uuid AND email = ${email}`;
      return chatRow(rows[0]);
    },

    // Appends a turn unless the chat is full; an empty title becomes `title`.
    async appendTurn(email, id, turn, title, max) {
      const rows = await query`
        UPDATE chats SET turns = turns || ${JSON.stringify([turn])}::jsonb,
          title = CASE WHEN title = '' THEN ${title} ELSE title END, updated_at = now()
        WHERE id = ${id}::uuid AND email = ${email} AND jsonb_array_length(turns) < ${max}
        RETURNING id, title, jsonb_array_length(turns) AS turn_count, updated_at`;
      return rows[0] ? chatSummary(rows[0]) : null;
    },

    async patchTurn(email, id, index, patch) {
      const rows = await query`
        UPDATE chats SET turns = jsonb_set(turns, ARRAY[${String(index)}]::text[], (turns -> ${index}::int) || ${JSON.stringify(patch)}::jsonb)
        WHERE id = ${id}::uuid AND email = ${email} AND jsonb_array_length(turns) > ${index}::int
        RETURNING id, title, jsonb_array_length(turns) AS turn_count, updated_at`;
      return rows[0] ? chatSummary(rows[0]) : null;
    },

    async renameChat(email, id, title) {
      const rows = await query`
        UPDATE chats SET title = ${title}, updated_at = now() WHERE id = ${id}::uuid AND email = ${email}
        RETURNING id, title, jsonb_array_length(turns) AS turn_count, updated_at`;
      return rows[0] ? chatSummary(rows[0]) : null;
    },

    async deleteChat(email, id) {
      const rows = await query`DELETE FROM chats WHERE id = ${id}::uuid AND email = ${email} RETURNING id`;
      return rows.length > 0;
    },
  };
}

// Same interface, kept in process memory. Every method finishes its writes before its first
// await, so concurrent calls behave like the atomic Postgres statements.
export function memoryStore() {
  const users = new Map();
  const usage = new Map(); // `${email} ${day}` -> { email, day, tokens, costMicros, calls }
  const chats = new Map();
  const requests = new Map();
  const now = () => new Date().toISOString();
  // Ensures strictly increasing timestamps so "newest first" is stable within one millisecond.
  let last = 0;
  const tick = () => new Date((last = Math.max(Date.now(), last + 1))).toISOString();

  const withUsage = (u, since) => {
    let totalCostMicros = 0;
    let totalTokens = 0;
    for (const row of usage.values()) {
      if (row.email === u.email && row.day >= since) {
        totalCostMicros += row.costMicros;
        totalTokens += row.tokens;
      }
    }
    return { ...u, totalCostMicros, totalTokens };
  };
  const summary = (c) => ({ id: c.id, title: c.title, turnCount: c.turns.length, updatedAt: c.updatedAt });
  const own = (email, id) => {
    const chat = chats.get(id);
    return chat && chat.email === email ? chat : null;
  };
  const blank = (email) => ({
    email,
    name: null,
    picture: null,
    role: "user",
    status: "allowed",
    customBudgetMicros: null,
    createdAt: now(),
    lastSeenAt: null,
  });

  return {
    async getUser(email, since) {
      const u = users.get(email);
      return u ? withUsage(u, since) : null;
    },
    async listUsers(since) {
      return [...users.values()]
        .sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "") || a.email.localeCompare(b.email))
        .map((u) => withUsage(u, since));
    },
    async signIn({ email, name, picture }, { admin = false } = {}) {
      const u = users.get(email) ?? (admin ? blank(email) : null);
      if (!u) return;
      Object.assign(u, { name, picture, lastSeenAt: now() }, admin ? { role: "admin", status: "allowed" } : {});
      users.set(email, u);
    },
    async saveUser(email, { role, status, budgetMicros }) {
      const u = users.get(email) ?? blank(email);
      if (role) u.role = role;
      if (status) u.status = status;
      if (budgetMicros !== undefined) u.customBudgetMicros = budgetMicros;
      users.set(email, u);
      requests.delete(email);
    },
    async requestAccess(email, name) {
      requests.set(email, { email, name, requestedAt: now() });
    },
    async listRequests() {
      return [...requests.values()].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    },
    async charge(email, day, tokens, costMicros) {
      const key = `${email} ${day}`;
      const row = usage.get(key) ?? { email, day, tokens: 0, costMicros: 0, calls: 0 };
      row.tokens += tokens;
      row.costMicros += costMicros;
      row.calls += 1;
      usage.set(key, row);
      const u = users.get(email);
      if (u) u.lastSeenAt = now();
    },
    async listChats(email) {
      return [...chats.values()]
        .filter((c) => c.email === email)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(summary);
    },
    async createChat(email, title, max) {
      if ([...chats.values()].filter((c) => c.email === email).length >= max) return null;
      const t = tick();
      const chat = { id: randomUUID(), email, title, turns: [], createdAt: t, updatedAt: t };
      chats.set(chat.id, chat);
      return summary(chat);
    },
    async getChat(email, id) {
      const c = own(email, id);
      return c ? { id: c.id, title: c.title, turns: structuredClone(c.turns), createdAt: c.createdAt, updatedAt: c.updatedAt } : null;
    },
    async appendTurn(email, id, turn, title, max) {
      const c = own(email, id);
      if (!c || c.turns.length >= max) return null;
      c.turns.push(structuredClone(turn));
      if (!c.title) c.title = title;
      c.updatedAt = tick();
      return summary(c);
    },
    async patchTurn(email, id, index, patch) {
      const c = own(email, id);
      if (!c || index >= c.turns.length) return null;
      Object.assign(c.turns[index], patch);
      return summary(c);
    },
    async renameChat(email, id, title) {
      const c = own(email, id);
      if (!c) return null;
      c.title = title;
      c.updatedAt = tick();
      return summary(c);
    },
    async deleteChat(email, id) {
      return Boolean(own(email, id)) && chats.delete(id);
    },
  };
}

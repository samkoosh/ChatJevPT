// TEMPORARY (preview only): exercises the Postgres store against the real Neon database with
// throwaway users, then deletes them. Removed before merging.
import { neon } from "@neondatabase/serverless";
import { postgresStore, setStore } from "../lib/store.js";
import { loadChat } from "../lib/chats.js";

export async function GET() {
  if (process.env.VERCEL_ENV !== "preview") return new Response("Not found", { status: 404 });
  const sql = neon(process.env.DATABASE_URL);
  const store = postgresStore(sql);
  setStore(store);
  const tag = Math.random().toString(36).slice(2, 8);
  const a = `dbcheck-a-${tag}@example.invalid`;
  const b = `dbcheck-b-${tag}@example.invalid`;
  const since = `${new Date().toISOString().slice(0, 7)}-01`;
  const day = new Date().toISOString().slice(0, 10);
  const results = [];
  const check = (name, ok, detail) => results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
  try {
    check("unknown user is null", (await store.getUser(a, since)) === null);
    await store.requestAccess(a, "Test A");
    check("access request recorded", (await store.listRequests()).some((r) => r.email === a));
    await store.saveUser(a, { role: "user", status: "allowed", budgetMicros: 500000 });
    check("approve removes request", !(await store.listRequests()).some((r) => r.email === a));
    await store.signIn({ email: a, googleSub: "sub-a", name: "Test A", picture: null });
    await store.signIn({ email: b, googleSub: "sub-b", name: "Test B", picture: null }, { admin: true });
    const ua = await store.getUser(a, since);
    check("user saved with budget", ua?.monthlyBudgetMicros === 500000 && ua.status === "allowed", ua);
    check("admin bootstrap", (await store.getUser(b, since))?.role === "admin");

    await Promise.all(Array.from({ length: 25 }, () => store.charge(a, day, 100, 7)));
    const charged = await store.getUser(a, since);
    check("25 concurrent charges sum exactly", charged.monthTokens === 2500 && charged.monthCostMicros === 175, charged);
    check("listUsers includes both", (await store.listUsers(since)).filter((u) => [a, b].includes(u.email)).length === 2);

    const created = await Promise.all(Array.from({ length: 7 }, () => store.createChat(a, "", 5)));
    check("concurrent creates stop at 5 chats", created.filter(Boolean).length === 5, created.filter(Boolean).length);
    const id = created.find(Boolean).id;
    const turn = { question: "What is the capital of France?", answer: "Paris" };
    const appended = await store.appendTurn(a, id, turn, "What is the capital of France?", 50);
    check("append sets title", appended?.title === "What is the capital of France?" && appended.turnCount === 1, appended);
    await store.patchTurn(a, id, 0, { label: "Perfect", score: 3.9 });
    const chat = await store.getChat(a, id);
    check("rating patched onto turn", chat?.turns?.[0]?.label === "Perfect" && chat.turns[0].answer === "Paris", chat?.turns);
    check("another user can't read it", (await store.getChat(b, id)) === null);
    check("another user can't append", (await store.appendTurn(b, id, turn, "x", 50)) === null);
    check("another user can't delete", (await store.deleteChat(b, id)) === false);
    let badId;
    try {
      badId = await loadChat(await store.getUser(a, since), "not-a-uuid");
    } catch (err) {
      badId = `threw: ${err.message}`;
    }
    check("malformed chat id is just not found", badId === null, badId);
    check("list newest first", (await store.listChats(a))[0]?.id === id);
    check("rename", (await store.renameChat(a, id, "Renamed"))?.title === "Renamed");
    check("delete", (await store.deleteChat(a, id)) === true && (await store.getChat(a, id)) === null);
  } catch (err) {
    check("unexpected error", false, String(err?.stack ?? err));
  } finally {
    await sql`DELETE FROM chats WHERE email IN (${a}, ${b})`;
    await sql`DELETE FROM usage WHERE email IN (${a}, ${b})`;
    await sql`DELETE FROM access_requests WHERE email IN (${a}, ${b})`;
    await sql`DELETE FROM users WHERE email IN (${a}, ${b})`;
  }
  const config = { authVars: ["GOOGLE_CLIENT_ID", "SESSION_SECRET", "DATABASE_URL", "ADMIN_EMAILS"].map((k) => `${k}:${process.env[k] ? "set" : "MISSING"}`) };
  return Response.json({ config, results });
}

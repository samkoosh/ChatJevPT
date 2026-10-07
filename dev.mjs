// Local dev server: serves public/ and routes /api/** to the Vercel functions in api/, the way
// Vercel does. `npm run dev` uses .env; `npm run dev:mock` needs no key; `npm run dev:accounts`
// adds sign-in with an in-memory store (see README → Accounts).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import * as next from "./api/next.js";
import * as rate from "./api/rate.js";
import * as me from "./api/me.js";
import * as google from "./api/auth/google.js";
import * as devLogin from "./api/auth/dev.js";
import * as logout from "./api/logout.js";
import * as chats from "./api/chats/index.js";
import * as chat from "./api/chats/[id].js";
import * as adminUsers from "./api/admin/users.js";

const API = {
  "/api/next": next,
  "/api/rate": rate,
  "/api/me": me,
  "/api/auth/google": google,
  "/api/auth/dev": devLogin,
  "/api/logout": logout,
  "/api/chats": chats,
  "/api/admin/users": adminUsers,
};
const route = (path) => API[path] ?? (/^\/api\/chats\/[^/]+$/.test(path) ? chat : null);

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
const port = Number(process.env.PORT) || 3000;

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? `localhost:${port}`}`);
  if (url.pathname.startsWith("/api/")) {
    const handler = route(url.pathname)?.[req.method];
    if (!handler) return res.writeHead(404, { "content-type": "application/json" }).end('{"error":"Not found."}');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks);
    let response;
    try {
      response = await handler(new Request(url, { method: req.method, headers, body }));
    } catch (err) {
      console.error(err);
      response = Response.json({ error: "Server error." }, { status: 500 });
    }
    for (const [key, value] of response.headers) if (key !== "set-cookie") res.setHeader(key, value);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader("set-cookie", cookies);
    res.writeHead(response.status);
    return res.end(Buffer.from(await response.arrayBuffer()));
  }
  const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
  try {
    const file = await readFile(join("public", path));
    const type = TYPES[extname(path)] ?? "application/octet-stream";
    // Google's sign-in button needs the page's origin in the Referer, even on http://localhost.
    const extra = type === "text/html" ? { "referrer-policy": "no-referrer-when-downgrade" } : {};
    res.writeHead(200, { "content-type": type, ...extra });
    res.end(file);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, () => console.log(`ChatJevPT on http://localhost:${port}`));

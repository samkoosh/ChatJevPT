// Local dev server: serves public/ and routes /api/** to the matching file in api/, any method, the
// way Vercel does (api/chats/[id].js answers /api/chats/<id>). `npm run dev` uses .env;
// `npm run dev:mock` needs no key; `npm run dev:accounts` adds sign-in with an in-memory store.
import { createServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
const port = Number(process.env.PORT) || 3000;
const SEGMENT = /^[A-Za-z0-9_.@%+-]+$/;

// The api/ file for a path: an exact file, a folder's index.js, or a [param].js in that folder.
async function apiFile(pathname) {
  const parts = pathname.split("/").slice(2);
  if (!parts.length || parts.some((p) => !SEGMENT.test(p) || p.startsWith("."))) return null;
  const dir = join("api", ...parts.slice(0, -1));
  const exact = [join("api", ...parts) + ".js", join("api", ...parts, "index.js")].find((f) => existsSync(f));
  if (exact) return exact;
  const dynamic = (await readdir(dir).catch(() => [])).find((f) => /^\[[^\]]+\]\.js$/.test(f));
  return dynamic ? join(dir, dynamic) : null;
}

async function handleApi(req, res, url) {
  const file = await apiFile(url.pathname);
  const handler = file && (await import(pathToFileURL(file).href))[req.method];
  if (!handler) {
    res.writeHead(file ? 405 : 404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: file ? "Method not allowed." : "Not found." }));
  }
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
  res.end(Buffer.from(await response.arrayBuffer()));
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? `localhost:${port}`}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
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

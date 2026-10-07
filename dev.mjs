// Local dev server: serves public/ and routes POST /api/next to the Vercel function.
// `npm run dev` uses TYPESAFE_API_KEY from .env; `npm run dev:mock` needs no key.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { POST } from "./api/next.js";

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
const port = Number(process.env.PORT) || 3000;

createServer(async (req, res) => {
  if (req.url === "/api/next" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await POST(new Request(`http://localhost${req.url}`, { method: "POST", body: Buffer.concat(chunks) }));
    res.writeHead(response.status, { "content-type": "application/json" });
    return res.end(await response.text());
  }
  const path = normalize(req.url.split("?")[0] === "/" ? "/index.html" : req.url.split("?")[0]);
  try {
    const file = await readFile(join("public", path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(file);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, () => console.log(`ChatGPJev on http://localhost:${port}`));

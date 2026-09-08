import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = fileURLToPath(new URL("../runtime-ts/apps/web/dist", import.meta.url));
const root = resolve(process.env.STATIC_ROOT ?? defaultRoot);
const host = process.env.STATIC_LISTEN_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.STATIC_LISTEN_PORT ?? "4173", 10);
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function resolveRequestPath(rawUrl) {
  const pathname = decodeURIComponent(new URL(rawUrl ?? "/", "http://127.0.0.1").pathname);
  const relative = normalize(pathname).replace(/^[/\\]+/u, "");
  const candidate = resolve(root, relative);
  if (
    candidate !== root &&
    !candidate.startsWith(`${root}/`) &&
    !candidate.startsWith(`${root}\\`)
  ) {
    return undefined;
  }
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return join(root, "index.html");
}

const server = createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  let path;
  try {
    path = resolveRequestPath(request.url);
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (path === undefined || !existsSync(path)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "Cache-Control": extname(path) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    "Content-Type": mimeTypes.get(extname(path).toLowerCase()) ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(path).pipe(response);
});

server.listen(port, host, () => {
  console.info(`Hoox Demo Web 已监听 ${host}:${server.address().port}`);
});

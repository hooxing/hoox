import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyRobotsOrigin,
  applySiteOrigin,
  parseSiteOrigin,
  renderSitemap,
} from "../runtime-ts/apps/web/landing-metadata.mjs";

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
  [".txt", "text/plain; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const index = join(root, "index.html");
const robots = join(root, "robots.txt");
const sitemap = join(root, "sitemap.xml");
const workspace = join(root, "workspace.html");
const hasWorkspace = existsSync(workspace);
const crawlerFiles = new Set(["/robots.txt", "/sitemap.xml"]);

function resolveRequestPath(url) {
  const pathname = decodeURIComponent(url.pathname);
  const relative = normalize(pathname).replace(/^[/\\]+/u, "");
  const candidate = resolve(root, relative);
  if (
    candidate !== root &&
    !candidate.startsWith(`${root}/`) &&
    !candidate.startsWith(`${root}\\`)
  ) {
    return undefined;
  }
  const isLandingPath = url.pathname === "/" || url.pathname === "/index.html";
  if (
    hasWorkspace &&
    ((isLandingPath && url.searchParams.has("error")) || (!isLandingPath && candidate === index))
  )
    return workspace;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  if (crawlerFiles.has(pathname)) return undefined;
  return hasWorkspace && !isLandingPath ? workspace : index;
}

const server = createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  let path;
  try {
    path = resolveRequestPath(new URL(request.url ?? "/", "http://127.0.0.1"));
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (path === undefined || !existsSync(path)) {
    response.writeHead(404).end();
    return;
  }
  const extension = extname(path).toLowerCase();
  const isCrawlerFile = path === robots || path === sitemap;
  response.writeHead(200, {
    "Cache-Control":
      extension === ".html" || isCrawlerFile ? "no-cache" : "public, max-age=31536000, immutable",
    "Content-Type": mimeTypes.get(extension) ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  // Demo 的 Web 只监听回环；Nginx 用配置域名覆盖此头，不信任访问者提供的源。
  const fromLoopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
    request.socket.remoteAddress,
  );
  const origin =
    hasWorkspace && fromLoopback && parseSiteOrigin(request.headers["x-hoox-public-origin"]);
  if (origin) {
    if (path === index) {
      response.end(applySiteOrigin(readFileSync(path, "utf8"), origin));
      return;
    }
    if (path === robots) {
      response.end(applyRobotsOrigin(readFileSync(path, "utf8"), origin));
      return;
    }
    if (path === sitemap) {
      const content = readFileSync(path, "utf8");
      response.end(content.includes("<loc>") ? content : renderSitemap(origin));
      return;
    }
  }
  createReadStream(path).pipe(response);
});

server.listen(port, host, () => {
  console.info(`Hoox Demo Web 已监听 ${host}:${server.address().port}`);
});

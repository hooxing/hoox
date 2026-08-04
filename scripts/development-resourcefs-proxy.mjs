import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { fileURLToPath } from "node:url";

export const RESOURCE_FILESYSTEM_PATH_PREFIX = "/v1/resource-filesystem";
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function createDevelopmentResourceFsProxyHandler(options) {
  const upstream = new URL(options.upstream);
  if (upstream.protocol !== "http:" || !isLoopbackHostname(upstream.hostname)) {
    throw new TypeError("ResourceFS 开发代理的 upstream 必须是 loopback HTTP 地址");
  }
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  if (!Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs <= 0) {
    throw new TypeError("ResourceFS 开发代理的 upstreamTimeoutMs 必须是正整数");
  }

  return (request, response) => {
    const incoming = new URL(request.url ?? "/", "https://resourcefs-proxy.invalid");
    if (!isResourceFilesystemPath(incoming.pathname)) {
      respondJson(response, 404, { code: "NOT_FOUND" });
      return;
    }

    const headers = forwardHeaders(request.headers, upstream.host);
    const upstreamRequest = httpRequest(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: request.method,
        path: `${incoming.pathname}${incoming.search}`,
        headers,
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          forwardHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
      },
    );
    upstreamRequest.setTimeout(upstreamTimeoutMs, () => {
      upstreamRequest.destroy(new Error("RESOURCEFS_UPSTREAM_TIMEOUT"));
    });
    upstreamRequest.once("error", () => {
      if (!response.headersSent) respondJson(response, 502, { code: "UPSTREAM_UNAVAILABLE" });
      else response.destroy();
    });
    request.once("aborted", () => upstreamRequest.destroy());
    request.pipe(upstreamRequest);
  };
}

export function isResourceFilesystemPath(pathname) {
  return (
    pathname === RESOURCE_FILESYSTEM_PATH_PREFIX ||
    pathname.startsWith(`${RESOURCE_FILESYSTEM_PATH_PREFIX}/`)
  );
}

function forwardHeaders(source, host) {
  const headers = { ...source };
  const connectionTokens = String(headers.connection ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  for (const name of [...HOP_BY_HOP_HEADERS, ...connectionTokens]) delete headers[name];
  delete headers.forwarded;
  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-proto"];
  if (host === undefined) delete headers.host;
  else headers.host = host;
  return headers;
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function respondJson(response, statusCode, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
  });
  response.end(encoded);
}

async function main() {
  const listenHost = requiredEnvironment("RESOURCEFS_PROXY_LISTEN_HOST");
  const listenPort = positiveIntegerEnvironment("RESOURCEFS_PROXY_LISTEN_PORT");
  const upstream = requiredEnvironment("RESOURCEFS_PROXY_UPSTREAM");
  const keyPath = requiredEnvironment("RESOURCEFS_PROXY_TLS_KEY_PATH");
  const certificatePath = requiredEnvironment("RESOURCEFS_PROXY_TLS_CERT_PATH");
  const server = createHttpsServer(
    {
      key: await readFile(keyPath),
      cert: await readFile(certificatePath),
      minVersion: "TLSv1.2",
    },
    createDevelopmentResourceFsProxyHandler({ upstream }),
  );
  server.on("clientError", (_error, socket) => socket.destroy());
  server.listen(listenPort, listenHost, () => {
    process.stdout.write(`ResourceFS development proxy listening on ${listenHost}:${listenPort}\n`);
  });
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new TypeError(`缺少 ${name}`);
  return value;
}

function positiveIntegerEnvironment(name) {
  const parsed = Number(requiredEnvironment(name));
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new TypeError(`${name} 必须是有效端口`);
  }
  return parsed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

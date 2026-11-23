import { createServer } from "node:http";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export function createHooxProxy({
  apiOrigin,
  apiKey,
  appOrigin,
  sessionToken,
  endUserId,
  fetcher = fetch,
}) {
  const upstreamOrigin = new URL(apiOrigin);
  if (
    !/^https?:$/u.test(upstreamOrigin.protocol) ||
    !apiKey ||
    !appOrigin ||
    !sessionToken ||
    !endUserId
  ) {
    throw new Error("缺少有效的代理配置");
  }
  const sessionCookie = `hoox_demo_session=${encodeURIComponent(sessionToken)}`;
  const json = (response, status, message) => {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ error: message }));
  };
  return async (request, response) => {
    try {
      const origin = request.headers.origin;
      const configuredOrigin = new URL(appOrigin);
      const safeReadWithoutOrigin =
        request.method === "GET" &&
        origin === undefined &&
        request.headers["sec-fetch-site"] === "same-origin" &&
        request.headers.host === configuredOrigin.host;
      if (origin !== appOrigin && !safeReadWithoutOrigin)
        return json(response, 403, "同源请求校验失败");
      if (request.method === "POST" && request.url === "/demo-session") {
        response.writeHead(204, {
          "set-cookie": `${sessionCookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
          "cache-control": "no-store",
        });
        return response.end();
      }
      if (!request.url?.startsWith("/hoox/v1/")) return json(response, 404, "未找到");
      let cookies;
      try {
        cookies = new Map(
          (request.headers.cookie ?? "").split(";").map((item) => {
            const separator = item.indexOf("=");
            return separator < 0
              ? [item.trim(), ""]
              : [
                  item.slice(0, separator).trim(),
                  decodeURIComponent(item.slice(separator + 1).trim()),
                ];
          }),
        );
      } catch {
        return json(response, 400, "Cookie 格式无效");
      }
      if (cookies.get("hoox_demo_session") !== sessionToken)
        return json(response, 401, "请先建立示例会话");
      if (!["GET", "POST", "DELETE"].includes(request.method ?? ""))
        return json(response, 405, "方法不支持");
      const target = new URL(request.url.slice("/hoox".length), upstreamOrigin);
      const headers = new Headers({
        accept: request.headers.accept ?? "application/json",
        authorization: `Bearer ${apiKey}`,
        "hoox-end-user": endUserId,
      });
      for (const name of [
        "content-type",
        "idempotency-key",
        "last-event-id",
        "x-file-name",
        "x-file-media-type",
      ]) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const controller = new AbortController();
      request.on("aborted", () => controller.abort());
      response.on("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      try {
        const upstream = await fetcher(target, {
          method: request.method,
          headers,
          ...(request.method === "GET" ? {} : { body: Readable.toWeb(request), duplex: "half" }),
          signal: controller.signal,
          redirect: "manual",
        });
        if (upstream.status >= 300 && upstream.status < 400)
          return json(response, 502, "上游重定向被拒绝");
        const forwarded = new Headers();
        for (const name of ["content-type", "cache-control", "retry-after", "x-request-id"]) {
          const value = upstream.headers.get(name);
          if (value) forwarded.set(name, value);
        }
        response.writeHead(upstream.status, Object.fromEntries(forwarded));
        if (upstream.body) {
          try {
            await pipeline(Readable.fromWeb(upstream.body), response, {
              signal: controller.signal,
            });
          } catch {
            if (!response.destroyed && !response.writableEnded) response.destroy();
          }
        } else response.end();
      } catch {
        if (!response.headersSent) json(response, 502, "上游暂时不可用");
        else response.destroy();
      }
    } catch {
      if (!response.headersSent) json(response, 400, "请求格式无效");
      else if (!response.destroyed) response.destroy();
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const webRequire = createRequire(
    new URL("../../runtime-ts/apps/web/package.json", import.meta.url),
  );
  const { createServer: createViteServer } = await import(webRequire.resolve("vite"));
  const config = {
    apiOrigin: process.env.HOOX_API_ORIGIN ?? "http://127.0.0.1:3001",
    apiKey: process.env.HOOX_API_KEY,
    appOrigin: process.env.APP_ORIGIN ?? "http://127.0.0.1:4173",
    sessionToken: process.env.DEMO_SESSION_TOKEN,
    endUserId: process.env.DEMO_END_USER_ID ?? "Demo:local-user",
  };
  const proxy = createHooxProxy(config);
  const workspace = resolve(root, "../../runtime-ts");
  const vite = await createViteServer({
    root,
    resolve: {
      alias: [
        {
          find: "@hoox/chat-ui/styles.css",
          replacement: resolve(workspace, "packages/chat-ui/styles.css"),
        },
        {
          find: "@hoox/chat-ui",
          replacement: resolve(workspace, "packages/chat-ui/dist/index.js"),
        },
        { find: "@hoox/sdk", replacement: resolve(workspace, "packages/sdk/dist/index.js") },
        {
          find: "@hoox/ui-theme/theme.css",
          replacement: resolve(workspace, "packages/ui-theme/theme.css"),
        },
        { find: "react-dom", replacement: resolve(workspace, "apps/web/node_modules/react-dom") },
        { find: "react", replacement: resolve(workspace, "apps/web/node_modules/react") },
      ],
      dedupe: ["react", "react-dom"],
    },
    server: { middlewareMode: true, allowedHosts: ["127.0.0.1", "localhost"] },
    appType: "spa",
  });
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/hoox/") || request.url === "/demo-session") {
      void proxy(request, response).catch(() => {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          response.end('{"error":"代理请求失败"}');
        } else if (!response.destroyed) response.destroy();
      });
    } else {
      void vite.middlewares(request, response, () => response.writeHead(404).end());
    }
  });
  server.listen(4173, "127.0.0.1", () => console.log("Chat embed demo: http://127.0.0.1:4173"));
}

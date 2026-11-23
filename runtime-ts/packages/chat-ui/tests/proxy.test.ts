import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHooxProxy } from "../../../../examples/chat-embed/server.mjs";

describe("示例同源代理", () => {
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  it("示例环境变量契约与占位配置保持同步", async () => {
    const example = await readFile(
      fileURLToPath(new URL("../../../../examples/chat-embed/.env.example", import.meta.url)),
      "utf8",
    );
    const entries = Object.fromEntries(
      example
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    expect(Object.keys(entries).sort()).toEqual(
      [
        "APP_ORIGIN",
        "DEMO_END_USER_ID",
        "DEMO_SESSION_TOKEN",
        "HOOX_API_KEY",
        "HOOX_API_ORIGIN",
      ].sort(),
    );
    expect(entries.HOOX_API_KEY).toMatch(/^REPLACE_WITH_/u);
    expect(entries.DEMO_SESSION_TOKEN).toMatch(/^REPLACE_WITH_/u);
  });

  it("忽略浏览器凭据并由代理绑定终端用户", async () => {
    const fetcher = vi.fn(async (_input: URL, init: RequestInit) => {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer server-only-key");
      expect(new Headers(init.headers).get("hoox-end-user")).toBe("Customer:server-session");
      expect(new Headers(init.headers).get("x-api-key")).toBeNull();
      return Response.json({ version: "v1", requestId: "request", data: { items: [] } });
    });
    const proxy = createHooxProxy({
      apiOrigin: "https://hoox.example.invalid",
      apiKey: "server-only-key",
      appOrigin: "http://127.0.0.1:4173",
      sessionToken: "session-placeholder",
      endUserId: "Customer:server-session",
      fetcher,
    });
    server = createServer((request, response) => void proxy(request, response));
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("代理测试服务器没有监听地址");
    const appOrigin = "http://127.0.0.1:4173";
    const target = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${target}/demo-session`, {
      method: "POST",
      headers: { origin: appOrigin },
    });
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    const response = await fetch(`${target}/hoox/v1/agents`, {
      headers: {
        origin: appOrigin,
        cookie: cookie ?? "",
        authorization: "Bearer browser-injected-key",
        "hoox-end-user": "Customer:forged-user",
        "x-api-key": "browser-key",
      },
    });
    expect(login.status).toBe(204);
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("拒绝跨源请求且不会把请求转发到上游", async () => {
    const fetcher = vi.fn();
    const proxy = createHooxProxy({
      apiOrigin: "https://hoox.example.invalid",
      apiKey: "server-only-key",
      appOrigin: "http://127.0.0.1:4173",
      sessionToken: "session-placeholder",
      endUserId: "Customer:server-session",
      fetcher,
    });
    server = createServer((request, response) => void proxy(request, response));
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("代理测试服务器没有监听地址");
    const response = await fetch(`http://127.0.0.1:${address.port}/hoox/v1/agents`, {
      headers: { origin: "https://attacker.invalid" },
    });
    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

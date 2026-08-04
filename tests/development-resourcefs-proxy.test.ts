import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDevelopmentResourceFsProxyHandler,
  isResourceFilesystemPath,
} from "../scripts/development-resourcefs-proxy.mjs";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

describe("ResourceFS 开发 HTTPS 边界代理", () => {
  it("只允许 ResourceFS 路径，前缀碰撞也拒绝", () => {
    expect(isResourceFilesystemPath("/v1/resource-filesystem")).toBe(true);
    expect(isResourceFilesystemPath("/v1/resource-filesystem/tenant/file")).toBe(true);
    expect(isResourceFilesystemPath("/v1/resource-filesystem-private")).toBe(false);
    expect(isResourceFilesystemPath("/v1/threads")).toBe(false);
  });

  it("转发 WebDAV 方法、查询、正文与授权头，但不信任来路转发头", async () => {
    let received:
      | {
          authorization: string | undefined;
          body: string;
          forwardedFor: string | string[] | undefined;
          method: string | undefined;
          url: string | undefined;
        }
      | undefined;
    const upstream = await listen(
      createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          received = {
            method: request.method,
            url: request.url,
            authorization: request.headers.authorization,
            forwardedFor: request.headers["x-forwarded-for"],
            body: Buffer.concat(chunks).toString("utf8"),
          };
          response.writeHead(207, { "content-type": "application/xml" });
          response.end("<multistatus />");
        });
      }),
    );
    const proxy = await listen(
      createServer(
        createDevelopmentResourceFsProxyHandler({
          upstream: `http://127.0.0.1:${addressPort(upstream)}`,
        }),
      ),
    );

    const response = await fetch(
      `http://127.0.0.1:${addressPort(proxy)}/v1/resource-filesystem/tenant?depth=1`,
      {
        method: "PROPFIND",
        headers: {
          authorization: "ResourceFS signed-capability",
          "content-type": "application/xml",
          "x-forwarded-for": "attacker.invalid",
        },
        body: "<propfind />",
      },
    );

    expect(response.status).toBe(207);
    expect(await response.text()).toBe("<multistatus />");
    expect(received).toEqual({
      method: "PROPFIND",
      url: "/v1/resource-filesystem/tenant?depth=1",
      authorization: "ResourceFS signed-capability",
      forwardedFor: undefined,
      body: "<propfind />",
    });
  });

  it("拒绝非 ResourceFS 路径且不触达上游", async () => {
    const upstreamCalls = vi.fn();
    const upstream = await listen(
      createServer((_request, response) => {
        upstreamCalls();
        response.end("unexpected");
      }),
    );
    const proxy = await listen(
      createServer(
        createDevelopmentResourceFsProxyHandler({
          upstream: `http://127.0.0.1:${addressPort(upstream)}`,
        }),
      ),
    );

    const response = await fetch(`http://127.0.0.1:${addressPort(proxy)}/v1/threads/private`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "NOT_FOUND" });
    expect(upstreamCalls).not.toHaveBeenCalled();
  });

  it("上游不可达时返回稳定 502 且不泄漏连接细节", async () => {
    const proxy = await listen(
      createServer(
        createDevelopmentResourceFsProxyHandler({
          upstream: "http://127.0.0.1:1",
          upstreamTimeoutMs: 100,
        }),
      ),
    );

    const response = await fetch(
      `http://127.0.0.1:${addressPort(proxy)}/v1/resource-filesystem/tenant`,
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("拒绝把非 loopback 地址配置为开发代理上游", () => {
    expect(() =>
      createDevelopmentResourceFsProxyHandler({ upstream: "http://192.0.2.1:3001" }),
    ).toThrow("loopback HTTP");
  });
});

async function listen(server: Server): Promise<Server> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function addressPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("测试服务没有 TCP 地址");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

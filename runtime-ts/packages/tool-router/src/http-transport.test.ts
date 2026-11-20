import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { normalizeExternalToolSchema } from "@hoox/domain";
import { ExternalToolTransportError, type ExternalToolTransport } from "@hoox/run-contracts";
import {
  createHttpExternalToolTransport,
  deriveHttpToolSigningKey,
  verifyHttpToolSignature,
} from "./http-external-tool.js";

// 真实 TLS 夹具：证书在测试期间由 openssl 临时生成，仓库中不保存任何私钥。
let key = "";
let cert = "";
let fixtureDir = "";
beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "hoox-http-tool-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      join(fixtureDir, "key.pem"),
      "-out",
      join(fixtureDir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1",
    ],
    { stdio: "ignore" },
  );
  key = readFileSync(join(fixtureDir, "key.pem"), "utf8");
  cert = readFileSync(join(fixtureDir, "cert.pem"), "utf8");
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;
interface Fixture {
  readonly server: Server;
  readonly port: number;
  readonly requests: Array<{
    readonly req: IncomingMessage;
    readonly body: Buffer;
    readonly servername: string | false | null | undefined;
  }>;
  connections: number;
}
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function startServer(
  handler: Handler,
  listen: { host: string; port?: number; ipv6Only?: boolean } = { host: "127.0.0.1" },
): Promise<Fixture> {
  const server = createServer({ key, cert });
  const fixture = { server, port: 0, requests: [], connections: 0 } as {
    -readonly [K in keyof Fixture]: Fixture[K];
  };
  server.on("secureConnection", () => {
    fixture.connections += 1;
  });
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      fixture.requests.push({ req, body, servername: (req.socket as TLSSocket).servername });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, ...listen }, () => resolve());
  });
  servers.push(server);
  fixture.port = (server.address() as AddressInfo).port;
  return fixture;
}

const credential = "placeholder-credential";
const identityRootKey = Buffer.alloc(32, 7);
const schema = normalizeExternalToolSchema({
  type: "object",
  properties: { q: { type: "string" } },
  required: ["q"],
  additionalProperties: false,
});
const tool = {
  toolVersionId: "version-test",
  source: "http" as const,
  endpoint: "https://localhost/api",
  modelToolName: "http__lookup",
  description: "lookup",
  inputSchema: schema.schema,
  inputSchemaDigest: schema.digest,
  timeoutMs: 2000,
  maxResponseBytes: 128,
  sideEffect: "read_only" as const,
  idempotent: true,
  credentialRef: "placeholder-ref",
};
const callContext = {
  tenantId: "tenant-internal",
  endUserId: "user-internal",
  threadId: "thread-internal",
  runId: "run-internal",
};
type Invocation = Parameters<ExternalToolTransport["invoke"]>[0];

function invocation(
  port: number,
  overrides: Partial<Invocation> & { readonly hostname?: string; readonly address?: string } = {},
): Invocation {
  const { hostname = "localhost", address = "127.0.0.1", ...rest } = overrides;
  const url = new URL(`https://${hostname}:${port}/api?fixed=1`);
  return {
    tool,
    target: {
      url,
      hostname,
      servername: hostname,
      hostHeader: url.host,
      address,
      addresses: [address],
    },
    arguments: { q: "hello world" },
    callContext,
    credential,
    idempotencyKey: "call-key",
    method: "GET",
    timeoutMs: 2000,
    deadlineAt: Date.now() + 2000,
    maxResponseBytes: 128,
    redirect: "error",
    ...rest,
  };
}

const transport = () => createHttpExternalToolTransport({ identityRootKey, ca: cert });
const json =
  (status: number, value: unknown): Handler =>
  (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected failure");
}
const expectUnknown = (error: unknown) => {
  expect(error).not.toBeInstanceOf(ExternalToolTransportError);
  expect(error).toMatchObject({ message: "EXTERNAL_TOOL_RESULT_UNKNOWN" });
};

describe("HTTP Transport（真实 HTTPS）", () => {
  it("按域名完成证书与 SNI 校验，直拨已校验 IP，保留 Host 并发送 v1 签名", async () => {
    const fixture = await startServer(json(200, { ok: true }));
    const result = await transport().invoke(invocation(fixture.port));
    expect(new TextDecoder().decode(result.body)).toBe('{"ok":true}');
    const [received] = fixture.requests;
    if (!received) throw new Error("missing request");
    expect(received.servername).toBe("localhost");
    expect(received.req.headers.host).toBe(`localhost:${fixture.port}`);
    expect(received.req.url).toBe("/api?fixed=1&q=hello+world");
    expect(
      verifyHttpToolSignature({
        key: deriveHttpToolSigningKey(credential, tool.toolVersionId),
        method: "GET",
        path: received.req.url ?? "",
        body: received.body,
        headers: received.req.headers,
      }),
    ).toBe(true);
    const signature = String(received.req.headers["x-hoox-signature"]);
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/u);
    expect(result.authMaterial).toEqual([
      signature.slice(3),
      received.req.headers["x-hoox-timestamp"],
    ]);
    const headerText = JSON.stringify(received.req.headers);
    for (const id of Object.values(callContext)) expect(headerText).not.toContain(id);
    // 接收端持有验签密钥也无法用已知内部 ID 复算不透明标识。
    const guessed = createHmac("sha256", deriveHttpToolSigningKey(credential, tool.toolVersionId))
      .update("hoox-context-v1\ntenant\ntenant-internal")
      .digest("hex");
    expect(received.req.headers["x-hoox-tenant"]).toMatch(/^[0-9a-f]{64}$/u);
    expect(received.req.headers["x-hoox-tenant"]).not.toBe(guessed);
  });

  it("改写幂等键、身份头或超出时间窗口后验签失败", async () => {
    const fixture = await startServer(json(200, { ok: true }));
    await transport().invoke(invocation(fixture.port));
    const [received] = fixture.requests;
    if (!received) throw new Error("missing request");
    const base = {
      key: deriveHttpToolSigningKey(credential, tool.toolVersionId),
      method: "GET",
      path: received.req.url ?? "",
      body: received.body,
    };
    for (const [name, value] of [
      ["x-hoox-idempotency-key", "other-key"],
      ["x-hoox-end-user", "0".repeat(64)],
      ["x-hoox-run", "1".repeat(64)],
    ] as const)
      expect(
        verifyHttpToolSignature({ ...base, headers: { ...received.req.headers, [name]: value } }),
      ).toBe(false);
    expect(
      verifyHttpToolSignature({
        ...base,
        headers: received.req.headers,
        nowMs: Number(received.req.headers["x-hoox-timestamp"]) + 300_001,
      }),
    ).toBe(false);
  });

  it("证书不匹配原域名时在写出前失败", async () => {
    const fixture = await startServer(json(200, { ok: true }));
    const error = await failureOf(
      transport().invoke(invocation(fixture.port, { hostname: "wrong.example" })),
    );
    expect(error).toMatchObject({ disposition: "not_sent" });
    expect(fixture.requests).toHaveLength(0);
  });

  it("不复用连接：每次调用新建连接并拨号到本次校验的地址", async () => {
    const first = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", connection: "keep-alive" });
      res.end("A");
    });
    const call = transport();
    await call.invoke(invocation(first.port));
    await call.invoke(invocation(first.port));
    expect(first.connections).toBe(2);
    let second: Fixture | undefined;
    try {
      second = await startServer(
        (_req, res) => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("B");
        },
        { host: "::1", port: first.port, ipv6Only: true },
      );
    } catch {
      return; // 环境无 IPv6 回环或端口不可用时只验证连接数。
    }
    const result = await call.invoke(invocation(first.port, { address: "::1" }));
    expect(new TextDecoder().decode(result.body)).toBe("B");
    expect(second.requests[0]?.req.headers.host).toBe(`localhost:${first.port}`);
  });

  it("缺少方法绑定、GET 非只读、覆盖固定查询键或已过截止时间时在发包前拒绝", async () => {
    const fixture = await startServer(json(200, { ok: true }));
    const { method: _method, ...withoutMethod } = invocation(fixture.port);
    for (const input of [
      withoutMethod,
      { ...invocation(fixture.port), tool: { ...tool, sideEffect: "write" as const } },
      { ...invocation(fixture.port), arguments: { fixed: "2" } },
      invocation(fixture.port, { deadlineAt: Date.now() - 1 }),
    ])
      expect(await failureOf(transport().invoke(input))).toMatchObject({
        disposition: "not_sent",
      });
    expect(fixture.connections).toBe(0);
  });

  it("204 等合法空成功响应结算为成功", async () => {
    const fixture = await startServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const result = await transport().invoke(invocation(fixture.port, { method: "POST" }));
    expect(result.body.byteLength).toBe(0);
    expect(fixture.requests[0]?.body.toString()).toBe('{"q":"hello world"}');
  });

  it("无法解释的 2xx、5xx 与超限正文按 UNKNOWN 结算", async () => {
    const binary = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end("raw");
    });
    expectUnknown(await failureOf(transport().invoke(invocation(binary.port))));
    const failing = await startServer(json(503, { error: "busy" }));
    expectUnknown(await failureOf(transport().invoke(invocation(failing.port))));
    const large = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(500));
    });
    expectUnknown(await failureOf(transport().invoke(invocation(large.port))));
  });

  it("2xx 正文中途断开时立即以 UNKNOWN 结算一次", async () => {
    const lengthBased = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
      res.write('{"partial":');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const started = Date.now();
    expectUnknown(
      await failureOf(
        transport().invoke(invocation(lengthBased.port, { deadlineAt: Date.now() + 5000 })),
      ),
    );
    expect(Date.now() - started).toBeLessThan(2000);
    const chunked = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"partial":');
      setTimeout(() => res.socket?.end(), 20);
    });
    expectUnknown(
      await failureOf(
        transport().invoke(invocation(chunked.port, { deadlineAt: Date.now() + 5000 })),
      ),
    );
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("4xx 不排空正文，立即结算并关闭连接", async () => {
    let closed = false;
    const fixture = await startServer((_req, res) => {
      res.writeHead(400, { "content-type": "text/plain" });
      const timer = setInterval(() => res.write("x".repeat(64)), 10);
      res.on("close", () => {
        clearInterval(timer);
        closed = true;
      });
    });
    const error = await failureOf(
      transport().invoke(invocation(fixture.port, { deadlineAt: Date.now() + 5000 })),
    );
    expect(error).toMatchObject({ disposition: "responded_failure" });
    await expect.poll(() => closed).toBe(true);
  });

  it("写出后超时、慢速正文与取消均按 UNKNOWN 结算", async () => {
    const silent = await startServer(() => {});
    expectUnknown(
      await failureOf(
        transport().invoke(invocation(silent.port, { deadlineAt: Date.now() + 300 })),
      ),
    );
    const slow = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      const timer = setInterval(() => res.write("x"), 20);
      res.on("close", () => clearInterval(timer));
    });
    expectUnknown(
      await failureOf(transport().invoke(invocation(slow.port, { deadlineAt: Date.now() + 300 }))),
    );
    const controller = new AbortController();
    const pending = transport().invoke(invocation(silent.port, { signal: controller.signal }));
    await expect.poll(() => silent.requests.length).toBeGreaterThan(1);
    controller.abort();
    expectUnknown(await failureOf(pending));
  });
});

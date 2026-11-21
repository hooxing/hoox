import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  verifyWebhookSignature,
  type ClaimedWebhookDelivery,
  type WebhookSendPermit,
  type WebhookSettlement,
} from "@hoox/persistence/postgres";
import {
  sendWebhookRequest,
  WebhookDispatcher,
  type WebhookOutboxPort,
  type WebhookTarget,
} from "./webhook-dispatcher.js";

// 真实 TLS 夹具：证书在测试期间由 openssl 临时生成，仓库中不保存任何私钥。
let key = "";
let cert = "";
let fixtureDir = "";
beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "hoox-webhook-"));
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
      "/CN=hooks.example.test",
      "-addext",
      "subjectAltName=DNS:hooks.example.test",
    ],
    { stdio: "ignore" },
  );
  key = readFileSync(join(fixtureDir, "key.pem"), "utf8");
  cert = readFileSync(join(fixtureDir, "cert.pem"), "utf8");
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

interface Received {
  readonly req: IncomingMessage;
  readonly body: Buffer;
  readonly servername: string | false | null | undefined;
}
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void,
): Promise<{ port: number; received: Received[]; connections: () => number }> {
  const server = createServer({ key, cert });
  const received: Received[] = [];
  let connections = 0;
  server.on("secureConnection", () => {
    connections += 1;
  });
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      received.push({ req, body, servername: (req.socket as TLSSocket).servername });
      handler(req, res, body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    connections: () => connections,
  };
}

function target(port: number, hostname = "hooks.example.test"): WebhookTarget {
  const url = new URL(`https://${hostname}:${port}/hook?team=a`);
  return Object.freeze({
    url,
    hostname,
    servername: hostname,
    hostHeader: url.host,
    address: "127.0.0.1",
    addresses: Object.freeze(["127.0.0.1"]),
  });
}

const secret = "receiver-secret-placeholder";
const ciphertext = { version: 1 as const, nonce: "n", ciphertext: "c", authTag: "t" };

function delivery(overrides: Partial<ClaimedWebhookDelivery> = {}): ClaimedWebhookDelivery {
  return {
    tenantId: "tenant_a",
    id: "delivery_a",
    webhookId: "wh_a",
    eventId: "evt_a",
    endpointUrl: "https://hooks.example.test/hook",
    payload: { id: "evt_a", type: "run.succeeded", data: { runId: "run_a", status: "succeeded" } },
    attempts: 1,
    claimToken: "claim_a",
    ...overrides,
  };
}

class FakeStore implements WebhookOutboxPort {
  readonly leaseMs = 30_000;
  readonly maxAttempts = 12;
  readonly settlements: Array<{ id: string; settlement: WebhookSettlement }> = [];
  readonly claims: Array<readonly string[]> = [];
  permit: WebhookSendPermit = { outcome: "send", secretCiphertext: ciphertext };
  constructor(readonly queue: ClaimedWebhookDelivery[] = []) {}
  async claim(input: { readonly excludedTenantIds?: readonly string[] }) {
    const excluded = input.excludedTenantIds ?? [];
    this.claims.push(excluded);
    const index = this.queue.findIndex((item) => !excluded.includes(item.tenantId));
    return index < 0 ? undefined : this.queue.splice(index, 1)[0];
  }
  async permitSend(): Promise<WebhookSendPermit> {
    return this.permit;
  }
  async settle(item: ClaimedWebhookDelivery, settlement: WebhookSettlement) {
    this.settlements.push({ id: item.id, settlement });
  }
}

function dispatcher(store: FakeStore, ports: Record<string, number>, deadlineMs = 2_000) {
  return new WebhookDispatcher({
    store,
    cipher: { decrypt: () => secret },
    owner: "scheduler_test",
    deadlineMs,
    concurrency: 2,
    ca: cert,
    resolveTarget: async (url) => {
      const tenant = new URL(url).searchParams.get("tenant") ?? "tenant_a";
      return target(ports[tenant] ?? 1);
    },
  });
}

async function expectFailure(promise: Promise<void>, code: string): Promise<number> {
  const started = Date.now();
  await expect(promise).rejects.toMatchObject({ code });
  return Date.now() - started;
}

describe("Webhook 发送", () => {
  it("直拨已校验 IP，保留原始 Host 并按原主机名校验证书与签名", async () => {
    const server = await startServer((_req, res) => res.end("ok"));
    const store = new FakeStore([delivery()]);
    const instance = dispatcher(store, { tenant_a: server.port });

    await instance.pump();
    await instance.close();

    expect(store.settlements).toEqual([{ id: "delivery_a", settlement: { kind: "delivered" } }]);
    const [request] = server.received;
    expect(request?.req.headers.host).toBe(`hooks.example.test:${server.port}`);
    expect(request?.servername).toBe("hooks.example.test");
    expect(request?.req.url).toBe("/hook?team=a");
    const headers = request?.req.headers ?? {};
    expect(
      verifyWebhookSignature(
        secret,
        String(headers["x-hoox-timestamp"]),
        String(headers["x-hoox-event-id"]),
        request?.body ?? Buffer.alloc(0),
        String(headers["x-hoox-signature"]),
      ),
    ).toBe(true);
  });

  it("每次投递新建连接，不复用共享连接池", async () => {
    const server = await startServer((_req, res) => res.end("ok"));
    const body = Buffer.from("{}");
    for (let index = 0; index < 2; index += 1)
      await sendWebhookRequest({
        target: target(server.port),
        body,
        headers: { "content-length": "2" },
        deadlineAt: Date.now() + 2_000,
        ca: cert,
      });
    expect(server.connections()).toBe(2);
  });

  it("证书名称与原目标不符时拒绝发送", async () => {
    const server = await startServer((_req, res) => res.end("ok"));
    await expectFailure(
      sendWebhookRequest({
        target: target(server.port, "other.example.test"),
        body: Buffer.from("{}"),
        headers: {},
        deadlineAt: Date.now() + 2_000,
        ca: cert,
      }),
      "connection_failed",
    );
    expect(server.received).toHaveLength(0);
  });

  it("复核后已过截止时间时不再连接", async () => {
    const server = await startServer((_req, res) => res.end());
    await expectFailure(
      sendWebhookRequest({
        target: target(server.port),
        body: Buffer.alloc(0),
        headers: {},
        deadlineAt: Date.now() - 1,
        ca: cert,
      }),
      "timeout",
    );
    expect(server.connections()).toBe(0);
  });

  it("接收端不回包时在截止时间销毁连接并失败", async () => {
    const server = await startServer(() => undefined);
    const elapsed = await expectFailure(
      sendWebhookRequest({
        target: target(server.port),
        body: Buffer.from("{}"),
        headers: {},
        deadlineAt: Date.now() + 300,
        ca: cert,
      }),
      "timeout",
    );
    expect(elapsed).toBeLessThan(2_000);
  });

  it("慢速分块响应不能越过截止时间", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      const timer = setInterval(() => res.write("."), 50);
      res.on("close", () => clearInterval(timer));
    });
    const elapsed = await expectFailure(
      sendWebhookRequest({
        target: target(server.port),
        body: Buffer.from("{}"),
        headers: {},
        deadlineAt: Date.now() + 400,
        ca: cert,
      }),
      "timeout",
    );
    expect(elapsed).toBeLessThan(2_000);
  });

  it("响应超限、提前断开与非 2xx 均只结算一次失败", async () => {
    const large = await startServer((_req, res) => {
      res.writeHead(200);
      res.write(Buffer.alloc(40 * 1024));
      res.write(Buffer.alloc(40 * 1024));
    });
    await expectFailure(
      sendWebhookRequest({
        target: target(large.port),
        body: Buffer.from("{}"),
        headers: {},
        deadlineAt: Date.now() + 2_000,
        ca: cert,
      }),
      "response_too_large",
    );
    const truncated = await startServer((_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
      setTimeout(() => res.socket?.destroy(), 20);
    });
    await expectFailure(
      sendWebhookRequest({
        target: target(truncated.port),
        body: Buffer.from("{}"),
        headers: {},
        deadlineAt: Date.now() + 2_000,
        ca: cert,
      }),
      "response_failed",
    );
    const rejected = await startServer((_req, res) => {
      res.writeHead(302, { location: "https://hooks.example.test/elsewhere" });
      res.end();
    });
    await expectFailure(
      sendWebhookRequest({
        target: target(rejected.port),
        body: Buffer.from("{}"),
        headers: {},
        deadlineAt: Date.now() + 2_000,
        ca: cert,
      }),
      "non_success_response",
    );
    expect(rejected.received).toHaveLength(1);
  });
});

describe("Webhook Dispatcher", () => {
  it("默认地址校验在解密和连接前拒绝私网", async () => {
    const server = await startServer((_req, res) => res.end());
    const store = new FakeStore([
      delivery({ endpointUrl: `https://127.0.0.1:${server.port}/hook` }),
    ]);
    const instance = new WebhookDispatcher({
      store,
      cipher: {
        decrypt: () => {
          throw new Error("不应解密");
        },
      },
      owner: "scheduler_test",
    });
    await instance.pump();
    await instance.close();
    expect(server.connections()).toBe(0);
    expect(store.settlements[0]?.settlement).toEqual({
      kind: "retry",
      errorCode: "target_rejected",
      delayMs: 2000,
    });
  });

  it("单个 Tenant 的慢接收端不阻塞其他 Tenant，并且同一 Tenant 不占用多个槽位", async () => {
    const hanging = await startServer(() => undefined);
    const healthy = await startServer((_req, res) => res.end("ok"));
    const store = new FakeStore([
      delivery({ id: "a1", endpointUrl: "https://hooks.example.test/?tenant=tenant_a" }),
      delivery({ id: "a2", endpointUrl: "https://hooks.example.test/?tenant=tenant_a" }),
      delivery({
        id: "b1",
        tenantId: "tenant_b",
        endpointUrl: "https://hooks.example.test/?tenant=tenant_b",
      }),
    ]);
    const instance = dispatcher(store, { tenant_a: hanging.port, tenant_b: healthy.port }, 600);

    await instance.pump();
    expect(store.claims[1]).toEqual(["tenant_a"]);
    expect(store.queue.map((item) => item.id)).toEqual(["a2"]);
    await instance.close();

    expect(store.settlements).toEqual(
      expect.arrayContaining([
        { id: "b1", settlement: { kind: "delivered" } },
        {
          id: "a1",
          settlement: { kind: "retry", errorCode: "timeout", delayMs: 2_000 },
        },
      ]),
    );
    expect(store.settlements).toHaveLength(2);
  });

  it("目标解析悬挂时同样受截止时间约束", async () => {
    const store = new FakeStore([delivery()]);
    let resolutionSignal: AbortSignal | undefined;
    const instance = new WebhookDispatcher({
      store,
      cipher: { decrypt: () => secret },
      owner: "scheduler_test",
      deadlineMs: 200,
      resolveTarget: (_url, options) => {
        resolutionSignal = options?.signal;
        return new Promise<WebhookTarget>(() => undefined);
      },
    });
    const started = Date.now();
    await instance.pump();
    await instance.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(resolutionSignal?.aborted).toBe(true);
    expect(store.settlements[0]?.settlement).toMatchObject({ kind: "retry", errorCode: "timeout" });
  });

  it("发送前复核失败（订阅已停用或领取失效）时不发送也不重复结算", async () => {
    const server = await startServer((_req, res) => res.end("ok"));
    const store = new FakeStore([delivery()]);
    store.permit = { outcome: "skip" };
    const instance = dispatcher(store, { tenant_a: server.port });
    await instance.pump();
    await instance.close();
    expect(server.received).toHaveLength(0);
    expect(store.settlements).toEqual([]);
  });

  it("最后一次允许的尝试失败后结算为耗尽", async () => {
    const server = await startServer((_req, res) => {
      res.statusCode = 500;
      res.end();
    });
    const store = new FakeStore([delivery({ attempts: 12 })]);
    const instance = dispatcher(store, { tenant_a: server.port });
    await instance.pump();
    await instance.close();
    expect(store.settlements).toEqual([
      {
        id: "delivery_a",
        settlement: { kind: "exhausted", errorCode: "non_success_response" },
      },
    ]);
  });

  it("拒绝短于发送时限加结算余量的租约", () => {
    const store = new FakeStore();
    expect(
      () =>
        new WebhookDispatcher({
          store,
          cipher: { decrypt: () => secret },
          owner: "scheduler_test",
          deadlineMs: 28_000,
        }),
    ).toThrow("WEBHOOK_DISPATCH_DEADLINE_INVALID");
  });
});

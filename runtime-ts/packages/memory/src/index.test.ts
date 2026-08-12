import { describe, expect, it, vi } from "vitest";
import {
  mem0ScopeIds,
  MemoryIngestionConsumer,
  Mem0PlatformMemoryProvider,
  MemoryProviderError,
  parseMem0DevelopmentEnvironment,
  type MemoryIngestionClaim,
  type MemoryIngestionSource,
  type MemoryIngestionStore,
} from "./index.js";

const source = Object.freeze({
  tenantId: "tenant-a",
  tenantKind: "personal",
  userId: "user-a",
  threadId: "thread-a",
  runId: "run-a",
  messages: Object.freeze([
    Object.freeze({ role: "user", content: "我主要使用 TypeScript。" }),
    Object.freeze({ role: "assistant", content: "已经了解。" }),
  ]),
}) satisfies MemoryIngestionSource;

const eventId = "2c4d1f44-4f7b-4b2f-9f6e-7b5b4f5a1234";
const scopeKey = "development-memory-scope-key-32-bytes-minimum";

describe("Mem0 Platform Provider", () => {
  it("开发配置默认关闭，启用时要求完整密钥且拒绝 production", () => {
    expect(parseMem0DevelopmentEnvironment({ RUNTIME_ENV: "development" })).toEqual({
      enabled: false,
    });
    expect(
      parseMem0DevelopmentEnvironment({
        RUNTIME_ENV: "development",
        MEM0_MEMORY_ENABLED: "true",
        MEM0_API_BASE_URL: "https://api.mem0.ai/",
        MEM0_API_KEY: "development-secret",
        MEM0_SCOPE_HMAC_KEY: scopeKey,
        MEM0_REQUEST_TIMEOUT_MS: "5000",
      }),
    ).toEqual({
      enabled: true,
      baseUrl: "https://api.mem0.ai/",
      apiKey: "development-secret",
      scopeHmacKey: scopeKey,
      timeoutMs: 5_000,
    });
    expect(() =>
      parseMem0DevelopmentEnvironment({
        RUNTIME_ENV: "production",
        MEM0_MEMORY_ENABLED: "true",
      }),
    ).toThrow("Mem0 Platform 记忆当前只允许 development 启用");
  });

  it("只发送 user/assistant 增量，并用不可逆 scope 隐藏内部 ID", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new Mem0PlatformMemoryProvider({
      baseUrl: "https://api.mem0.example.invalid/",
      apiKey: "development-secret",
      scopeHmacKey: scopeKey,
      fetcher: async (input, init) => {
        requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
        return new Response(JSON.stringify({ status: "PENDING", event_id: eventId }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(provider.submit(source)).resolves.toEqual({ status: "PENDING", eventId });
    expect(requests[0]?.url).toBe("https://api.mem0.example.invalid/v3/memories/add/");
    expect(requests[0]?.init?.headers).toMatchObject({
      accept: "application/json",
      authorization: "Token development-secret",
      "content-type": "application/json",
    });
    const bodyText = String(requests[0]?.init?.body);
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    expect(body.messages).toEqual(source.messages);
    expect(body.infer).toBe(true);
    expect(bodyText).not.toContain(source.tenantId);
    expect(bodyText).not.toContain(source.userId);
    expect(bodyText).not.toContain(source.threadId);
    expect(bodyText).not.toContain(source.runId);
  });

  it("团队成员共享团队 scope，但 Thread 和 Run 来源仍独立", () => {
    const first = mem0ScopeIds({ ...source, tenantKind: "team", userId: "member-a" }, scopeKey);
    const second = mem0ScopeIds(
      { ...source, tenantKind: "team", userId: "member-b", threadId: "thread-b", runId: "run-b" },
      scopeKey,
    );
    expect(first.userId).toBe(second.userId);
    expect(first.threadId).not.toBe(second.threadId);
    expect(first.runId).not.toBe(second.runId);
  });

  it("轮询事件只接受固定状态和同一 event ID", async () => {
    const provider = new Mem0PlatformMemoryProvider({
      baseUrl: "https://api.mem0.example.invalid",
      apiKey: "development-secret",
      scopeHmacKey: scopeKey,
      fetcher: async () =>
        new Response(JSON.stringify({ id: eventId, status: "SUCCEEDED" }), { status: 200 }),
    });
    await expect(provider.getEvent(eventId)).resolves.toEqual({ eventId, status: "SUCCEEDED" });
  });

  it("不回显上游错误正文，并拒绝不安全线上 URL", async () => {
    expect(
      () =>
        new Mem0PlatformMemoryProvider({
          baseUrl: "http://mem0.example.invalid",
          apiKey: "development-secret",
          scopeHmacKey: scopeKey,
        }),
    ).toThrow("Mem0 线上连接必须使用 HTTPS");

    const provider = new Mem0PlatformMemoryProvider({
      baseUrl: "https://api.mem0.example.invalid",
      apiKey: "development-secret",
      scopeHmacKey: scopeKey,
      fetcher: async () => new Response("secret provider error", { status: 503 }),
    });
    await expect(provider.submit(source)).rejects.toEqual(
      expect.objectContaining<Partial<MemoryProviderError>>({ code: "PROVIDER_UNAVAILABLE" }),
    );
  });

  it("拒绝 system/tool 消息和超出请求预算的数据", async () => {
    const provider = new Mem0PlatformMemoryProvider({
      baseUrl: "https://api.mem0.example.invalid",
      apiKey: "development-secret",
      scopeHmacKey: scopeKey,
      maximumRequestBytes: 1_024,
      fetcher: async () => new Response(JSON.stringify({ status: "PENDING", event_id: eventId })),
    });
    await expect(
      provider.submit({
        ...source,
        messages: [{ role: "system" as "user", content: "隐藏提示" }],
      }),
    ).rejects.toThrow("Mem0 只接受 user/assistant 消息");
    await expect(
      provider.submit({
        ...source,
        messages: [{ role: "user", content: "长".repeat(2_000) }],
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "REQUEST_REJECTED" }));
  });

  it("限制 Provider 响应体大小", async () => {
    const provider = new Mem0PlatformMemoryProvider({
      baseUrl: "https://api.mem0.example.invalid",
      apiKey: "development-secret",
      scopeHmacKey: scopeKey,
      maximumResponseBytes: 1_024,
      fetcher: async () => new Response(JSON.stringify({ padding: "x".repeat(2_000) })),
    });

    await expect(provider.submit(source)).rejects.toEqual(
      expect.objectContaining({ code: "INVALID_RESPONSE" }),
    );
  });
});

class FakeIngestionStore implements MemoryIngestionStore {
  readonly submitted = vi.fn(async () => true);
  readonly deferPoll = vi.fn(async () => true);
  readonly complete = vi.fn(async () => true);
  readonly fail = vi.fn(async () => true);

  constructor(readonly claim: MemoryIngestionClaim | undefined) {}

  async claimNext(): Promise<MemoryIngestionClaim | undefined> {
    return this.claim;
  }
}

const ingestionClaim = Object.freeze({
  ...source,
  claimToken: "claim-a",
  claimGeneration: 1,
  attemptCount: 1,
}) satisfies MemoryIngestionClaim;

describe("记忆异步 Outbox 消费器", () => {
  it("首次提交只记录 Provider event，不把 PENDING 当作完成", async () => {
    const store = new FakeIngestionStore(ingestionClaim);
    const provider = {
      submit: vi.fn(async () => ({ eventId, status: "PENDING" as const })),
      getEvent: vi.fn(),
    };
    const consumer = new MemoryIngestionConsumer(
      store,
      provider,
      "worker-a",
      30_000,
      5,
      1_000,
      2_000,
    );

    await expect(consumer.drainTenant("tenant-a")).resolves.toBe(1);
    expect(store.submitted).toHaveBeenCalledWith(ingestionClaim, { eventId, status: "PENDING" });
    expect(store.complete).not.toHaveBeenCalled();
  });

  it("已提交任务轮询成功后才完成", async () => {
    const claim = { ...ingestionClaim, providerEventId: eventId };
    const store = new FakeIngestionStore(claim);
    const provider = {
      submit: vi.fn(),
      getEvent: vi.fn(async () => ({ eventId, status: "SUCCEEDED" as const })),
    };
    const consumer = new MemoryIngestionConsumer(
      store,
      provider,
      "worker-a",
      30_000,
      5,
      1_000,
      2_000,
    );

    await expect(consumer.drainTenant("tenant-a")).resolves.toBe(1);
    expect(store.complete).toHaveBeenCalledWith(claim);
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it("Provider 错误只持久化稳定错误码", async () => {
    const store = new FakeIngestionStore(ingestionClaim);
    const provider = {
      submit: vi.fn(async () => {
        throw new MemoryProviderError("TIMEOUT");
      }),
      getEvent: vi.fn(),
    };
    const consumer = new MemoryIngestionConsumer(
      store,
      provider,
      "worker-a",
      30_000,
      5,
      1_000,
      2_000,
    );

    await expect(consumer.drainTenant("tenant-a")).resolves.toBe(1);
    expect(store.fail).toHaveBeenCalledWith(ingestionClaim, {
      errorCode: "TIMEOUT",
      maximumAttempts: 5,
      retryBaseMs: 1_000,
    });
  });

  it("本地完成写回失败不会被误记成 Provider 失败", async () => {
    const store = new FakeIngestionStore(ingestionClaim);
    store.complete.mockRejectedValueOnce(new Error("database unavailable"));
    const provider = {
      submit: vi.fn(async () => ({ eventId, status: "SUCCEEDED" as const })),
      getEvent: vi.fn(),
    };
    const consumer = new MemoryIngestionConsumer(
      store,
      provider,
      "worker-a",
      30_000,
      5,
      1_000,
      2_000,
    );

    await expect(consumer.drainTenant("tenant-a")).rejects.toThrow("database unavailable");
    expect(store.fail).not.toHaveBeenCalled();
  });
});

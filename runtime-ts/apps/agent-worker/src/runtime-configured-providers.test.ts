import type {
  RunCompactionSettings,
  RuntimeControlConfigurationSnapshot,
} from "@hoox/admin-control";
import type { Mem0PlatformMemoryProvider } from "@hoox/memory";
import type { AgentSessionFactoryPort } from "@hoox/run-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  RuntimeConfiguredMemoryProvider,
  RuntimeConfiguredSessionFactory,
} from "./runtime-configured-providers.js";

function snapshot(revision: number, maxTokens = 8192): RuntimeControlConfigurationSnapshot {
  return {
    generation: revision,
    modelApiKey: "managed-model-key",
    model: {
      revision,
      versionToken: 1,
      status: "active",
      probeStatus: "healthy",
      createdBy: "user_admin",
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
      configuration: {
        providerKey: "main",
        displayName: "主模型",
        protocol: "openai-compatible",
        baseUrl: "https://model.example.com/v1",
        credentialConfigured: true,
        defaultModelId: `model-${revision}`,
        models: [
          {
            id: `model-${revision}`,
            name: `Model ${revision}`,
            enabled: true,
            reasoning: false,
            input: ["text"],
            contextWindow: 128_000,
            maxTokens,
          },
        ],
      },
    },
  };
}

function memorySnapshot(enabled: boolean): RuntimeControlConfigurationSnapshot {
  return {
    ...snapshot(3),
    memory: {
      revision: 2,
      versionToken: 1,
      status: "active",
      probeStatus: "healthy",
      createdBy: "user_admin",
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
      configuration: {
        providerKey: "memory",
        displayName: "长期记忆",
        providerKind: "mem0",
        baseUrl: "https://memory.example.com/",
        apiSecretRef: "deployment:memory-api",
        scopeSecretRef: "deployment:memory-scope",
        requestTimeoutMs: 5_000,
        enabled,
      },
    },
  };
}

function createInput(runId: string): Parameters<AgentSessionFactoryPort["create"]>[0] {
  return {
    scope: { tenantId: "tenant-a", threadId: "thread-a", runId },
  } as Parameters<AgentSessionFactoryPort["create"]>[0];
}

describe("Run 固定运行配置", () => {
  const deploymentSettings: RunCompactionSettings = {
    softLimitPercent: 80,
    targetPercent: 55,
    recentUserTokens: 4096,
    maxOutputTokens: 4096,
    timeoutMs: 60_000,
  };

  it("部署模型也先固定压缩参数，同一模型和最终参数只装配一次", async () => {
    const session = { dispose() {} } as Awaited<ReturnType<AgentSessionFactoryPort["create"]>>;
    const configured = { create: vi.fn(async () => session) };
    const resolveForRun = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(snapshot(2))
      .mockResolvedValue(snapshot(2));
    const build = vi.fn(async () => configured);
    const resolveCompaction = vi.fn(async () => deploymentSettings);
    const factory = new RuntimeConfiguredSessionFactory(
      { resolveForRun },
      { resolveForRun: resolveCompaction },
      deploymentSettings,
      8192,
      build,
    );

    await factory.create(createInput("run-fallback"));
    await factory.create(createInput("run-a"));
    await factory.create(createInput("run-b"));

    expect(resolveCompaction).toHaveBeenCalledTimes(3);
    expect(resolveCompaction).toHaveBeenNthCalledWith(1, {
      tenantId: "tenant-a",
      runId: "run-fallback",
      deploymentSettings,
    });
    expect(build).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenNthCalledWith(1, undefined, deploymentSettings);
    expect(configured.create).toHaveBeenCalledTimes(3);
  });

  it("同一模型恢复不同压缩快照时不复用错误的 Session 工厂", async () => {
    const session = { dispose() {} } as Awaited<ReturnType<AgentSessionFactoryPort["create"]>>;
    const first = { ...deploymentSettings, maxOutputTokens: 2048 };
    const second = { ...deploymentSettings, targetPercent: 60 };
    const build = vi.fn(async () => ({ create: async () => session }));
    const factory = new RuntimeConfiguredSessionFactory(
      { resolveForRun: async () => snapshot(2) },
      {
        resolveForRun: vi
          .fn()
          .mockResolvedValueOnce(first)
          .mockResolvedValueOnce(second)
          .mockResolvedValueOnce(first),
      },
      deploymentSettings,
      8192,
      build,
    );
    await factory.create(createInput("run-first"));
    await factory.create(createInput("run-second"));
    await factory.create(createInput("run-first"));
    expect(build).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenNthCalledWith(1, snapshot(2), first);
    expect(build).toHaveBeenNthCalledWith(2, snapshot(2), second);
  });

  it("新 Run 按固定模型裁剪预算，恢复时保持仓储已保存的实际预算", async () => {
    const session = { dispose() {} } as Awaited<ReturnType<AgentSessionFactoryPort["create"]>>;
    const modelSnapshot = snapshot(4);
    const build = vi.fn(async () => ({ create: async () => session }));
    const saved = { ...deploymentSettings, maxOutputTokens: 2048 };
    const resolveCompaction = vi.fn(async () => saved);
    const factory = new RuntimeConfiguredSessionFactory(
      { resolveForRun: async () => modelSnapshot },
      { resolveForRun: resolveCompaction },
      { ...deploymentSettings, maxOutputTokens: 16_384 },
      32_768,
      build,
    );
    await factory.create(createInput("run-resume"));
    expect(resolveCompaction).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      runId: "run-resume",
      deploymentSettings: { ...deploymentSettings, maxOutputTokens: 8192 },
    });
    expect(build).toHaveBeenCalledWith(modelSnapshot, saved);
  });

  it.each([
    { name: "重启后部署模型上限降低", restoredModel: undefined },
    { name: "部署回退 Run 接入较小托管模型", restoredModel: snapshot(5, 2048) },
  ])("$name 时仅裁剪执行预算，保留原快照和其余四项参数", async ({ restoredModel }) => {
    const session = { dispose() {} } as Awaited<ReturnType<AgentSessionFactoryPort["create"]>>;
    let saved: RunCompactionSettings | undefined;
    const store = {
      resolveForRun: async (input: { readonly deploymentSettings: RunCompactionSettings }) => {
        saved ??= Object.freeze({ ...input.deploymentSettings });
        return saved;
      },
    };
    const originalBuild = vi.fn(async () => ({ create: async () => session }));
    await new RuntimeConfiguredSessionFactory(
      { resolveForRun: async () => undefined },
      store,
      deploymentSettings,
      8192,
      originalBuild,
    ).create(createInput("run-fallback-resume"));
    expect(originalBuild).toHaveBeenCalledWith(undefined, deploymentSettings);

    const restoredBuild = vi.fn(async () => ({ create: async () => session }));
    await new RuntimeConfiguredSessionFactory(
      { resolveForRun: async () => restoredModel },
      store,
      {
        softLimitPercent: 90,
        targetPercent: 60,
        recentUserTokens: 512,
        maxOutputTokens: 16_384,
        timeoutMs: 3000,
      },
      2048,
      restoredBuild,
    ).create(createInput("run-fallback-resume"));
    expect(saved).toEqual(deploymentSettings);
    expect(restoredBuild).toHaveBeenCalledWith(restoredModel, {
      ...deploymentSettings,
      maxOutputTokens: 2048,
    });
  });

  it("记忆按 Run 快照选择，显式关闭覆盖部署回退且同一 revision 复用实例", async () => {
    const fallback = {} as Mem0PlatformMemoryProvider;
    const resolveForRun = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(memorySnapshot(false))
      .mockResolvedValue(memorySnapshot(true));
    const provider = new RuntimeConfiguredMemoryProvider(
      { resolveForRun },
      { apiKey: "memory-secret", scopeHmacKey: "s".repeat(32) },
      fallback,
    );
    const source = {
      tenantId: "tenant-a",
      tenantKind: "personal" as const,
      userId: "user-a",
      threadId: "thread-a",
      runId: "run-a",
      messages: [{ role: "user" as const, content: "hello" }],
    };

    await expect(provider.resolve(source)).resolves.toBe(fallback);
    await expect(provider.resolve(source)).resolves.toBeUndefined();
    const active = await provider.resolve(source);
    expect(active).toBeDefined();
    await expect(provider.resolve(source)).resolves.toBe(active);
  });

  it.each([false, true])(
    "无托管模型和部署 API Key 时使用后台记忆密钥，沿用历史隔离密钥=%s",
    async (legacyScope) => {
      const memory = memorySnapshot(true).memory;
      if (memory === undefined) throw new Error("测试记忆缺失");
      const current = {
        generation: 1,
        memoryApiKey: "unit-managed-memory-key",
        memory: {
          ...memory,
          configuration: {
            ...memory.configuration,
            apiSecretRef: "managed:memory-api" as const,
            scopeSecretRef: "platform:memory-scope" as const,
          },
        },
      };
      const fetcher = vi.fn(
        async (_url: unknown, _init?: RequestInit) =>
          new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", fetcher);
      try {
        const provider = new RuntimeConfiguredMemoryProvider(
          { resolveForRun: async () => current },
          legacyScope
            ? {
                apiKey: "unused-deployment-key",
                scopeHmacKey: "legacy-scope-key-at-least-32-bytes",
              }
            : undefined,
          undefined,
          "platform-scope-key-at-least-32-bytes",
        );
        const source = {
          tenantId: "tenant-a",
          tenantKind: "personal" as const,
          userId: "user-a",
          threadId: "thread-a",
          runId: "run-a",
          query: "长期偏好",
        };
        await expect(provider.retrieve(source)).resolves.toEqual([]);
        expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
          "Token unit-managed-memory-key",
        );
        const firstBody = fetcher.mock.calls[0]?.[1]?.body;
        const comparison = new RuntimeConfiguredMemoryProvider(
          { resolveForRun: async () => ({ ...current, memoryApiKey: "rotated-memory-key" }) },
          undefined,
          undefined,
          legacyScope
            ? "legacy-scope-key-at-least-32-bytes"
            : "platform-scope-key-at-least-32-bytes",
        );
        await comparison.retrieve(source);
        expect(fetcher.mock.calls[1]?.[1]?.body).toBe(firstBody);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});

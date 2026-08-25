import type { RuntimeControlConfigurationSnapshot } from "@hoox/admin-control";
import type { Mem0PlatformMemoryProvider } from "@hoox/memory";
import type { AgentSessionFactoryPort } from "@hoox/run-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  RuntimeConfiguredMemoryProvider,
  RuntimeConfiguredSessionFactory,
} from "./runtime-configured-providers.js";

function snapshot(revision: number): RuntimeControlConfigurationSnapshot {
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
            maxTokens: 8_192,
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
  it("无发布配置时回退部署模型，同一 revision 只装配一次", async () => {
    const session = { dispose() {} } as Awaited<ReturnType<AgentSessionFactoryPort["create"]>>;
    const fallback = { create: vi.fn(async () => session) };
    const configured = { create: vi.fn(async () => session) };
    const resolveForRun = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(snapshot(2))
      .mockResolvedValue(snapshot(2));
    const build = vi.fn(async () => configured);
    const factory = new RuntimeConfiguredSessionFactory(fallback, { resolveForRun }, build);

    await factory.create(createInput("run-fallback"));
    await factory.create(createInput("run-a"));
    await factory.create(createInput("run-b"));

    expect(fallback.create).toHaveBeenCalledOnce();
    expect(build).toHaveBeenCalledOnce();
    expect(configured.create).toHaveBeenCalledTimes(2);
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
});

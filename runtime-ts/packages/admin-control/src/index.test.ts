import { describe, expect, it } from "vitest";
import {
  AdminControlService,
  type AdminControlServiceError,
  type AdminControlRepository,
  normalizeMemoryProviderConfiguration,
  normalizeModelProviderConfiguration,
  normalizeRuntimeSettingsConfiguration,
} from "./index.js";

describe("后台控制面领域规则", () => {
  it("规范化 OpenAI-compatible 模型配置并拒绝凭据 URL", () => {
    expect(
      normalizeModelProviderConfiguration({
        providerKey: " Main-Model ",
        displayName: " 主模型 ",
        protocol: "openai-compatible",
        baseUrl: "https://model.example.com/v1#fragment",
        secretRef: "deployment:model",
        modelId: "model-a",
        supportsImages: true,
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
      }),
    ).toMatchObject({ providerKey: "main-model", baseUrl: "https://model.example.com/v1" });
    expect(() =>
      normalizeModelProviderConfiguration({
        providerKey: "model",
        displayName: "模型",
        protocol: "openai-compatible",
        baseUrl: "https://user:secret@example.com/v1",
        secretRef: "deployment:model",
        modelId: "model-a",
        supportsImages: false,
        contextWindow: 1_000,
        maxOutputTokens: 100,
      }),
    ).toThrow("Provider 地址必须是无凭据 HTTPS URL");
  });

  it("拒绝输出预算超过上下文窗口和未知记忆秘密引用", () => {
    expect(() =>
      normalizeModelProviderConfiguration({
        providerKey: "model",
        displayName: "模型",
        protocol: "openai-compatible",
        baseUrl: "https://example.com/v1",
        secretRef: "deployment:model",
        modelId: "model-a",
        supportsImages: false,
        contextWindow: 1_000,
        maxOutputTokens: 1_001,
      }),
    ).toThrow("最大输出 Token 不能超过上下文窗口");
    expect(() =>
      normalizeMemoryProviderConfiguration({
        providerKey: "memory",
        displayName: "记忆",
        providerKind: "mem0",
        baseUrl: "https://api.mem0.ai/",
        apiSecretRef: "unknown" as "deployment:memory-api",
        scopeSecretRef: "deployment:memory-scope",
        requestTimeoutMs: 5_000,
        enabled: true,
      }),
    ).toThrow("记忆 Secret Ref 不受支持");
  });

  it("运行参数与 Worker 压缩不变量保持一致", () => {
    expect(() =>
      normalizeRuntimeSettingsConfiguration({
        compactionSoftLimitPercent: 80,
        compactionTargetPercent: 80,
        compactionRecentUserTokens: 4_096,
        compactionMaxOutputTokens: 1_024,
        compactionTimeoutMs: 60_000,
      }),
    ).toThrow("压缩目标必须低于软上限");
    expect(() =>
      normalizeRuntimeSettingsConfiguration({
        compactionSoftLimitPercent: 80,
        compactionTargetPercent: 55,
        compactionRecentUserTokens: 0,
        compactionMaxOutputTokens: 1_024,
        compactionTimeoutMs: 60_000,
      }),
    ).toThrow("保留用户 Token 超出允许范围");
  });

  it("viewer 不能创建草稿，发布时拒绝超过 active 模型上限的压缩预算", async () => {
    const publish = async () => ({ outcome: "not_found" as const });
    const repository = {
      resolveRole: async () => "viewer" as const,
      listModelProviders: async () => [],
      listMemoryProviders: async () => [],
      listRuntimeSettings: async () => [],
      getActiveRuntimeSettings: async () => undefined,
      generation: async () => 0,
      createModelDraft: async () => ({ outcome: "not_found" as const }),
      createMemoryDraft: async () => ({ outcome: "not_found" as const }),
      createRuntimeSettingsDraft: async () => ({ outcome: "not_found" as const }),
      recordProbe: async () => ({ outcome: "not_found" as const }),
      publish,
      listAudits: async () => [],
    } satisfies AdminControlRepository;
    const service = new AdminControlService(
      repository,
      {
        read: async () => {
          throw new Error("unused");
        },
      },
      { probeModel: async () => undefined, probeMemory: async () => undefined },
      [],
    );
    await expect(
      service.createModelDraft(
        { actorUserId: "viewer", idempotencyKey: "control-key", requestDigest: "a".repeat(64) },
        {
          providerKey: "main",
          displayName: "主模型",
          protocol: "openai-compatible",
          baseUrl: "https://model.example.com/v1",
          secretRef: "deployment:model",
          modelId: "model-a",
          supportsImages: false,
          contextWindow: 128_000,
          maxOutputTokens: 8_192,
          reason: "viewer 不应写入",
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AdminControlServiceError>>({ code: "NOT_AUTHORIZED" }),
    );

    let published = false;
    const adminRepository: AdminControlRepository = {
      ...repository,
      resolveRole: async () => "admin",
      listModelProviders: async () => [
        {
          revision: 1,
          versionToken: 2,
          status: "active",
          probeStatus: "healthy",
          createdBy: "admin",
          createdAt: "2026-08-19T00:00:00.000Z",
          updatedAt: "2026-08-19T00:00:00.000Z",
          configuration: {
            providerKey: "main",
            displayName: "主模型",
            protocol: "openai-compatible",
            baseUrl: "https://model.example.com/v1",
            secretRef: "deployment:model",
            modelId: "model-a",
            supportsImages: false,
            contextWindow: 128_000,
            maxOutputTokens: 1_024,
          },
        },
      ],
      listRuntimeSettings: async () => [
        {
          revision: 1,
          versionToken: 1,
          status: "draft",
          probeStatus: "untested",
          createdBy: "admin",
          createdAt: "2026-08-19T00:00:00.000Z",
          updatedAt: "2026-08-19T00:00:00.000Z",
          configuration: {
            compactionSoftLimitPercent: 80,
            compactionTargetPercent: 55,
            compactionRecentUserTokens: 4_096,
            compactionMaxOutputTokens: 2_048,
            compactionTimeoutMs: 60_000,
          },
        },
      ],
      publish: async () => {
        published = true;
        return { outcome: "not_found" };
      },
    };
    const adminService = new AdminControlService(
      adminRepository,
      {
        read: async () => {
          throw new Error("unused");
        },
      },
      { probeModel: async () => undefined, probeMemory: async () => undefined },
      [],
    );
    await expect(
      adminService.publish(
        { actorUserId: "admin", idempotencyKey: "control-key", requestDigest: "b".repeat(64) },
        {
          kind: "runtime_settings",
          objectKey: "global",
          revision: 1,
          command: { expectedVersionToken: 1, reason: "测试跨配置预算" },
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AdminControlServiceError>>({ code: "CONFLICT" }),
    );
    expect(published).toBe(false);
  });

  it("Provider 探针幂等重放以首次持久化结果为准", async () => {
    const revision = {
      revision: 1,
      versionToken: 2,
      status: "draft" as const,
      probeStatus: "failed" as const,
      createdBy: "admin",
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:01:00.000Z",
      configuration: {
        providerKey: "main",
        displayName: "主模型",
        protocol: "openai-compatible" as const,
        baseUrl: "https://model.example.com/v1",
        secretRef: "deployment:model" as const,
        modelId: "model-a",
        supportsImages: false,
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
      },
    };
    const repository = {
      resolveRole: async () => "operator" as const,
      listModelProviders: async () => [],
      listMemoryProviders: async () => [],
      listRuntimeSettings: async () => [],
      getActiveRuntimeSettings: async () => undefined,
      generation: async () => 0,
      createModelDraft: async () => ({ outcome: "not_found" as const }),
      createMemoryDraft: async () => ({ outcome: "not_found" as const }),
      createRuntimeSettingsDraft: async () => ({ outcome: "not_found" as const }),
      recordProbe: async () => ({ outcome: "replayed" as const, value: revision }),
      publish: async () => ({ outcome: "not_found" as const }),
      listAudits: async () => [],
    } satisfies AdminControlRepository;
    const service = new AdminControlService(
      repository,
      { read: async () => Promise.reject(new Error("unused")) },
      { probeModel: async () => undefined, probeMemory: async () => undefined },
      [],
    );

    await expect(
      service.probe(
        { actorUserId: "admin", idempotencyKey: "control-probe", requestDigest: "a".repeat(64) },
        {
          kind: "model_provider",
          revision: { ...revision, versionToken: 1, probeStatus: "untested" },
          expectedVersionToken: 1,
          reason: "重复探测",
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AdminControlServiceError>>({ code: "PROBE_FAILED" }),
    );
  });
});

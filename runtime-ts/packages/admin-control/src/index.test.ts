import { describe, expect, it, vi } from "vitest";
import {
  AdminControlService,
  type AdminControlServiceError,
  type AdminControlRepository,
  type ModelProviderConfiguration,
  normalizeMemoryProviderConfiguration,
  normalizeModelProviderConfiguration,
  normalizeRuntimeSettingsConfiguration,
  normalizeStoredMemoryProviderConfiguration,
  normalizeStoredModelProviderConfiguration,
} from "./index.js";

function modelConfiguration(
  overrides: Partial<ModelProviderConfiguration> = {},
): ModelProviderConfiguration {
  return {
    providerKey: "main",
    displayName: "主模型",
    protocol: "openai-compatible",
    baseUrl: "https://model.example.com/v1",
    credentialConfigured: true,
    defaultModelId: "model-a",
    models: [
      {
        id: "model-a",
        name: "Model A",
        enabled: true,
        reasoning: false,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
    ...overrides,
  };
}

function firstModelConfiguration(): ModelProviderConfiguration["models"][number] {
  const model = modelConfiguration().models[0];
  if (model === undefined) throw new Error("模型测试夹具缺失");
  return model;
}

describe("后台控制面领域规则", () => {
  it("规范化 OpenAI-compatible 模型配置并拒绝凭据 URL", () => {
    expect(
      normalizeModelProviderConfiguration({
        ...modelConfiguration(),
        providerKey: " Main-Model ",
        displayName: " 主模型 ",
        baseUrl: "https://model.example.com/v1#fragment",
        models: [
          ...modelConfiguration().models,
          {
            id: "model-b",
            name: "Model B",
            enabled: true,
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 256_000,
            maxTokens: 16_384,
          },
        ],
      }),
    ).toMatchObject({
      providerKey: "main-model",
      baseUrl: "https://model.example.com/v1",
      defaultModelId: "model-a",
      models: [{ id: "model-a" }, { id: "model-b", reasoning: true }],
    });
    expect(() =>
      normalizeModelProviderConfiguration({
        ...modelConfiguration(),
        baseUrl: "https://user:secret@example.com/v1",
      }),
    ).toThrow("Provider 地址必须是无凭据 HTTPS URL");
    expect(() =>
      normalizeModelProviderConfiguration({
        ...modelConfiguration(),
        providerKey: `sk-${"a".repeat(32)}`,
      }),
    ).toThrow("Provider 内部标识疑似包含 API Key");
  });

  it("持久化读取允许历史异常标识进入脱敏投影，写入入口仍拒绝", () => {
    const historicalProviderKey = `sk-${"a".repeat(32)}`;
    expect(
      normalizeStoredModelProviderConfiguration({
        ...modelConfiguration(),
        providerKey: historicalProviderKey,
      }).providerKey,
    ).toBe(historicalProviderKey);
    expect(
      normalizeStoredMemoryProviderConfiguration({
        providerKey: historicalProviderKey,
        displayName: "记忆",
        providerKind: "mem0",
        baseUrl: "https://api.mem0.ai/",
        apiSecretRef: "deployment:memory-api",
        scopeSecretRef: "deployment:memory-scope",
        requestTimeoutMs: 5_000,
        enabled: true,
      }).providerKey,
    ).toBe(historicalProviderKey);
    expect(() =>
      normalizeModelProviderConfiguration({
        ...modelConfiguration(),
        providerKey: historicalProviderKey,
      }),
    ).toThrow("Provider 内部标识疑似包含 API Key");
  });

  it("拒绝无启用模型、未启用默认模型、重复 ID 和超出窗口的输出预算", () => {
    expect(() =>
      normalizeModelProviderConfiguration({
        ...modelConfiguration(),
        models: modelConfiguration().models.map((model) => ({ ...model, enabled: false })),
      }),
    ).toThrow("至少需要启用一个模型");
    expect(() =>
      normalizeModelProviderConfiguration({
        ...modelConfiguration(),
        defaultModelId: "model-disabled",
        models: [
          ...modelConfiguration().models,
          {
            ...firstModelConfiguration(),
            id: "model-disabled",
            enabled: false,
          },
        ],
      }),
    ).toThrow("默认模型必须引用已启用模型");
    expect(() =>
      normalizeModelProviderConfiguration({
        ...modelConfiguration(),
        models: [...modelConfiguration().models, firstModelConfiguration()],
      }),
    ).toThrow("Provider 内模型 ID 不能重复");
    expect(() =>
      normalizeModelProviderConfiguration({
        ...modelConfiguration(),
        models: [{ ...firstModelConfiguration(), contextWindow: 1_000, maxTokens: 1_001 }],
      }),
    ).toThrow("最大输出 Token 不能超过上下文窗口");
  });

  it("拒绝未知记忆秘密引用", () => {
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

  it("读取投影会遮蔽历史上误填到 Provider 标识的疑似密钥", async () => {
    const secretLikeIdentifier = `sk-${"a".repeat(32)}`;
    const modelRevision = {
      revision: 1,
      versionToken: 2,
      status: "draft" as const,
      probeStatus: "failed" as const,
      createdBy: "admin",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:01:00.000Z",
      configuration: modelConfiguration({ providerKey: secretLikeIdentifier }),
    };
    const repository = {
      resolveRole: async () => "viewer" as const,
      resolveModelCredential: async () => "test-model-key",
      listModelProviders: async () => [modelRevision],
      listMemoryProviders: async () => [],
      listRuntimeSettings: async () => [],
      getActiveRuntimeSettings: async () => undefined,
      generation: async () => 0,
      createModelDraft: async () => ({ outcome: "not_found" as const }),
      createMemoryDraft: async () => ({ outcome: "not_found" as const }),
      createRuntimeSettingsDraft: async () => ({ outcome: "not_found" as const }),
      recordProbe: async () => ({ outcome: "not_found" as const }),
      publish: async () => ({ outcome: "not_found" as const }),
      listAudits: async () => [
        {
          auditId: "audit_sensitive_provider",
          actorUserId: "admin",
          objectKind: "model_provider" as const,
          objectKey: secretLikeIdentifier,
          revision: 1,
          action: "create_draft" as const,
          reason: "历史误填",
          outcome: "succeeded" as const,
          createdAt: "2026-08-25T00:00:00.000Z",
        },
      ],
      listUsers: async () => ({ items: [], total: 0 }),
      updateUserStatus: async () => ({ outcome: "not_found" as const }),
    } satisfies AdminControlRepository;
    const service = new AdminControlService(
      repository,
      { read: async () => Promise.reject(new Error("unused")) },
      { probeModel: async () => undefined, probeMemory: async () => undefined },
      [],
    );

    const [models, audits] = await Promise.all([
      service.listModelProviders("viewer"),
      service.listAudits("viewer"),
    ]);
    expect(models[0]?.configuration.providerKey).toBe("sensitive-identifier-redacted");
    expect(audits[0]?.objectKey).toBe("sensitive-identifier-redacted");
    expect(JSON.stringify({ models, audits })).not.toContain(secretLikeIdentifier);
  });

  it("viewer 不能创建草稿，发布时拒绝超过 active 模型上限的压缩预算", async () => {
    const publish = async () => ({ outcome: "not_found" as const });
    const repository = {
      resolveRole: async () => "viewer" as const,
      resolveModelCredential: async () => "test-model-key",
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
      listUsers: async () => ({ items: [], total: 0 }),
      updateUserStatus: async () => ({ outcome: "not_found" as const }),
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
          ...modelConfiguration(),
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
          configuration: modelConfiguration({
            models: [{ ...firstModelConfiguration(), maxTokens: 1_024 }],
          }),
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
      configuration: modelConfiguration(),
    };
    const repository = {
      resolveRole: async () => "operator" as const,
      resolveModelCredential: async () => "test-model-key",
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
      listUsers: async () => ({ items: [], total: 0 }),
      updateUserStatus: async () => ({ outcome: "not_found" as const }),
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

  it.each(["untested", "failed"] as const)(
    "模型 Provider 无需探测即可启用（%s）",
    async (probeStatus) => {
      const revision = {
        revision: 1,
        versionToken: 2,
        status: "draft" as const,
        probeStatus,
        createdBy: "admin",
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:01:00.000Z",
        configuration: modelConfiguration(),
      };
      const publish = vi.fn(async () => ({ outcome: "applied" as const, value: revision }));
      const repository = {
        resolveRole: async () => "admin" as const,
        resolveModelCredential: async () => "test-model-key",
        listModelProviders: async () => [revision],
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
        listUsers: async () => ({ items: [], total: 0 }),
        updateUserStatus: async () => ({ outcome: "not_found" as const }),
      } satisfies AdminControlRepository;
      const service = new AdminControlService(
        repository,
        { read: async () => Promise.reject(new Error("unused")) },
        { probeModel: async () => undefined, probeMemory: async () => undefined },
        [],
      );

      await expect(
        service.publish(
          { actorUserId: "admin", idempotencyKey: "publish-model", requestDigest: "e".repeat(64) },
          {
            kind: "model_provider",
            objectKey: "main",
            revision: 1,
            command: { expectedVersionToken: 2, reason: "保存后直接启用" },
          },
        ),
      ).resolves.toBe(revision);
      expect(publish).toHaveBeenCalledOnce();
    },
  );

  it("未探测的记忆 Provider 仍禁止启用", async () => {
    const repository = {
      resolveRole: async () => "admin" as const,
      resolveModelCredential: async () => "test-model-key",
      listModelProviders: async () => [],
      listMemoryProviders: async () => [],
      listRuntimeSettings: async () => [],
      getActiveRuntimeSettings: async () => undefined,
      generation: async () => 0,
      createModelDraft: async () => ({ outcome: "not_found" as const }),
      createMemoryDraft: async () => ({ outcome: "not_found" as const }),
      createRuntimeSettingsDraft: async () => ({ outcome: "not_found" as const }),
      recordProbe: async () => ({ outcome: "not_found" as const }),
      publish: async () => ({ outcome: "not_found" as const }),
      listAudits: async () => [],
      listUsers: async () => ({ items: [], total: 0 }),
      updateUserStatus: async () => ({ outcome: "not_found" as const }),
    } satisfies AdminControlRepository;
    const memoryPublish = vi.fn(async () => ({ outcome: "not_found" as const }));
    const memoryRepository = {
      ...repository,
      listMemoryProviders: async () => [
        {
          revision: 1,
          versionToken: 3,
          status: "draft" as const,
          probeStatus: "untested" as const,
          createdBy: "admin",
          createdAt: "2026-08-25T00:00:00.000Z",
          updatedAt: "2026-08-25T00:01:00.000Z",
          configuration: {
            providerKey: "memory",
            displayName: "Mem0",
            providerKind: "mem0" as const,
            baseUrl: "https://api.mem0.ai/",
            apiSecretRef: "deployment:memory-api" as const,
            scopeSecretRef: "deployment:memory-scope" as const,
            requestTimeoutMs: 10_000,
            enabled: true,
          },
        },
      ],
      publish: memoryPublish,
    } satisfies AdminControlRepository;
    const memoryService = new AdminControlService(
      memoryRepository,
      { read: async () => Promise.reject(new Error("unused")) },
      { probeModel: async () => undefined, probeMemory: async () => undefined },
      [],
    );
    await expect(
      memoryService.publish(
        {
          actorUserId: "admin",
          idempotencyKey: "publish-memory",
          requestDigest: "1".repeat(64),
        },
        {
          kind: "memory_provider",
          objectKey: "memory",
          revision: 1,
          command: { expectedVersionToken: 3, reason: "启用未探测记忆" },
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AdminControlServiceError>>({ code: "CONFLICT" }),
    );
    expect(memoryPublish).not.toHaveBeenCalled();
  });

  it("只有管理员可读取用户目录，并禁止管理员停用自己", async () => {
    const user = {
      userId: "user_customer",
      email: "customer@example.com",
      displayName: "测试用户",
      status: "disabled" as const,
      createdAt: "2026-08-20T00:00:00.000Z",
      activeSessions: 0,
      conversationCount: 2,
      runCount: 4,
    };
    const updateUserStatus = vi.fn(async () => ({ outcome: "applied" as const, value: user }));
    const repository: AdminControlRepository = {
      resolveRole: async () => "admin",
      resolveModelCredential: async () => "test-model-key",
      listModelProviders: async () => [],
      listMemoryProviders: async () => [],
      listRuntimeSettings: async () => [],
      getActiveRuntimeSettings: async () => undefined,
      generation: async () => 0,
      createModelDraft: async () => ({ outcome: "not_found" }),
      createMemoryDraft: async () => ({ outcome: "not_found" }),
      createRuntimeSettingsDraft: async () => ({ outcome: "not_found" }),
      recordProbe: async () => ({ outcome: "not_found" }),
      publish: async () => ({ outcome: "not_found" }),
      listAudits: async () => [],
      listUsers: async () => ({ items: [user], total: 1 }),
      updateUserStatus,
    };
    const service = new AdminControlService(
      repository,
      { read: async () => Promise.reject(new Error("unused")) },
      { probeModel: async () => undefined, probeMemory: async () => undefined },
      [],
    );

    await expect(service.listUsers("user_admin", "customer", 20)).resolves.toEqual({
      items: [user],
      total: 1,
    });
    await expect(
      service.updateUserStatus(
        { actorUserId: "user_admin", idempotencyKey: "user-status", requestDigest: "c".repeat(64) },
        { targetUserId: "user_customer", status: "disabled", reason: "风险处置" },
      ),
    ).resolves.toEqual(user);
    expect(updateUserStatus).toHaveBeenCalledWith(
      expect.objectContaining({ targetUserId: "user_customer", reason: "风险处置" }),
    );
    await expect(
      service.updateUserStatus(
        { actorUserId: "user_admin", idempotencyKey: "self-status", requestDigest: "d".repeat(64) },
        { targetUserId: "user_admin", status: "disabled", reason: "误操作" },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AdminControlServiceError>>({ code: "CONFLICT" }),
    );
  });
});

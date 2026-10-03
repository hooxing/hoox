import { describe, expect, it, vi } from "vitest";
import {
  type AdminControlRepository,
  AdminControlService,
  type ControlOperatorRole,
} from "./index.js";

const context = {
  actorUserId: "admin",
  idempotencyKey: "save-config-0001",
  requestDigest: "a".repeat(64),
};
const model = {
  providerKey: "main",
  displayName: "主模型",
  protocol: "openai-compatible" as const,
  baseUrl: "https://model.example.invalid/v1",
  defaultModelId: "model-a",
  models: [
    {
      id: "model-a",
      name: "模型",
      enabled: true,
      reasoning: false,
      input: ["text" as const],
      contextWindow: 128000,
      maxTokens: 8192,
    },
  ],
};
const memory = {
  providerKey: "mem0",
  displayName: "长期记忆",
  providerKind: "mem0" as const,
  baseUrl: "https://memory.example.invalid/",
  apiSecretRef: "deployment:memory-api" as const,
  scopeSecretRef: "deployment:memory-scope" as const,
  requestTimeoutMs: 10000,
  enabled: false,
};

function fixture(role: ControlOperatorRole = "admin") {
  const repository = {
    resolveRole: vi.fn(async () => role),
    listModelProviders: vi.fn(async () => [{ status: "active", configuration: model }]),
    saveModelConfiguration: vi.fn(async () => ({
      outcome: "applied",
      value: { status: "active" },
    })),
    saveMemoryConfiguration: vi.fn(async () => ({
      outcome: "applied",
      value: { status: "active" },
    })),
    updateUserStatus: vi.fn(async () => ({ outcome: "applied", value: { status: "disabled" } })),
    saveRuntimeSettingsConfiguration: vi.fn(async () => ({
      outcome: "applied",
      value: { status: "active" },
    })),
  };
  const probes = { probeModel: vi.fn(), probeMemory: vi.fn() };
  return {
    repository,
    probes,
    service: new AdminControlService(
      repository as unknown as AdminControlRepository,
      { read: vi.fn() },
      probes,
      [],
    ),
  };
}

describe("管理员直接保存", () => {
  it("运行设置一次保存，不要求模型接入、原因或审批，并检查字段关系", async () => {
    const { service, repository } = fixture();
    const command = {
      workerMaxConcurrentRuns: 20,
      userMaxConcurrentRunsPerTenant: 2,
      compactionSoftLimitPercent: 80,
      compactionTargetPercent: 55,
      compactionRecentUserTokens: 4096,
      compactionMaxOutputTokens: 4096,
      compactionTimeoutMs: 60000,
      expectedGeneration: 0,
    };
    await expect(service.saveRuntimeSettingsConfiguration(context, command)).resolves.toEqual({
      status: "active",
    });
    expect(repository.listModelProviders).not.toHaveBeenCalled();
    expect(repository.saveRuntimeSettingsConfiguration).toHaveBeenCalledWith({
      ...context,
      command: { ...command, toolCallingMode: "native", reason: "保存并使用运行设置" },
    });
    await expect(
      service.saveRuntimeSettingsConfiguration(context, {
        ...command,
        compactionTargetPercent: 80,
      }),
    ).rejects.toThrow("压缩目标必须低于软上限");
    for (const role of ["operator", "viewer"] as const) {
      await expect(
        fixture(role).service.saveRuntimeSettingsConfiguration(context, command),
      ).rejects.toThrow();
    }
  });
  it.each(["viewer", "operator"] as const)("%s 不能通过保存接口直接激活配置", async (role) => {
    const { repository, service } = fixture(role);
    await expect(
      service.saveModelConfiguration(context, {
        ...model,
        apiKey: "unit-api-key",
        expectedGeneration: 0,
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    await expect(
      service.saveMemoryConfiguration(context, { ...memory, expectedGeneration: 0 }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(repository.saveModelConfiguration).not.toHaveBeenCalled();
    expect(repository.saveMemoryConfiguration).not.toHaveBeenCalled();
  });

  it("模型保存自动记录动作且保留凭据和配置合法性校验", async () => {
    const { repository, service, probes } = fixture();
    await expect(
      service.saveModelConfiguration(context, {
        ...model,
        apiKey: "unit-api-key",
        expectedGeneration: 0,
      }),
    ).resolves.toEqual({ status: "active" });
    expect(repository.saveModelConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ expectedGeneration: 0, reason: "保存并使用模型配置" }),
      }),
    );
    expect(probes.probeModel).not.toHaveBeenCalled();
    await expect(
      service.saveModelConfiguration(context, { ...model, expectedGeneration: 0 }),
    ).rejects.toThrow("必须输入新模型密钥");
    await expect(
      service.saveModelConfiguration(context, {
        ...model,
        apiKey: "unit-api-key",
        expectedGeneration: -1,
      }),
    ).rejects.toThrow("配置更新状态");
    expect(repository.saveModelConfiguration).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("记忆 enabled=%s 无需填写原因或探测，保存自动生效", async (enabled) => {
    const { repository, service, probes } = fixture();
    await service.saveMemoryConfiguration(context, { ...memory, enabled, expectedGeneration: 1 });
    expect(repository.saveMemoryConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ enabled, reason: "保存长期记忆设置" }),
      }),
    );
    expect(probes.probeMemory).not.toHaveBeenCalled();
  });

  it("未接入后台模型时也能独立保存记忆密钥", async () => {
    const { repository, service } = fixture();
    repository.listModelProviders.mockResolvedValueOnce([]);
    await expect(
      service.saveMemoryConfiguration(context, {
        ...memory,
        expectedGeneration: 0,
        apiSecretRef: "managed:memory-api",
        scopeSecretRef: "platform:memory-scope",
        apiKey: "unit-memory-key",
      }),
    ).resolves.toEqual({ status: "active" });
    expect(repository.saveMemoryConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.objectContaining({ apiKey: "unit-memory-key" }) }),
    );
    expect(repository.listModelProviders).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { apiKey: "" },
    { apiKey: "line\nbreak" },
    { apiKey: "key", reuseCredentialFromRevision: 1 },
    { reuseCredentialFromRevision: 0 },
  ])("拒绝无效托管记忆凭据 %#", async (credentials) => {
    const { service, repository } = fixture();
    await expect(
      service.saveMemoryConfiguration(context, {
        ...memory,
        apiSecretRef: "managed:memory-api",
        expectedGeneration: 0,
        ...credentials,
      }),
    ).rejects.toThrow();
    expect(repository.saveMemoryConfiguration).not.toHaveBeenCalled();
  });

  it("用户状态变更自动记录动作，仍禁止停用自己", async () => {
    const { repository, service } = fixture();
    await service.updateUserStatus(context, { targetUserId: "customer", status: "disabled" });
    expect(repository.updateUserStatus).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "管理员停用用户" }),
    );
    await expect(
      service.updateUserStatus(context, { targetUserId: "admin", status: "disabled" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(repository.updateUserStatus).toHaveBeenCalledTimes(1);
  });
});

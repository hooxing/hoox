import { describe, expect, it, vi } from "vitest";
import {
  type AdminControlRepository,
  AdminControlService,
  type ControlOperatorRole,
  type ControlRevision,
  normalizeRuntimeSettingsConfiguration,
  type RuntimeSettingsConfiguration,
} from "./index.js";

const configuration: RuntimeSettingsConfiguration = {
  workerMaxConcurrentRuns: 20,
  userMaxConcurrentRunsPerTenant: 2,
  compactionSoftLimitPercent: 80,
  compactionTargetPercent: 55,
  compactionRecentUserTokens: 4096,
  compactionMaxOutputTokens: 4096,
  compactionTimeoutMs: 60000,
};
const context = {
  actorUserId: "admin",
  idempotencyKey: "runtime-mode-0001",
  requestDigest: "a".repeat(64),
};

function fixture(role: ControlOperatorRole = "admin") {
  let revision: ControlRevision<RuntimeSettingsConfiguration> = {
    revision: 1,
    versionToken: 1,
    status: "active",
    configuration,
    probeStatus: "untested",
    createdBy: "admin",
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
  };
  const repository = {
    resolveRole: vi.fn(async () => role),
    generation: vi.fn(async () => revision.revision),
    listModelProviders: vi.fn(async () => []),
    listMemoryProviders: vi.fn(async () => []),
    getActiveRuntimeSettings: vi.fn(async () => revision),
    listRuntimeSettings: vi.fn(async () => [revision]),
    saveRuntimeSettingsConfiguration: vi.fn(
      async (input: Parameters<AdminControlRepository["saveRuntimeSettingsConfiguration"]>[0]) => {
        const { expectedGeneration: _generation, reason: _reason, ...settings } = input.command;
        revision = { ...revision, revision: revision.revision + 1, configuration: settings };
        return { outcome: "applied" as const, value: revision };
      },
    ),
    createRuntimeSettingsDraft: vi.fn(
      async (input: Parameters<AdminControlRepository["createRuntimeSettingsDraft"]>[0]) => {
        const { reason: _reason, ...settings } = input.command;
        revision = { ...revision, status: "draft", configuration: settings };
        return { outcome: "applied" as const, value: revision };
      },
    ),
    publish: vi.fn(async () => ({ outcome: "applied" as const, value: revision })),
  };
  const service = new AdminControlService(
    repository as unknown as AdminControlRepository,
    { read: vi.fn() },
    { probeModel: vi.fn(), probeMemory: vi.fn() },
    [],
  );
  return { repository, service };
}

describe("运行设置工具调用模式", () => {
  it.each(["native", "ptc", undefined] as const)("规范化模式 %s，旧配置实际默认 native", (mode) => {
    const input = { ...configuration, ...(mode === undefined ? {} : { toolCallingMode: mode }) };
    const normalized = normalizeRuntimeSettingsConfiguration(input);
    expect(normalized).toEqual({ ...configuration, toolCallingMode: mode ?? "native" });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(input).toEqual({
      ...configuration,
      ...(mode === undefined ? {} : { toolCallingMode: mode }),
    });
  });

  it.each([null, "", "PTC", "auto", 1, false])("拒绝非法模式 %s，不静默回退", (mode) => {
    expect(() =>
      normalizeRuntimeSettingsConfiguration({
        ...configuration,
        toolCallingMode: mode,
      } as unknown as RuntimeSettingsConfiguration),
    ).toThrow("工具调用模式必须为 native 或 ptc");
  });

  it("旧修订读取补充 native，但不改写已存配置", async () => {
    const { repository, service } = fixture();
    const overview = await service.overview("admin");
    const revisions = await service.listRuntimeSettings("admin");
    expect(overview.activeRuntimeSettings?.configuration.toolCallingMode).toBe("native");
    expect(revisions[0]?.configuration.toolCallingMode).toBe("native");
    expect((await repository.getActiveRuntimeSettings()).configuration).not.toHaveProperty(
      "toolCallingMode",
    );
    expect(repository.saveRuntimeSettingsConfiguration).not.toHaveBeenCalled();
  });

  it("正常与 PTC 往返使用既有保存修订链路，读回保持选定模式", async () => {
    const { repository, service } = fixture();
    for (const [index, toolCallingMode] of (["native", "ptc", "native"] as const).entries()) {
      const command = { ...configuration, toolCallingMode, expectedGeneration: index + 1 };
      const saved = await service.saveRuntimeSettingsConfiguration(context, command);
      expect(saved.configuration.toolCallingMode).toBe(toolCallingMode);
      expect(repository.saveRuntimeSettingsConfiguration).toHaveBeenLastCalledWith({
        ...context,
        command: { ...command, reason: "保存并使用运行设置" },
      });
      expect(
        (await service.overview("admin")).activeRuntimeSettings?.configuration.toolCallingMode,
      ).toBe(toolCallingMode);
      expect((await service.listRuntimeSettings("admin"))[0]?.configuration.toolCallingMode).toBe(
        toolCallingMode,
      );
    }
    expect(repository.createRuntimeSettingsDraft).not.toHaveBeenCalled();
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it("非法模式在进入保存仓储前被拒绝", async () => {
    const { repository, service } = fixture();
    await expect(
      service.saveRuntimeSettingsConfiguration(context, {
        ...configuration,
        expectedGeneration: 1,
        toolCallingMode: "auto",
      } as unknown as Parameters<AdminControlService["saveRuntimeSettingsConfiguration"]>[1]),
    ).rejects.toThrow("工具调用模式");
    expect(repository.saveRuntimeSettingsConfiguration).not.toHaveBeenCalled();
  });

  it.each(["viewer", "operator"] as const)("%s 不能借 PTC 模式绕过保存或发布权限", async (role) => {
    const { repository, service } = fixture(role);
    await expect(
      service.saveRuntimeSettingsConfiguration(context, {
        ...configuration,
        toolCallingMode: "ptc",
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    await expect(
      service.publish(context, {
        kind: "runtime_settings",
        objectKey: "global",
        revision: 1,
        command: { expectedVersionToken: 1, reason: "发布工具调用模式" },
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(repository.saveRuntimeSettingsConfiguration).not.toHaveBeenCalled();
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it("PTC 草稿保留模式并沿用现有发布修订流程", async () => {
    const { repository, service } = fixture();
    const draft = await service.createRuntimeSettingsDraft(context, {
      ...configuration,
      toolCallingMode: "ptc",
      reason: "测试工具调用模式",
    });
    expect(draft.configuration.toolCallingMode).toBe("ptc");
    const published = await service.publish(context, {
      kind: "runtime_settings",
      objectKey: "global",
      revision: draft.revision,
      command: { expectedVersionToken: draft.versionToken, reason: "发布工具调用模式" },
    });
    expect(published.configuration).toHaveProperty("toolCallingMode", "ptc");
    expect(repository.publish).toHaveBeenCalledWith({
      ...context,
      kind: "runtime_settings",
      objectKey: "global",
      revision: draft.revision,
      expectedVersionToken: draft.versionToken,
      reason: "发布工具调用模式",
    });
  });
});

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ModelProviderCredentialCipher } from "./model-provider-credential.js";
import { PgAdminControlRepository } from "./pg-admin-control.js";

const input = {
  actorUserId: "admin",
  idempotencyKey: "save-model-0001",
  requestDigest: "a".repeat(64),
  command: {
    providerKey: "main",
    displayName: "主模型",
    protocol: "openai-compatible" as const,
    baseUrl: "https://model.example.invalid/v1",
    apiKey: "unit-provider-key",
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
    expectedGeneration: 4,
    reason: "保存并使用模型配置",
  },
};

function fixture(
  options: { role?: string; generation?: number; activationFailure?: boolean } = {},
) {
  const statements: string[] = [];
  const client = {
    release: vi.fn(),
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes("SELECT role FROM platform_control_operators"))
        return { rows: [{ role: options.role ?? "admin" }], rowCount: 1 };
      if (sql.includes("SELECT generation::text"))
        return { rows: [{ generation: String(options.generation ?? 4) }], rowCount: 1 };
      if (sql.includes("max(revision)")) return { rows: [{ revision: "1" }], rowCount: 1 };
      if (options.activationFailure && sql.includes("INSERT INTO admin_control_activation_events"))
        throw new Error("injected activation failure");
      return { rows: [], rowCount: 0 };
    }),
  };
  const repository = new PgAdminControlRepository(
    { connect: async () => client } as unknown as Pool,
    new ModelProviderCredentialCipher("unit-encryption-root-at-least-32-bytes"),
  );
  return { repository, statements, client };
}

describe("配置保存的事务边界", () => {
  it("运行设置激活失败整笔回滚，不依赖后台模型", async () => {
    const { repository, statements } = fixture({ activationFailure: true });
    await expect(
      repository.saveRuntimeSettingsConfiguration({
        ...input,
        command: {
          expectedGeneration: 4,
          reason: "保存并使用运行设置",
          workerMaxConcurrentRuns: 20,
          userMaxConcurrentRunsPerTenant: 2,
          compactionSoftLimitPercent: 80,
          compactionTargetPercent: 55,
          compactionRecentUserTokens: 4096,
          compactionMaxOutputTokens: 4096,
          compactionTimeoutMs: 60000,
        },
      }),
    ).rejects.toThrow();
    expect(statements.some((sql) => sql.includes("INSERT INTO admin_control_active_configs"))).toBe(
      true,
    );
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });
  it("激活事件写入失败时回滚配置和当前指针，不遗留半完成保存", async () => {
    const { repository, statements, client } = fixture({ activationFailure: true });
    await expect(repository.saveModelConfiguration(input)).rejects.toThrow();
    expect(
      statements.some((sql) => sql.includes("INSERT INTO admin_control_config_revisions")),
    ).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO admin_control_active_configs"))).toBe(
      true,
    );
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("并发状态过期时不创建新配置", async () => {
    const { repository, statements } = fixture({ generation: 5 });
    await expect(repository.saveModelConfiguration(input)).resolves.toEqual({
      outcome: "conflict",
    });
    expect(statements.some((sql) => sql.includes("INSERT INTO"))).toBe(false);
  });

  it("持久化层同样拒绝非管理员直接激活", async () => {
    const { repository, statements } = fixture({ role: "operator" });
    await expect(repository.saveModelConfiguration(input)).resolves.toEqual({
      outcome: "not_authorized",
    });
    expect(statements.some((sql) => sql.includes("INSERT INTO"))).toBe(false);
  });
});

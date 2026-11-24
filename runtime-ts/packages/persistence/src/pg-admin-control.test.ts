import { AdminControlService } from "@hoox/admin-control";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ModelProviderCredentialCipher } from "./model-provider-credential.js";
import {
  PgAdminControlRepository,
  PgRuntimeControlConfigurationRepository,
} from "./pg-admin-control.js";

describe("PostgreSQL 后台控制面读取投影", () => {
  it("Worker 可直接读取当前已发布的运行并发设置", async () => {
    const query = vi.fn(async (_sql: string) => ({
      rows: [
        {
          configuration: {
            workerMaxConcurrentRuns: 20,
            userMaxConcurrentRunsPerTenant: 2,
            compactionSoftLimitPercent: 80,
            compactionTargetPercent: 60,
            compactionRecentUserTokens: 16_000,
            compactionMaxOutputTokens: 4_096,
            compactionTimeoutMs: 60_000,
          },
        },
      ],
    }));
    const repository = new PgRuntimeControlConfigurationRepository(
      { query } as unknown as Pool,
      new ModelProviderCredentialCipher("unit-model-credential-root-at-least-32-bytes"),
    );

    await expect(repository.resolveActiveRuntimeSettings()).resolves.toMatchObject({
      workerMaxConcurrentRuns: 20,
      userMaxConcurrentRunsPerTenant: 2,
    });
    expect(query.mock.calls[0]?.[0]).toContain("active.object_kind='runtime_settings'");
  });

  it("历史异常 Provider 标识先完成持久化读取，再由控制服务脱敏", async () => {
    const historicalProviderKey = `sk-${"a".repeat(32)}`;
    const statements: string[] = [];
    const release = vi.fn();
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("SELECT operator.role FROM platform_control_operators")) {
          return { rows: [{ role: "viewer" }] };
        }
        if (sql.includes("FROM admin_control_config_revisions revision")) {
          return {
            rows: [
              {
                object_kind: "model_provider",
                object_key: historicalProviderKey,
                revision: "1",
                configuration: {
                  providerKey: historicalProviderKey,
                  displayName: "历史测试模型",
                  protocol: "openai-compatible",
                  baseUrl: "https://model.example.invalid/v1",
                  secretRef: "deployment:model",
                  defaultModelId: "model-history",
                  models: [
                    {
                      id: "model-history",
                      name: "Model History",
                      enabled: true,
                      reasoning: false,
                      input: ["text"],
                      contextWindow: 128_000,
                      maxTokens: 8_192,
                    },
                  ],
                },
                created_by: "viewer",
                created_at: "2026-08-25T00:00:00.000Z",
                version_token: "1",
                projection_status: "active",
                probe_status: "healthy",
                updated_at: "2026-08-25T00:01:00.000Z",
                activated_at: "2026-08-25T00:01:00.000Z",
              },
            ],
          };
        }
        return { rows: [] };
      },
      release,
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const repository = new PgAdminControlRepository(
      pool,
      new ModelProviderCredentialCipher("unit-model-credential-root-at-least-32-bytes"),
    );
    const service = new AdminControlService(
      repository,
      repository,
      { probeModel: async () => undefined, probeMemory: async () => undefined },
      [],
    );

    const revisions = await service.listModelProviders("viewer");

    expect(revisions[0]?.configuration.providerKey).toBe("sensitive-identifier-redacted");
    expect(JSON.stringify(revisions)).not.toContain(historicalProviderKey);
    expect(
      statements.some((sql) => sql.includes("FROM admin_control_config_revisions revision")),
    ).toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
  });
});

describe("后台标题模型凭据解析", () => {
  const cipher = new ModelProviderCredentialCipher("unit-title-credential-root-at-least-32-bytes");
  const title = {
    enabled: true,
    providerKey: "title-provider",
    providerRevision: 7,
    modelId: "cheap",
  };
  const settings = {
    workerMaxConcurrentRuns: 20,
    userMaxConcurrentRunsPerTenant: 2,
    compactionSoftLimitPercent: 80,
    compactionTargetPercent: 55,
    compactionRecentUserTokens: 4096,
    compactionMaxOutputTokens: 4096,
    compactionTimeoutMs: 60000,
  };
  const model = {
    providerKey: "title-provider",
    displayName: "标题供应商",
    protocol: "openai-compatible",
    baseUrl: "https://title.example.invalid/v1",
    credential: cipher.encrypt("title-provider", "unit-title-provider-key"),
    defaultModelId: "cheap",
    models: [
      {
        id: "cheap",
        name: "标题",
        enabled: true,
        reasoning: false,
        input: ["text"],
        contextWindow: 4096,
        maxTokens: 64,
      },
    ],
  };
  it("精确读取选定修订并复用其密钥，输出预算不超过模型上限", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: [
        {
          configuration: sql.includes("JOIN admin_control_config_revisions")
            ? { ...settings, titleGeneration: title }
            : model,
        },
      ],
    }));
    const repository = new PgRuntimeControlConfigurationRepository(
      { query } as unknown as Pool,
      cipher,
      "unit-main-model-key",
    );
    const result = await repository.resolveTitleModelConfiguration();
    expect(result).toEqual({
      baseUrl: model.baseUrl,
      apiKey: "unit-title-provider-key",
      modelId: "cheap",
      maximumOutputTokens: 64,
    });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("revision=$2"), [
      "title-provider",
      7,
    ]);
  });
  it.each([undefined, { enabled: false }])(
    "未接管与显式关闭返回不同结果：%j",
    async (titleGeneration) => {
      const query = vi.fn(async () => ({
        rows: [
          {
            configuration: {
              ...settings,
              ...(titleGeneration === undefined ? {} : { titleGeneration }),
            },
          },
        ],
      }));
      const repository = new PgRuntimeControlConfigurationRepository(
        { query } as unknown as Pool,
        cipher,
      );
      expect(await repository.resolveTitleModelConfiguration()).toBe(
        titleGeneration === undefined ? undefined : null,
      );
      expect(query).toHaveBeenCalledOnce();
    },
  );
  it.each(["missing", "invalid", "database"])(
    "读取或解密失败绝不回退主模型凭据：%s",
    async (mode) => {
      const query = vi.fn(async (sql: string) => {
        if (sql.includes("JOIN admin_control_config_revisions"))
          return { rows: [{ configuration: { ...settings, titleGeneration: title } }] };
        if (mode === "database") throw new Error("private-database-canary");
        return {
          rows:
            mode === "missing"
              ? []
              : [
                  {
                    configuration: {
                      ...model,
                      credential: cipher.encrypt("other-provider", "private-key-canary"),
                    },
                  },
                ],
        };
      });
      const repository = new PgRuntimeControlConfigurationRepository(
        { query } as unknown as Pool,
        cipher,
        "private-main-model-canary",
      );
      await expect(repository.resolveTitleModelConfiguration()).rejects.toThrow();
      try {
        await repository.resolveTitleModelConfiguration();
      } catch (error) {
        expect(String(error)).not.toContain("private-");
      }
    },
  );
});

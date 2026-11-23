import type { AuthContextResolver } from "@hoox/identity/auth";
import { userId } from "@hoox/domain";
import { PersistenceError } from "@hoox/persistence/postgres";
import { AgentDefinitionValidationError } from "@hoox/persistence/admin";
import { describe, expect, it, vi } from "vitest";
import { type AdminControlApiDependencies, createAdminControlApiApp } from "./app.js";

const modelRevision = {
  revision: 1,
  versionToken: 1,
  status: "draft" as const,
  probeStatus: "untested" as const,
  createdBy: "user_admin",
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
  configuration: {
    providerKey: "main",
    displayName: "主模型",
    protocol: "openai-compatible" as const,
    baseUrl: "https://model.example.com/v1",
    credentialConfigured: true,
    defaultModelId: "model-a",
    models: [
      {
        id: "model-a",
        name: "Model A",
        enabled: true,
        reasoning: false,
        input: ["text" as const],
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
  },
};

function fixture(
  sandbox?: AdminControlApiDependencies["sandbox"],
  agents?: AdminControlApiDependencies["agents"],
) {
  const auth: AuthContextResolver = {
    resolve: vi.fn(async (input) =>
      input.authorization === "Bearer admin" ? { userId: userId("user_admin") } : undefined,
    ),
  };
  const control = {
    overview: vi.fn(),
    agentMetrics: vi.fn(async () => []),
    listModelProviders: vi.fn(async () => [modelRevision]),
    listMemoryProviders: vi.fn(async () => []),
    listRuntimeSettings: vi.fn(
      async (): Promise<
        Awaited<ReturnType<AdminControlApiDependencies["control"]["listRuntimeSettings"]>>
      > => [],
    ),
    listAudits: vi.fn(async () => []),
    listUsers: vi.fn(async () => ({
      total: 1,
      items: [
        {
          userId: "user_customer",
          email: "customer@example.com",
          displayName: "测试用户",
          status: "active" as const,
          createdAt: "2026-08-20T00:00:00.000Z",
          activeSessions: 1,
          conversationCount: 2,
          runCount: 5,
        },
      ],
    })),
    updateUserStatus: vi.fn(async (_context, input) => ({
      userId: input.targetUserId,
      email: "customer@example.com",
      displayName: "测试用户",
      status: input.status,
      createdAt: "2026-08-20T00:00:00.000Z",
      activeSessions: 0,
      conversationCount: 2,
      runCount: 5,
    })),
    createModelDraft: vi.fn(async () => modelRevision),
    createMemoryDraft: vi.fn(),
    saveModelConfiguration: vi.fn(async () => ({ ...modelRevision, status: "active" as const })),
    saveMemoryConfiguration: vi.fn(),
    saveRuntimeSettingsConfiguration: vi.fn(),
    probe: vi.fn(async () => ({
      ...modelRevision,
      versionToken: 2,
      probeStatus: "healthy" as const,
    })),
    publish: vi.fn(),
  } satisfies AdminControlApiDependencies["control"];
  const modelCatalog: AdminControlApiDependencies["modelCatalog"] = {
    listProviders: vi.fn(() => [
      {
        providerId: "deepseek",
        displayName: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        modelCount: 1,
      },
    ]),
    findModels: vi.fn(() => [
      {
        providerId: "deepseek",
        providerName: "DeepSeek",
        id: "deepseek-chat",
        name: "DeepSeek Chat",
        api: "openai-completions" as const,
        reasoning: false,
        input: ["text" as const],
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ]),
  };
  const publications = {
    list: vi.fn(async () => ({ items: [] })),
    get: vi.fn(),
    create: vi.fn(),
    submit: vi.fn(),
    review: vi.fn(),
    publish: vi.fn(),
    revoke: vi.fn(),
  } as unknown as AdminControlApiDependencies["skills"]["publications"];
  const identity: AdminControlApiDependencies["identity"] = {
    read: vi.fn(async () => ({
      versionToken: 0,
      emailPasswordEnabled: true,
      emailVerificationEnabled: false,
      smtpPort: 465,
      smtpSecure: true,
      smtpPasswordConfigured: false,
      registrationEnabled: true,
      phoneEnabled: false,
      smsWebhookSecretConfigured: false,
      providers: {
        google: { enabled: false, clientId: "", secretConfigured: false },
        github: { enabled: false, clientId: "", secretConfigured: false },
        wechat: { enabled: false, clientId: "", secretConfigured: false },
        qq: { enabled: false, clientId: "", secretConfigured: false },
      },
    })),
    update: vi.fn(async (_context, input) => ({
      versionToken: input.expectedVersionToken + 1,
      emailPasswordEnabled: input.emailPasswordEnabled,
      emailVerificationEnabled: input.emailVerificationEnabled,
      smtpPort: input.smtpPort,
      smtpSecure: input.smtpSecure,
      smtpPasswordConfigured: input.smtpPassword !== undefined,
      registrationEnabled: input.registrationEnabled,
      phoneEnabled: input.phoneEnabled,
      smsWebhookSecretConfigured: input.smsWebhookSecret !== undefined,
      providers: {
        google: {
          enabled: input.providers.google.enabled,
          clientId: input.providers.google.clientId,
          secretConfigured: input.providers.google.clientSecret !== undefined,
        },
        github: {
          enabled: input.providers.github.enabled,
          clientId: input.providers.github.clientId,
          secretConfigured: input.providers.github.clientSecret !== undefined,
        },
        wechat: {
          enabled: input.providers.wechat.enabled,
          clientId: input.providers.wechat.clientId,
          secretConfigured: input.providers.wechat.clientSecret !== undefined,
        },
        qq: {
          enabled: input.providers.qq.enabled,
          clientId: input.providers.qq.clientId,
          secretConfigured: input.providers.qq.clientSecret !== undefined,
        },
      },
    })),
  };
  return {
    control,
    identity,
    publications,
    app: createAdminControlApiApp({
      ...(sandbox === undefined ? {} : { sandbox }),
      ...(agents === undefined ? {} : { agents }),
      auth,
      control,
      modelCatalog,
      identity,
      skills: { publications },
      readiness: { async probe() {} },
    }),
  };
}

describe("后台控制 API", () => {
  it("保护配置导出和导入权限、写入审计并返回格式路径错误", async () => {
    const content = {
      displayName: "导入示例",
      description: "测试",
      suggestedQuestions: [],
      operatorInstructions: "使用中文回答。",
      replyLanguage: "zh-CN",
      model: { mode: "platform_default" as const },
      tools: { mode: "platform_default" as const },
      skillVersions: [],
      includeTenantSkills: false,
      sandboxIdleAction: "pause" as const,
      memory: { mode: "platform_default" as const },
    };
    const definition = {
      id: "agent_transfer",
      status: "published" as const,
      generation: 1,
      availability: { mode: "all_tenants" as const },
      currentRevisionId: "agent_transfer_revision",
      createdAt: "2026-11-20T00:00:00.000Z",
      updatedAt: "2026-11-20T00:00:00.000Z",
    };
    const revision = {
      id: "agent_transfer_revision",
      definitionId: definition.id,
      revision: 1,
      status: "published" as const,
      content,
      digest: "a".repeat(64),
      createdAt: definition.createdAt,
      createdBy: "user_admin",
    };
    const credentialSecret = "credential-secret-placeholder-e1";
    const agents = {
      validateImport: vi.fn(async () => undefined),
      readRevisionForExport: vi.fn(async () => ({ definition, revision, credentialSecret })),
      createDraft: vi.fn(async () => ({
        definition: { ...definition, status: "draft" },
        revision: { ...revision, status: "draft" },
      })),
    } as unknown as NonNullable<AdminControlApiDependencies["agents"]>;
    const { app } = fixture(undefined, agents);
    const url = "/v1/admin/control/agent-definitions";
    const yaml = `schemaVersion: 1\ndefinition:\n  id: agent_transfer\n  availability:\n    mode: all_tenants\nrevision:\n  content:\n    displayName: 导入示例\n    description: 测试\n    suggestedQuestions: []\n    operatorInstructions: 使用中文回答。\n    replyLanguage: zh-CN\n    model:\n      mode: platform_default\n    tools:\n      mode: platform_default\n    skillVersions: []\n    includeTenantSkills: false\n    sandboxIdleAction: pause\n    memory:\n      mode: platform_default\n`;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${url}/${definition.id}/revisions/${revision.id}/export`,
        })
      ).statusCode,
    ).toBe(401);
    const exported = await app.inject({
      method: "GET",
      url: `${url}/${definition.id}/revisions/${revision.id}/export`,
      headers: { authorization: "Bearer admin" },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("application/yaml");
    expect(exported.body).toContain("schemaVersion: 1");
    expect(exported.body).not.toContain(credentialSecret);
    expect(agents.readRevisionForExport).toHaveBeenCalledWith(
      "user_admin",
      definition.id,
      revision.id,
    );

    const noPermission = await app.inject({
      method: "POST",
      url: `${url}/import`,
      headers: { "content-type": "application/json" },
      payload: { yaml, dryRun: true },
    });
    expect(noPermission.statusCode).toBe(401);
    const invalid = await app.inject({
      method: "POST",
      url: `${url}/import`,
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      payload: { yaml: `${yaml}unknownField: true\n`, dryRun: false },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      validationErrors: [{ code: "UNKNOWN_FIELD" }],
    });
    const imported = await app.inject({
      method: "POST",
      url: `${url}/import`,
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json",
        "idempotency-key": "agent-config-import-1",
      },
      payload: { yaml, dryRun: false },
    });
    expect(imported.statusCode).toBe(201);
    expect(agents.validateImport).toHaveBeenCalledOnce();
    expect(agents.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent_transfer", auditAction: "imported" }),
    );
    vi.mocked(agents.validateImport).mockRejectedValueOnce(
      new AgentDefinitionValidationError("请选择已保存、已启用且绑定托管凭据的模型"),
    );
    const missingCredential = await app.inject({
      method: "POST",
      url: `${url}/import`,
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      payload: { yaml, dryRun: true },
    });
    expect(missingCredential.statusCode).toBe(200);
    expect(missingCredential.json()).toMatchObject({
      data: { valid: false, errors: [{ code: "REFERENCE_INVALID", path: "/revision/content" }] },
    });
    await app.close();
  });

  it("指标路由需要后台身份并转发窗口与来源筛选", async () => {
    const { app, control } = fixture();
    const url =
      "/v1/admin/control/agent-metrics?from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-02T00%3A00%3A00.000Z&origin=evaluation";
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url, headers: { authorization: "Bearer admin" } }))
        .statusCode,
    ).toBe(200);
    expect(control.agentMetrics).toHaveBeenCalledWith("user_admin", {
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
      origin: "evaluation",
    });
    await app.close();
  });

  it("指标查询繁忙时返回 503", async () => {
    const { app, control } = fixture();
    vi.mocked(control.agentMetrics).mockRejectedValueOnce(
      new PersistenceError("UNAVAILABLE", "指标查询繁忙，请稍后重试"),
    );
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/control/agent-metrics?from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-02T00%3A00%3A00.000Z",
      headers: { authorization: "Bearer admin" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "DEPENDENCY_UNAVAILABLE" } });
    await app.close();
  });

  it("沙箱接口保护身份、严格校验策略且不回显写入密钥", async () => {
    const configuration = {
      providerKey: "tencent-ags" as const,
      displayName: "腾讯云",
      endpoint: "sandbox.example.test",
      credentialConfigured: true,
      policy: {
        templateId: "template-test",
        sessionTtlSeconds: 300,
        operationTimeoutMs: 30000,
        lifecycleTimeoutMs: 60000,
        pausedRetentionSeconds: 123,
        idleAction: "pause" as const,
      },
    };
    const revision = {
      revision: 1,
      configuration,
      createdAt: "2026-09-10T00:00:00.000Z",
      probeStatus: "healthy" as const,
    };
    const sandbox = {
      overview: vi.fn(async () => ({ generation: 1, routing: undefined, profiles: [revision] })),
      saveProfile: vi.fn(async () => ({ ...revision, apiKey: "sandbox-secret-placeholder" })),
      publishRouting: vi.fn(async () => undefined),
      probeProfile: vi.fn(async () => ({ healthy: true, durationMs: 1000 })),
    };
    const { app } = fixture(sandbox);
    const headers = { authorization: "Bearer admin" };
    const path = "/v1/admin/control/sandbox";
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(401);
    expect(sandbox.overview).not.toHaveBeenCalled();
    expect((await app.inject({ method: "GET", url: path, headers })).statusCode).toBe(200);
    const { credentialConfigured: _state, ...writeConfiguration } = configuration;
    const response = await app.inject({
      method: "PUT",
      url: `${path}/profiles`,
      headers,
      payload: {
        expectedGeneration: 1,
        configuration: writeConfiguration,
        apiKey: "sandbox-secret-placeholder",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("sandbox-secret-placeholder");
    expect(sandbox.saveProfile).toHaveBeenCalledWith(
      "user_admin",
      expect.objectContaining({ apiKey: "sandbox-secret-placeholder" }),
    );
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `${path}/profiles`,
          headers,
          payload: {
            expectedGeneration: 1,
            configuration: {
              ...writeConfiguration,
              policy: { ...configuration.policy, lifecycleTimeoutMs: 90001 },
            },
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `${path}/routing`,
          headers,
          payload: {
            expectedGeneration: 1,
            configuration: {
              mode: "single",
              targets: [{ providerKey: "tencent-ags", profileRevision: 1, weight: 1 }],
            },
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: `${path}/profiles/tencent-ags/1/probe`, headers }))
        .statusCode,
    ).toBe(200);
    expect(sandbox.probeProfile).toHaveBeenCalledWith("user_admin", "tencent-ags", 1);
    sandbox.probeProfile.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { healthy: true, durationMs: 150 };
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    app.server.setTimeout(50);
    const slowProbe = await fetch(`${address}${path}/profiles/tencent-ags/1/probe`, {
      method: "POST",
      headers,
    });
    expect(slowProbe.status).toBe(200);
    expect(await slowProbe.json()).toMatchObject({ data: { healthy: true, durationMs: 150 } });
    await app.close();
  });
  it("在同一管理 API 实例提供 Skill 发布路由并复用管理身份", async () => {
    const { app, publications } = fixture();
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/skill-submissions?limit=20",
      headers: { authorization: "Bearer admin" },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.items).toEqual([]);
    expect(publications.list).toHaveBeenCalledWith({ userId: "user_admin", limit: 20 });
    await app.close();
  });

  it("读取和更新身份配置时不回显 Provider 与 SMTP Secret", async () => {
    const { app, identity } = fixture();
    const read = await app.inject({
      method: "GET",
      url: "/v1/admin/control/identity",
      headers: { authorization: "Bearer admin" },
    });
    expect(read.statusCode).toBe(200);
    expect(read.body).not.toContain("clientSecret");

    const update = await app.inject({
      method: "PUT",
      url: "/v1/admin/control/identity",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json",
        "idempotency-key": "identity-config-0001",
      },
      payload: {
        expectedVersionToken: 0,
        emailPasswordEnabled: true,
        emailVerificationEnabled: true,
        emailFromAddress: "no-reply@example.com",
        emailFromName: "Hoox",
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpSecure: true,
        smtpUsername: "mailer@example.com",
        smtpPassword: "smtp-secret",
        registrationEnabled: true,
        phoneEnabled: false,
        providers: [
          {
            key: "google",
            enabled: true,
            clientId: "google-client",
            clientSecret: "google-secret",
          },
          { key: "github", enabled: false, clientId: "" },
          { key: "wechat", enabled: false, clientId: "" },
          { key: "qq", enabled: false, clientId: "" },
        ],
        reason: "启用 Google 登录",
      },
    });
    expect(update.statusCode, update.body).toBe(200);
    expect(update.body).not.toContain("google-secret");
    expect(update.body).not.toContain("smtp-secret");
    expect(identity.update).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "user_admin",
        idempotencyKey: "identity-config-0001",
      }),
      expect.objectContaining({ reason: "启用 Google 登录" }),
    );
    await app.close();
  });

  it("拒绝未认证读取且不返回内部异常正文", async () => {
    const { app } = fixture();
    const response = await app.inject({ method: "GET", url: "/v1/admin/control/model-providers" });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain("stack");
    await app.close();
  });

  it("受认证保护地返回 Pi Provider，并支持自定义 Provider 按模型名查询", async () => {
    const { app, control } = fixture();
    const providers = await app.inject({
      method: "GET",
      url: "/v1/admin/control/model-catalog/providers",
      headers: { authorization: "Bearer admin" },
    });
    expect(providers.statusCode).toBe(200);
    expect(providers.json().data.items).toEqual([
      expect.objectContaining({ providerId: "deepseek", modelCount: 1 }),
    ]);

    const models = await app.inject({
      method: "GET",
      url: "/v1/admin/control/model-catalog/models?query=DeepSeek%20Chat&limit=10",
      headers: { authorization: "Bearer admin" },
    });
    expect(models.statusCode).toBe(200);
    expect(models.json().data.items).toEqual([
      expect.objectContaining({ id: "deepseek-chat", contextWindow: 128_000 }),
    ]);
    expect(control.listModelProviders).toHaveBeenCalledWith("user_admin");
    expect(models.body).not.toContain("apiKey");
    await app.close();
  });

  it("写操作要求 JSON 和幂等键，actor 只来自认证主体", async () => {
    const { app, control } = fixture();
    const { credentialConfigured: _credentialConfigured, ...configuration } =
      modelRevision.configuration;
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/control/model-providers",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json",
        "idempotency-key": "control-create-0001",
      },
      payload: { ...configuration, apiKey: "write-only-model-key" },
    });
    expect(response.statusCode).toBe(200);
    expect(control.createModelDraft).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: "user_admin", idempotencyKey: "control-create-0001" }),
      expect.not.objectContaining({ reason: expect.anything() }),
    );
    expect(response.body).not.toContain("apiKey");
    await app.close();
  });

  it("运行参数不再暴露草稿及审批发布接口", async () => {
    const { app } = fixture();
    for (const url of [
      "/v1/admin/control/runtime-settings",
      "/v1/admin/control/runtime-settings/global/revisions/1/publish",
    ]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: {
          authorization: "Bearer admin",
          "content-type": "application/json",
          "idempotency-key": "runtime-settings-0001",
        },
        payload: {},
      });
      expect(response.statusCode).toBe(404);
    }
    await app.close();
  });

  it("运行设置 PUT 一次保存并激活，要求幂等键且无需原因", async () => {
    const { app, control } = fixture();
    const configuration = {
      workerMaxConcurrentRuns: 20,
      userMaxConcurrentRunsPerTenant: 2,
      compactionSoftLimitPercent: 80,
      compactionTargetPercent: 55,
      compactionRecentUserTokens: 4096,
      compactionMaxOutputTokens: 4096,
      compactionTimeoutMs: 60000,
    };
    control.saveRuntimeSettingsConfiguration.mockResolvedValue({
      ...modelRevision,
      status: "active",
      configuration,
    });
    const response = await app.inject({
      method: "PUT",
      url: "/v1/admin/control/runtime-settings/current",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json",
        "idempotency-key": "settings-save-0001",
      },
      payload: { ...configuration, expectedGeneration: 0 },
    });
    expect(response.statusCode).toBe(200);
    expect(control.saveRuntimeSettingsConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: "user_admin", idempotencyKey: "settings-save-0001" }),
      { ...configuration, expectedGeneration: 0 },
    );
    expect(response.json().data.status).toBe("active");
    await app.close();
  });

  it("运行设置 API 正常与 PTC 往返，保存与读取都保留模式字段", async () => {
    const { app, control } = fixture();
    const configuration = {
      workerMaxConcurrentRuns: 20,
      userMaxConcurrentRunsPerTenant: 2,
      compactionSoftLimitPercent: 80,
      compactionTargetPercent: 55,
      compactionRecentUserTokens: 4096,
      compactionMaxOutputTokens: 4096,
      compactionTimeoutMs: 60000,
    };
    for (const [index, toolCallingMode] of (["native", "ptc", "native"] as const).entries()) {
      const revision = {
        ...modelRevision,
        revision: index + 1,
        status: "active" as const,
        configuration: { ...configuration, toolCallingMode },
      };
      control.saveRuntimeSettingsConfiguration.mockResolvedValueOnce(revision);
      const payload = { ...revision.configuration, expectedGeneration: index };
      const response = await app.inject({
        method: "PUT",
        url: "/v1/admin/control/runtime-settings/current",
        headers: {
          authorization: "Bearer admin",
          "content-type": "application/json",
          "idempotency-key": `settings-mode-${index}`,
        },
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.configuration.toolCallingMode).toBe(toolCallingMode);
      expect(control.saveRuntimeSettingsConfiguration).toHaveBeenLastCalledWith(
        expect.objectContaining({ actorUserId: "user_admin" }),
        payload,
      );
      control.listRuntimeSettings.mockResolvedValueOnce([revision]);
      const read = await app.inject({
        method: "GET",
        url: "/v1/admin/control/runtime-settings",
        headers: { authorization: "Bearer admin" },
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().data.items[0].configuration.toolCallingMode).toBe(toolCallingMode);
    }
    await app.close();
  });

  it("运行设置 API 部分工具与空清单往返，保存与读取保留选择", async () => {
    const { app, control } = fixture();
    const configuration = {
      toolCallingMode: "native" as const,
      workerMaxConcurrentRuns: 20,
      userMaxConcurrentRunsPerTenant: 2,
      compactionSoftLimitPercent: 80,
      compactionTargetPercent: 55,
      compactionRecentUserTokens: 4096,
      compactionMaxOutputTokens: 4096,
      compactionTimeoutMs: 60000,
    };
    for (const [index, enabledTools] of (
      [["read", "skill"], [], ["exec_command"]] as const
    ).entries()) {
      const revision = {
        ...modelRevision,
        revision: index + 1,
        status: "active" as const,
        configuration: { ...configuration, enabledTools: [...enabledTools] },
      };
      control.saveRuntimeSettingsConfiguration.mockResolvedValueOnce(revision);
      const payload = { ...revision.configuration, expectedGeneration: index };
      const response = await app.inject({
        method: "PUT",
        url: "/v1/admin/control/runtime-settings/current",
        headers: {
          authorization: "Bearer admin",
          "content-type": "application/json",
          "idempotency-key": `settings-tools-${index}`,
        },
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.configuration.enabledTools).toEqual(enabledTools);
      expect(control.saveRuntimeSettingsConfiguration).toHaveBeenLastCalledWith(
        expect.objectContaining({ actorUserId: "user_admin" }),
        payload,
      );
      control.listRuntimeSettings.mockResolvedValueOnce([revision]);
      const read = await app.inject({
        method: "GET",
        url: "/v1/admin/control/runtime-settings",
        headers: { authorization: "Bearer admin" },
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().data.items[0].configuration.enabledTools).toEqual(enabledTools);
    }
    await app.close();
  });

  it.each([null, "", "PTC", "auto", 1, false])(
    "API 拒绝非法工具调用模式 %s",
    async (toolCallingMode) => {
      const { app, control } = fixture();
      const response = await app.inject({
        method: "PUT",
        url: "/v1/admin/control/runtime-settings/current",
        headers: {
          authorization: "Bearer admin",
          "content-type": "application/json",
          "idempotency-key": "settings-invalid-mode",
        },
        payload: {
          workerMaxConcurrentRuns: 20,
          userMaxConcurrentRunsPerTenant: 2,
          compactionSoftLimitPercent: 80,
          compactionTargetPercent: 55,
          compactionRecentUserTokens: 4096,
          compactionMaxOutputTokens: 4096,
          compactionTimeoutMs: 60000,
          toolCallingMode,
          expectedGeneration: 0,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(control.saveRuntimeSettingsConfiguration).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it.each(["未登录", "缺少幂等键"])("PTC 保存仍拒绝%s", async (invalidContext) => {
    const { app, control } = fixture();
    const response = await app.inject({
      method: "PUT",
      url: "/v1/admin/control/runtime-settings/current",
      headers: {
        "content-type": "application/json",
        ...(invalidContext === "未登录"
          ? { "idempotency-key": "settings-auth-mode" }
          : { authorization: "Bearer admin" }),
      },
      payload: {
        workerMaxConcurrentRuns: 20,
        userMaxConcurrentRunsPerTenant: 2,
        compactionSoftLimitPercent: 80,
        compactionTargetPercent: 55,
        compactionRecentUserTokens: 4096,
        compactionMaxOutputTokens: 4096,
        compactionTimeoutMs: 60000,
        toolCallingMode: "ptc",
        expectedGeneration: 0,
      },
    });
    expect(response.statusCode).toBe(invalidContext === "未登录" ? 401 : 400);
    expect(control.saveRuntimeSettingsConfiguration).not.toHaveBeenCalled();
    await app.close();
  });

  it("模型保存一次请求生效，要求内部并发状态且不要求原因", async () => {
    const { app, control } = fixture();
    const { credentialConfigured: _credentialConfigured, ...configuration } =
      modelRevision.configuration;
    const payload = { ...configuration, apiKey: "unit-provider-key", expectedGeneration: 0 };
    const response = await app.inject({
      method: "PUT",
      url: "/v1/admin/control/model-providers/current",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json",
        "idempotency-key": "save-model-0001",
      },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("active");
    expect(control.saveModelConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: "user_admin" }),
      payload,
    );
    expect(control.createModelDraft).not.toHaveBeenCalled();
    expect(control.publish).not.toHaveBeenCalled();
    const { expectedGeneration: _expectedGeneration, ...invalid } = payload;
    const rejected = await app.inject({
      method: "PUT",
      url: "/v1/admin/control/model-providers/current",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json",
        "idempotency-key": "save-model-0002",
      },
      payload: invalid,
    });
    expect(rejected.statusCode).toBe(400);
    await app.close();
  });

  it.each([false, true])("记忆保存直接返回当前配置且不调用探测，托管凭据=%s", async (managed) => {
    const { app, control } = fixture();
    const configuration = {
      providerKey: "mem0",
      displayName: "Mem0",
      providerKind: "mem0",
      baseUrl: "https://memory.example.invalid/",
      apiSecretRef: managed ? "managed:memory-api" : "deployment:memory-api",
      scopeSecretRef: managed ? "platform:memory-scope" : "deployment:memory-scope",
      requestTimeoutMs: 10000,
      enabled: false,
    };
    control.saveMemoryConfiguration.mockResolvedValueOnce({
      ...modelRevision,
      status: "active",
      configuration,
    });
    const response = await app.inject({
      method: "PUT",
      url: "/v1/admin/control/memory-providers/current",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json",
        "idempotency-key": "save-memory-0001",
      },
      payload: {
        ...configuration,
        expectedGeneration: 1,
        ...(managed ? { apiKey: "unit-write-only-memory-key" } : {}),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.configuration.enabled).toBe(false);
    expect(response.body).not.toContain("unit-write-only-memory-key");
    expect(control.saveMemoryConfiguration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ...configuration,
        ...(managed ? { apiKey: "unit-write-only-memory-key" } : {}),
      }),
    );
    expect(control.probe).not.toHaveBeenCalled();
    expect(control.createMemoryDraft).not.toHaveBeenCalled();
    await app.close();
  });
  it("探测路由只传递已读取 revision，不接受客户端伪造配置", async () => {
    const { app, control } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/control/model-providers/main/revisions/1/probe",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json",
        "idempotency-key": "control-probe-0001",
      },
      payload: { expectedVersionToken: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(control.probe).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: "user_admin" }),
      expect.objectContaining({
        kind: "model_provider",
        revision: modelRevision,
        expectedVersionToken: 1,
      }),
    );
    await app.close();
  });

  it("把领域层配置校验失败稳定映射为 400", async () => {
    const { app, control } = fixture();
    const { credentialConfigured: _credentialConfigured, ...configuration } =
      modelRevision.configuration;
    control.createModelDraft.mockRejectedValueOnce(new TypeError("Provider 地址必须使用 HTTPS"));
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/control/model-providers",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json",
        "idempotency-key": "control-create-0002",
      },
      payload: { ...configuration, apiKey: "write-only-model-key" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe("Provider 地址必须使用 HTTPS");
    await app.close();
  });

  it("审计读取受认证保护并限制返回条数", async () => {
    const { app, control } = fixture();
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/control/audits?limit=20",
      headers: { authorization: "Bearer admin" },
    });
    expect(response.statusCode).toBe(200);
    expect(control.listAudits).toHaveBeenCalledWith("user_admin", 20);
    await app.close();
  });

  it("用户目录和状态治理只使用认证管理员身份且不返回凭据材料", async () => {
    const { app, control } = fixture();
    const directory = await app.inject({
      method: "GET",
      url: "/v1/admin/control/users?query=customer&limit=20",
      headers: { authorization: "Bearer admin" },
    });
    expect(directory.statusCode).toBe(200);
    expect(control.listUsers).toHaveBeenCalledWith("user_admin", "customer", 20);
    expect(directory.body).not.toContain("passwordHash");
    expect(directory.body).not.toContain("tokenDigest");

    const update = await app.inject({
      method: "POST",
      url: "/v1/admin/control/users/user_customer/status",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json",
        "idempotency-key": "user-status-0001",
      },
      payload: { status: "disabled", reason: "风险账号处置" },
    });
    expect(update.statusCode).toBe(200);
    expect(control.updateUserStatus).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: "user_admin", idempotencyKey: "user-status-0001" }),
      { targetUserId: "user_customer", status: "disabled", reason: "风险账号处置" },
    );
    await app.close();
  });
});

describe("后台工具开关输入保护", () => {
  it.each([null, "read", ["unknown"], ["read", "read"], ["run_code"]])(
    "非法工具选择 %j 不进入控制服务",
    async (enabledTools) => {
      const { app, control } = fixture();
      const response = await app.inject({
        method: "PUT",
        url: "/v1/admin/control/runtime-settings/current",
        headers: {
          authorization: "Bearer admin",
          "content-type": "application/json",
          "idempotency-key": "invalid-tools-selection",
        },
        payload: {
          workerMaxConcurrentRuns: 20,
          userMaxConcurrentRunsPerTenant: 2,
          compactionSoftLimitPercent: 80,
          compactionTargetPercent: 55,
          compactionRecentUserTokens: 4096,
          compactionMaxOutputTokens: 4096,
          compactionTimeoutMs: 60000,
          expectedGeneration: 0,
          enabledTools,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(control.saveRuntimeSettingsConfiguration).not.toHaveBeenCalled();
      await app.close();
    },
  );
});

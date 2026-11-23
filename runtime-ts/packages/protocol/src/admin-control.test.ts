import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  CreateModelProviderDraftRequestSchema,
  AgentMetricsQueryDtoSchema,
  ModelProviderControlRevisionRequestSchema,
  PlatformUserPageDtoSchema,
  RuntimeSettingsConfigurationDtoSchema,
  RuntimeStatisticsDtoSchema,
  SaveRuntimeSettingsConfigurationRequestSchema,
  UpdatePlatformUserStatusRequestSchema,
} from "./admin-control.js";

describe("后台运营协议", () => {
  it("指标时间窗口要求真实日历日期和 UTC 时区", () => {
    for (const from of ["2026-02-30T00:00:00.000Z", "2026-11-22T00:00:00", "2026-11-22"]) {
      expect(
        Value.Check(AgentMetricsQueryDtoSchema, {
          from,
          to: "2026-11-23T00:00:00.000Z",
        }),
      ).toBe(false);
    }
    expect(
      Value.Check(AgentMetricsQueryDtoSchema, {
        from: "2026-11-22T00:00:00.000Z",
        to: "2026-11-23T00:00:00.000Z",
      }),
    ).toBe(true);
  });
  it.each(["native", "ptc", undefined, null, "", "PTC", "auto", 1, false])(
    "运行设置协议校验工具调用模式 %s",
    (toolCallingMode) => {
      const configuration = {
        workerMaxConcurrentRuns: 20,
        userMaxConcurrentRunsPerTenant: 2,
        compactionSoftLimitPercent: 80,
        compactionTargetPercent: 55,
        compactionRecentUserTokens: 4096,
        compactionMaxOutputTokens: 4096,
        compactionTimeoutMs: 60000,
        ...(toolCallingMode === undefined ? {} : { toolCallingMode }),
      };
      const valid =
        toolCallingMode === undefined || toolCallingMode === "native" || toolCallingMode === "ptc";
      expect(Value.Check(RuntimeSettingsConfigurationDtoSchema, configuration)).toBe(valid);
      expect(
        Value.Check(SaveRuntimeSettingsConfigurationRequestSchema, {
          ...configuration,
          expectedGeneration: 0,
        }),
      ).toBe(valid);
    },
  );

  it("标题模型协议区分未配置、关闭和精确引用，拒绝密钥或额外字段", () => {
    const settings = {
      workerMaxConcurrentRuns: 20,
      userMaxConcurrentRunsPerTenant: 2,
      compactionSoftLimitPercent: 80,
      compactionTargetPercent: 55,
      compactionRecentUserTokens: 4096,
      compactionMaxOutputTokens: 4096,
      compactionTimeoutMs: 60000,
    };
    const enabled = { enabled: true, providerKey: "titles", providerRevision: 2, modelId: "cheap" };
    for (const titleGeneration of [undefined, { enabled: false }, enabled]) {
      expect(
        Value.Check(RuntimeSettingsConfigurationDtoSchema, {
          ...settings,
          compactionEnabled: false,
          ...(titleGeneration === undefined ? {} : { titleGeneration }),
        }),
      ).toBe(true);
    }
    for (const titleGeneration of [
      { enabled: true },
      { ...enabled, providerRevision: 0 },
      { ...enabled, apiKey: "private-canary" },
      { ...enabled, enabled: false },
    ]) {
      expect(
        Value.Check(RuntimeSettingsConfigurationDtoSchema, { ...settings, titleGeneration }),
      ).toBe(false);
    }
  });

  it("模型配置允许正常大小写且保存、测试和切换均不接收变更原因", () => {
    const draft = {
      providerKey: "DeepSeek",
      displayName: "DeepSeek",
      protocol: "openai-compatible",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "test-provider-key",
      defaultModelId: "deepseek-v4-flash-vision-exp",
      models: [
        {
          id: "deepseek-v4-flash-vision-exp",
          name: "DeepSeek V4 Flash Vision",
          enabled: true,
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    };
    expect(Value.Check(CreateModelProviderDraftRequestSchema, draft)).toBe(true);
    expect(
      Value.Check(CreateModelProviderDraftRequestSchema, {
        ...draft,
        models: [{ ...draft.models[0], pricing: { currency: "USD", inputPerMillion: 0.2 } }],
      }),
    ).toBe(true);
    for (const pricing of [
      { currency: "usd", inputPerMillion: 0.2 },
      { currency: "USD", inputPerMillion: -1 },
      { currency: "USD", cacheReadPerMillion: "0.1" },
    ]) {
      expect(
        Value.Check(CreateModelProviderDraftRequestSchema, {
          ...draft,
          models: [{ ...draft.models[0], pricing }],
        }),
      ).toBe(false);
    }
    expect(
      Value.Check(CreateModelProviderDraftRequestSchema, { ...draft, reason: "不应由用户填写" }),
    ).toBe(false);
    expect(
      Value.Check(ModelProviderControlRevisionRequestSchema, { expectedVersionToken: 1 }),
    ).toBe(true);
    expect(
      Value.Check(ModelProviderControlRevisionRequestSchema, {
        expectedVersionToken: 1,
        reason: "不应由用户填写",
      }),
    ).toBe(false);
  });

  it("统计协议明确用户、对话和可靠性口径", () => {
    expect(
      Value.Check(RuntimeStatisticsDtoSchema, {
        generatedAt: "2026-08-21T00:00:00.000Z",
        users: { total: 10, registered24h: 1, active7d: 5, disabled: 0 },
        conversations: { total: 20, created24h: 2, active24h: 7, archived: 3 },
        runs: {
          total: 30,
          queued: 1,
          running: 2,
          succeeded24h: 8,
          failed24h: 1,
          cancelled24h: 0,
        },
        dispatch: { pending: 1, claimed: 0 },
        sandboxes: { active: 2, paused: 0, cleanupPending: 0 },
        memory: { pending: 0, failed: 0 },
        automations: { active: 1, failedOccurrences24h: 0 },
        skills: { published: 4, installed: 8 },
        modelUsage24h: {
          inputTokens: 12_000,
          outputTokens: 2_400,
          outputTokensPerSecond: 48,
          cacheHitRate: 0.75,
        },
      }),
    ).toBe(true);
  });

  it("没有用量样本时允许速率和缓存率保持未知", () => {
    const emptyUsage = {
      inputTokens: 0,
      outputTokens: 0,
      outputTokensPerSecond: null,
      cacheHitRate: null,
    };
    expect(Value.Check(RuntimeStatisticsDtoSchema.properties.modelUsage24h, emptyUsage)).toBe(true);
  });

  it("用户目录不接受凭据材料且状态变更允许省略原因", () => {
    const page = {
      total: 1,
      items: [
        {
          userId: "user_customer",
          email: "customer@example.com",
          displayName: "测试用户",
          status: "active",
          createdAt: "2026-08-21T00:00:00.000Z",
          activeSessions: 1,
          conversationCount: 2,
          runCount: 3,
        },
      ],
    };
    expect(Value.Check(PlatformUserPageDtoSchema, page)).toBe(true);
    expect(
      Value.Check(PlatformUserPageDtoSchema, {
        ...page,
        items: [{ ...page.items[0], passwordHash: "secret" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(UpdatePlatformUserStatusRequestSchema, {
        status: "disabled",
        reason: "风险账号处置",
      }),
    ).toBe(true);
    expect(
      Value.Check(UpdatePlatformUserStatusRequestSchema, { status: "disabled", reason: "" }),
    ).toBe(false);
    expect(Value.Check(UpdatePlatformUserStatusRequestSchema, { status: "disabled" })).toBe(true);
  });
});

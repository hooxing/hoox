import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  PlatformUserPageDtoSchema,
  RuntimeStatisticsDtoSchema,
  UpdatePlatformUserStatusRequestSchema,
} from "./admin-control.js";

describe("后台运营协议", () => {
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

  it("用户目录不接受凭据材料且状态变更必须包含原因", () => {
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
  });
});

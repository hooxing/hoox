import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { ApiKeyScopeSchema, EndUserHeaderSchema } from "./api-key.js";
import { PlatformUserSummaryDtoSchema } from "./admin-control.js";

describe("终端用户映射协议", () => {
  it("声明 ID 严格有界且不会接受尾随换行或合并的请求头", () => {
    expect(Value.Check(ApiKeyScopeSchema, "end-users:represent")).toBe(true);
    for (const value of ["a", "Customer:42", "acct/alice@example.test", "a".repeat(128)]) {
      expect(Value.Check(EndUserHeaderSchema, value)).toBe(true);
    }
    for (const value of [
      "",
      " alice",
      "alice ",
      "alice,bob",
      "a\nb",
      "a\n",
      "用户",
      "a".repeat(129),
    ]) {
      expect(Value.Check(EndUserHeaderSchema, value)).toBe(false);
    }
  });

  it("后台目录可表达无登录邮箱的映射用户", () => {
    expect(
      Value.Check(PlatformUserSummaryDtoSchema, {
        userId: "user_mapping_example",
        email: "",
        displayName: "a".repeat(128),
        source: "api_mapping",
        status: "active",
        createdAt: "2026-11-22T00:00:00.000Z",
        activeSessions: 0,
        conversationCount: 0,
        runCount: 0,
      }),
    ).toBe(true);
  });
});

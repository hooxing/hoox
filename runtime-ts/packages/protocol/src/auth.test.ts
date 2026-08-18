import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  AccountSessionSuccessEnvelopeSchema,
  LoginAccountRequestSchema,
  RegisterAccountRequestSchema,
} from "./auth.js";

describe("账号认证协议", () => {
  it("约束注册与登录输入，并固定会话响应结构", () => {
    expect(
      Value.Check(RegisterAccountRequestSchema, {
        displayName: "林晓",
        email: "lin@example.com",
        password: "secret123",
      }),
    ).toBe(true);
    expect(
      Value.Check(RegisterAccountRequestSchema, {
        displayName: "林晓",
        email: "lin@example.com",
        password: "short",
      }),
    ).toBe(false);
    expect(
      Value.Check(LoginAccountRequestSchema, {
        email: "lin@example.com",
        password: "secret123",
      }),
    ).toBe(true);
    expect(
      Value.Check(AccountSessionSuccessEnvelopeSchema, {
        version: "v1",
        requestId: "request_auth_1",
        data: {
          profile: { id: "user_local_1", displayName: "林晓", email: "lin@example.com" },
          accessToken: "hoox_session_abcdefghijklmnopqrstuvwxyz123456",
          expiresAt: "2026-09-15T00:00:00.000Z",
        },
      }),
    ).toBe(true);
  });
});

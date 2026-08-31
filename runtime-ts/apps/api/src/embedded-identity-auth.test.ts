import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  handler: vi.fn(async () => Response.json({ ok: true })),
  getSession: vi.fn(),
}));

vi.mock("@hoox/identity", () => ({
  createEmbeddedBetterAuth: vi.fn(() => ({
    handler: authState.handler,
    api: { getSession: authState.getSession },
  })),
  emptyIdentityConfiguration: () => ({
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
  }),
}));

import { createEmbeddedIdentityAuthService } from "./embedded-identity-auth.js";

const configuration = {
  versionToken: 2,
  emailPasswordEnabled: true,
  emailVerificationEnabled: true,
  emailFromAddress: "no-reply@example.com",
  emailFromName: "Hoox",
  smtpHost: "smtp.example.com",
  smtpPort: 465,
  smtpSecure: true,
  smtpUsername: "mailer@example.com",
  smtpPasswordConfigured: true,
  registrationEnabled: true,
  phoneEnabled: false,
  smsWebhookSecretConfigured: false,
  providers: {
    google: { enabled: false, clientId: "", secretConfigured: false },
    github: { enabled: false, clientId: "", secretConfigured: false },
    wechat: { enabled: false, clientId: "", secretConfigured: false },
    qq: { enabled: false, clientId: "", secretConfigured: false },
  },
} as const;

function fixture() {
  const database = {
    query: vi.fn(async () => ({ rows: [{ present: 1 }], rowCount: 1 })),
  };
  const localAccounts = {
    exchangeBetterAuthIdentity: vi.fn(async () => ({
      profile: { id: "user_1", displayName: "测试用户", email: "user@example.com" },
      accessToken: "hoox_session_test-token-with-more-than-thirty-two-characters",
      expiresAt: "2099-12-31T23:59:59.000Z",
    })),
  };
  const service = createEmbeddedIdentityAuthService({
    database: database as never,
    configurations: {
      read: vi.fn(async () => ({
        configuration,
        secrets: { providerSecrets: {}, smtpPassword: "smtp-password" },
      })),
      save: vi.fn(),
    },
    localAccounts: localAccounts as never,
    baseURL: "https://hoox.example.com",
    secret: "test-better-auth-secret-at-least-thirty-two-bytes",
  });
  return { service, database, localAccounts };
}

beforeEach(() => {
  authState.handler.mockClear();
  authState.getSession.mockReset();
});

describe("内嵌邮箱验证码边界", () => {
  it("只开放邮箱验证 OTP 路由并拒绝借插件启用密码外登录", async () => {
    const { service } = fixture();
    const passwordless = await service.handle({
      method: "POST",
      path: "/api/auth/sign-in/email-otp",
      headers: new Headers(),
      body: JSON.stringify({ email: "user@example.com", otp: "123456" }),
    });
    expect(passwordless.status).toBe(404);
    expect(authState.handler).not.toHaveBeenCalled();

    const defaultVerification = await service.handle({
      method: "POST",
      path: "/api/auth/send-verification-email",
      headers: new Headers(),
      body: JSON.stringify({ email: "user@example.com" }),
    });
    expect(defaultVerification.status).toBe(404);
    expect(authState.handler).not.toHaveBeenCalled();

    const wrongPurpose = await service.handle({
      method: "POST",
      path: "/api/auth/email-otp/send-verification-otp",
      headers: new Headers(),
      body: JSON.stringify({ email: "user@example.com", type: "sign-in" }),
    });
    expect(wrongPurpose.status).toBe(400);
    expect(authState.handler).not.toHaveBeenCalled();

    const verification = await service.handle({
      method: "POST",
      path: "/api/auth/email-otp/send-verification-otp",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify({ email: "user@example.com", type: "email-verification" }),
    });
    expect(verification.status).toBe(200);
    expect(authState.handler).toHaveBeenCalledOnce();
  });

  it("拒绝为未验证的邮箱密码身份交换 Hoox 会话", async () => {
    const { service, database, localAccounts } = fixture();
    authState.getSession.mockResolvedValue({
      user: {
        id: "better_user_1",
        name: "测试用户",
        email: "user@example.com",
        emailVerified: false,
      },
    });

    await expect(service.exchange(new Headers())).rejects.toMatchObject({ kind: "unauthorized" });
    expect(database.query).toHaveBeenCalledWith(
      "SELECT 1 FROM better_auth_accounts WHERE user_id=$1 AND provider_id='credential' LIMIT 1",
      ["better_user_1"],
    );
    expect(localAccounts.exchangeBetterAuthIdentity).not.toHaveBeenCalled();
  });

  it("允许已验证身份和不使用密码凭据的第三方身份完成交换", async () => {
    const { service, database, localAccounts } = fixture();
    authState.getSession.mockResolvedValue({
      user: {
        id: "better_user_2",
        name: "第三方用户",
        email: "social@example.com",
        emailVerified: false,
      },
    });
    database.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(service.exchange(new Headers())).resolves.toMatchObject({
      profile: { email: "user@example.com" },
    });
    expect(localAccounts.exchangeBetterAuthIdentity).toHaveBeenCalledWith({
      id: "better_user_2",
      name: "第三方用户",
      email: "social@example.com",
    });
  });
});

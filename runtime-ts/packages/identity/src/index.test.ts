import { getSchema } from "better-auth/db";
import { describe, expect, it, vi } from "vitest";
import {
  createEmbeddedBetterAuthOptions,
  decryptIdentitySecrets,
  emptyIdentityConfiguration,
  encryptIdentitySecrets,
  normalizeEditableIdentityConfiguration,
} from "./index.js";

const secret = "test-better-auth-secret-at-least-thirty-two-bytes";

describe("身份配置", () => {
  it("默认仅启用邮箱密码且不启用外部身份源", () => {
    expect(emptyIdentityConfiguration()).toMatchObject({
      versionToken: 0,
      emailPasswordEnabled: true,
      registrationEnabled: true,
      phoneEnabled: false,
      providers: {
        google: { enabled: false, secretConfigured: false },
        github: { enabled: false, secretConfigured: false },
        wechat: { enabled: false, secretConfigured: false },
        qq: { enabled: false, secretConfigured: false },
      },
    });
  });

  it("保留未替换的秘密并拒绝启用不完整 Provider", () => {
    const current = { providerSecrets: { github: "old-secret" } } as const;
    const result = normalizeEditableIdentityConfiguration(
      {
        expectedVersionToken: 3,
        emailPasswordEnabled: true,
        registrationEnabled: false,
        phoneEnabled: false,
        providers: {
          google: { enabled: false, clientId: "" },
          github: { enabled: true, clientId: "github-client" },
          wechat: { enabled: false, clientId: "" },
          qq: { enabled: false, clientId: "" },
        },
      },
      current,
    );
    expect(result.configuration.versionToken).toBe(4);
    expect(result.configuration.providers.github.secretConfigured).toBe(true);
    expect(result.secrets.providerSecrets.github).toBe("old-secret");
    expect(() =>
      normalizeEditableIdentityConfiguration(
        {
          expectedVersionToken: 0,
          emailPasswordEnabled: true,
          registrationEnabled: true,
          phoneEnabled: false,
          providers: {
            google: { enabled: true, clientId: "google-client" },
            github: { enabled: false, clientId: "" },
            wechat: { enabled: false, clientId: "" },
            qq: { enabled: false, clientId: "" },
          },
        },
        { providerSecrets: {} },
      ),
    ).toThrow("IDENTITY_PROVIDER_INCOMPLETE:google");
  });

  it("使用部署秘密加密 Provider 凭据且密文不包含明文", () => {
    const values = {
      providerSecrets: { google: "google-client-secret" },
      smsWebhookSecret: "sms-secret",
    } as const;
    const encrypted = encryptIdentitySecrets(secret, values);
    expect(Buffer.from(encrypted.ciphertext).toString("utf8")).not.toContain(
      "google-client-secret",
    );
    expect(decryptIdentitySecrets(secret, encrypted)).toEqual(values);
    expect(() => decryptIdentitySecrets(`${secret}-wrong`, encrypted)).toThrow();
  });

  it("手机号登录只接受公网 HTTPS 短信 Webhook", () => {
    const base = {
      expectedVersionToken: 0,
      emailPasswordEnabled: true,
      registrationEnabled: true,
      phoneEnabled: true,
      providers: {
        google: { enabled: false, clientId: "" },
        github: { enabled: false, clientId: "" },
        wechat: { enabled: false, clientId: "" },
        qq: { enabled: false, clientId: "" },
      },
    } as const;
    expect(() =>
      normalizeEditableIdentityConfiguration(
        { ...base, smsWebhookUrl: "http://127.0.0.1/sms" },
        { providerSecrets: {} },
      ),
    ).toThrow("IDENTITY_SMS_WEBHOOK_URL_INVALID");
    expect(
      normalizeEditableIdentityConfiguration(
        { ...base, smsWebhookUrl: "https://sms.example.invalid/send" },
        { providerSecrets: {} },
      ).configuration.smsWebhookUrl,
    ).toBe("https://sms.example.invalid/send");
  });

  it("关闭注册时禁止邮箱、OAuth 和手机号隐式创建用户", async () => {
    const database = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    };
    const configuration = normalizeEditableIdentityConfiguration(
      {
        expectedVersionToken: 0,
        emailPasswordEnabled: true,
        registrationEnabled: false,
        phoneEnabled: true,
        smsWebhookUrl: "https://sms.example.invalid/send",
        providers: {
          google: { enabled: true, clientId: "google-client" },
          github: { enabled: false, clientId: "" },
          wechat: { enabled: false, clientId: "" },
          qq: { enabled: true, clientId: "qq-client" },
        },
      },
      { providerSecrets: { google: "google-secret", qq: "qq-secret" } },
    ).configuration;
    const options = createEmbeddedBetterAuthOptions({
      database: database as never,
      baseURL: "http://127.0.0.1:3001",
      secret,
      configuration,
      secrets: { providerSecrets: { google: "google-secret", qq: "qq-secret" } },
    });
    expect(options.emailAndPassword?.disableSignUp).toBe(true);
    expect(options.socialProviders?.google).toMatchObject({ disableImplicitSignUp: true });
    const plugins = options.plugins as unknown as readonly {
      readonly id: string;
      readonly options?: {
        readonly config?: readonly { readonly disableImplicitSignUp?: boolean }[];
        readonly signUpOnVerification?: unknown;
        readonly sendOTP?: (input: {
          readonly phoneNumber: string;
          readonly code: string;
        }) => Promise<void>;
      };
    }[];
    expect(
      plugins.find((plugin) => plugin.id === "generic-oauth")?.options?.config?.[0],
    ).toMatchObject({ disableImplicitSignUp: true });
    const phone = plugins.find((plugin) => plugin.id === "phone-number");
    expect(phone?.options?.signUpOnVerification).toBeUndefined();
    await expect(
      phone?.options?.sendOTP?.({ phoneNumber: "+8613800138000", code: "123456" }),
    ).rejects.toThrow("PHONE_REGISTRATION_DISABLED");
    expect(database.query).toHaveBeenCalledWith(
      "SELECT 1 FROM better_auth_users WHERE phone_number=$1 LIMIT 1",
      ["+8613800138000"],
    );
  });

  it("生成与固定 PostgreSQL 迁移一致的 Better Auth 表和字段", () => {
    const configuration = normalizeEditableIdentityConfiguration(
      {
        expectedVersionToken: 0,
        emailPasswordEnabled: true,
        registrationEnabled: true,
        phoneEnabled: true,
        smsWebhookUrl: "https://sms.example.invalid/send",
        providers: {
          google: { enabled: false, clientId: "" },
          github: { enabled: false, clientId: "" },
          wechat: { enabled: false, clientId: "" },
          qq: { enabled: false, clientId: "" },
        },
      },
      { providerSecrets: {} },
    ).configuration;
    const schema = getSchema(
      createEmbeddedBetterAuthOptions({
        database: {} as never,
        baseURL: "http://127.0.0.1:3001",
        secret,
        configuration,
        secrets: { providerSecrets: {} },
      }),
    );
    expect(Object.keys(schema)).toEqual([
      "better_auth_users",
      "better_auth_sessions",
      "better_auth_accounts",
      "better_auth_verifications",
      "better_auth_rate_limits",
    ]);
    expect(Object.keys(schema.better_auth_users?.fields ?? {})).toContain("phone_number");
    expect(Object.keys(schema.better_auth_accounts?.fields ?? {})).toContain("scope");
    expect(Object.keys(schema.better_auth_rate_limits?.fields ?? {})).toEqual([
      "key",
      "count",
      "last_request",
    ]);
  });
});

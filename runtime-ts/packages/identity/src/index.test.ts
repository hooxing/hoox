import { describe, expect, it } from "vitest";
import {
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
});

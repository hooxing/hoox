import type {
  IdentityAdminConfigurationDto,
  UpdateIdentityAdminConfigurationRequest,
} from "@hoox/protocol";
import { useEffect, useState, type FormEvent } from "react";

const providerNames = Object.freeze({
  google: "Google",
  github: "GitHub",
  wechat: "微信",
  qq: "QQ",
});

type ProviderKey = keyof typeof providerNames;

type DraftProvider = {
  readonly key: ProviderKey;
  readonly enabled: boolean;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly secretConfigured: boolean;
};

function providersFrom(value: IdentityAdminConfigurationDto): readonly DraftProvider[] {
  return value.providers.map((provider) => ({ ...provider, clientSecret: "" }));
}

export function IdentityConfigurationPanel({
  value,
  busy,
  onSave,
}: {
  readonly value?: IdentityAdminConfigurationDto;
  readonly busy: boolean;
  readonly onSave: (input: UpdateIdentityAdminConfigurationRequest) => Promise<void>;
}) {
  const [emailPasswordEnabled, setEmailPasswordEnabled] = useState(true);
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [phoneEnabled, setPhoneEnabled] = useState(false);
  const [smsWebhookUrl, setSmsWebhookUrl] = useState("");
  const [smsWebhookSecret, setSmsWebhookSecret] = useState("");
  const [providers, setProviders] = useState<readonly DraftProvider[]>([]);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (value === undefined) return;
    setEmailPasswordEnabled(value.emailPasswordEnabled);
    setRegistrationEnabled(value.registrationEnabled);
    setPhoneEnabled(value.phoneEnabled);
    setSmsWebhookUrl(value.smsWebhookUrl ?? "");
    setSmsWebhookSecret("");
    setProviders(providersFrom(value));
    setReason("");
  }, [value]);

  if (value === undefined) return <p className="empty-state large">正在加载登录配置…</p>;

  const updateProvider = (key: ProviderKey, patch: Partial<DraftProvider>) => {
    setProviders((current) =>
      current.map((provider) => (provider.key === key ? { ...provider, ...patch } : provider)),
    );
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSave({
      expectedVersionToken: value.versionToken,
      emailPasswordEnabled,
      registrationEnabled,
      phoneEnabled,
      ...(smsWebhookUrl.trim() === "" ? {} : { smsWebhookUrl: smsWebhookUrl.trim() }),
      ...(smsWebhookSecret.trim() === "" ? {} : { smsWebhookSecret: smsWebhookSecret.trim() }),
      providers: providers.map(({ key, enabled, clientId, clientSecret }) => ({
        key,
        enabled,
        clientId: clientId.trim(),
        ...(clientSecret.trim() === "" ? {} : { clientSecret: clientSecret.trim() }),
      })),
      reason: reason.trim(),
    });
  };

  return (
    <section className="control-panel identity-configuration">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Embedded Better Auth</span>
          <h2>登录与注册</h2>
          <p>配置保存后立即生效；秘密值只写入服务端加密存储，界面不会回显。</p>
        </div>
        <span className="count">v{value.versionToken}</span>
      </div>
      <form className="control-form identity-form" onSubmit={submit}>
        <label className="identity-switch">
          <input
            type="checkbox"
            checked={emailPasswordEnabled}
            onChange={(event) => setEmailPasswordEnabled(event.target.checked)}
          />
          邮箱密码登录
        </label>
        <label className="identity-switch">
          <input
            type="checkbox"
            checked={registrationEnabled}
            onChange={(event) => setRegistrationEnabled(event.target.checked)}
          />
          允许新用户注册
        </label>
        <label className="identity-switch">
          <input
            type="checkbox"
            checked={phoneEnabled}
            onChange={(event) => setPhoneEnabled(event.target.checked)}
          />
          手机号验证码登录
        </label>
        <label>
          短信 Webhook URL
          <input
            type="url"
            value={smsWebhookUrl}
            placeholder="https://sms.example.com/otp"
            onChange={(event) => setSmsWebhookUrl(event.target.value)}
          />
        </label>
        <label>
          短信 Webhook 密钥
          <input
            type="password"
            value={smsWebhookSecret}
            placeholder={value.smsWebhookSecretConfigured ? "留空保留现有密钥" : "尚未配置"}
            onChange={(event) => setSmsWebhookSecret(event.target.value)}
          />
        </label>
        <div className="identity-provider-grid wide">
          {providers.map((provider) => (
            <fieldset key={provider.key}>
              <legend>{providerNames[provider.key]}</legend>
              <label className="identity-switch">
                <input
                  type="checkbox"
                  checked={provider.enabled}
                  onChange={(event) =>
                    updateProvider(provider.key, { enabled: event.target.checked })
                  }
                />
                启用
              </label>
              <label>
                Client ID
                <input
                  value={provider.clientId}
                  onChange={(event) =>
                    updateProvider(provider.key, { clientId: event.target.value })
                  }
                />
              </label>
              <label>
                Client Secret
                <input
                  type="password"
                  value={provider.clientSecret}
                  placeholder={provider.secretConfigured ? "留空保留现有密钥" : "尚未配置"}
                  onChange={(event) =>
                    updateProvider(provider.key, { clientSecret: event.target.value })
                  }
                />
              </label>
            </fieldset>
          ))}
        </div>
        <label className="wide">
          变更原因
          <textarea
            required
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <button type="submit" className="primary-button" disabled={busy || reason.trim() === ""}>
          保存并立即启用
        </button>
      </form>
    </section>
  );
}

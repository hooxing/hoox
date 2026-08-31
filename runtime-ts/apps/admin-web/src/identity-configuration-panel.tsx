import type {
  IdentityAdminConfigurationDto,
  UpdateIdentityAdminConfigurationRequest,
} from "@hoox/protocol";
import {
  CheckCircleFilled,
  KeyOutlined,
  LockOutlined,
  MailOutlined,
  MobileOutlined,
  SafetyCertificateOutlined,
  UserAddOutlined,
} from "@ant-design/icons";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

const providerMetadata = Object.freeze({
  google: {
    name: "Google",
    glyph: "G",
    description: "面向海外用户和 Google Workspace 账号",
    tone: "google",
  },
  github: {
    name: "GitHub",
    glyph: "GH",
    description: "适合开发者、团队成员和技术社区",
    tone: "github",
  },
  wechat: {
    name: "微信",
    glyph: "微",
    description: "通过微信开放平台接入中国区用户",
    tone: "wechat",
  },
  qq: {
    name: "QQ",
    glyph: "Q",
    description: "通过 QQ 互联提供快捷身份认证",
    tone: "qq",
  },
});

type ProviderKey = keyof typeof providerMetadata;

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

function Toggle({
  checked,
  label,
  onChange,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`identity-toggle${checked ? " checked" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden="true" />
    </button>
  );
}

function MethodCard({
  icon,
  title,
  description,
  checked,
  badge,
  onChange,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly checked: boolean;
  readonly badge: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <article className={`identity-method-card${checked ? " enabled" : ""}`}>
      <span className="identity-method-icon">{icon}</span>
      <span className="identity-method-copy">
        <span>
          <strong>{title}</strong>
          <small>{badge}</small>
        </span>
        <p>{description}</p>
      </span>
      <Toggle
        checked={checked}
        label={`${checked ? "关闭" : "开启"}${title}`}
        onChange={onChange}
      />
    </article>
  );
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
  const [emailVerificationEnabled, setEmailVerificationEnabled] = useState(false);
  const [emailFromAddress, setEmailFromAddress] = useState("");
  const [emailFromName, setEmailFromName] = useState("Hoox");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [smtpUsername, setSmtpUsername] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [phoneEnabled, setPhoneEnabled] = useState(false);
  const [smsWebhookUrl, setSmsWebhookUrl] = useState("");
  const [smsWebhookSecret, setSmsWebhookSecret] = useState("");
  const [providers, setProviders] = useState<readonly DraftProvider[]>([]);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (value === undefined) return;
    setEmailPasswordEnabled(value.emailPasswordEnabled);
    setEmailVerificationEnabled(value.emailVerificationEnabled);
    setEmailFromAddress(value.emailFromAddress ?? "");
    setEmailFromName(value.emailFromName ?? "Hoox");
    setSmtpHost(value.smtpHost ?? "");
    setSmtpPort(String(value.smtpPort));
    setSmtpSecure(value.smtpSecure);
    setSmtpUsername(value.smtpUsername ?? "");
    setSmtpPassword("");
    setRegistrationEnabled(value.registrationEnabled);
    setPhoneEnabled(value.phoneEnabled);
    setSmsWebhookUrl(value.smsWebhookUrl ?? "");
    setSmsWebhookSecret("");
    setProviders(providersFrom(value));
    setReason("");
  }, [value]);

  if (value === undefined) {
    return (
      <section className="identity-loading" aria-label="正在加载身份配置">
        <span className="identity-loading-mark" />
        <span>
          <strong>正在读取身份策略</strong>
          <small>连接配置存储并检查秘密状态…</small>
        </span>
      </section>
    );
  }

  const updateProvider = (key: ProviderKey, patch: Partial<DraftProvider>) => {
    setProviders((current) =>
      current.map((provider) => (provider.key === key ? { ...provider, ...patch } : provider)),
    );
  };
  const enabledProviders = providers.filter((provider) => provider.enabled).length;
  const enabledMethods = Number(emailPasswordEnabled) + Number(phoneEnabled) + enabledProviders;
  const invalidEnabledProvider = providers.some(
    (provider) =>
      provider.enabled &&
      (provider.clientId.trim() === "" ||
        (!provider.secretConfigured && provider.clientSecret.trim() === "")),
  );
  const parsedSmtpPort = Number(smtpPort);
  const emailDeliveryIncomplete =
    emailVerificationEnabled &&
    (!emailPasswordEnabled ||
      emailFromAddress.trim() === "" ||
      smtpHost.trim() === "" ||
      smtpUsername.trim() === "" ||
      (!value.smtpPasswordConfigured && smtpPassword.trim() === "") ||
      !Number.isSafeInteger(parsedSmtpPort) ||
      parsedSmtpPort < 1 ||
      parsedSmtpPort > 65_535);
  const saveDisabled =
    busy ||
    reason.trim() === "" ||
    emailDeliveryIncomplete ||
    (phoneEnabled && smsWebhookUrl.trim() === "") ||
    invalidEnabledProvider;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saveDisabled) return;
    void onSave({
      expectedVersionToken: value.versionToken,
      emailPasswordEnabled,
      emailVerificationEnabled,
      ...(emailFromAddress.trim() === "" ? {} : { emailFromAddress: emailFromAddress.trim() }),
      ...(emailFromName.trim() === "" ? {} : { emailFromName: emailFromName.trim() }),
      ...(smtpHost.trim() === "" ? {} : { smtpHost: smtpHost.trim() }),
      smtpPort: parsedSmtpPort,
      smtpSecure,
      ...(smtpUsername.trim() === "" ? {} : { smtpUsername: smtpUsername.trim() }),
      ...(smtpPassword.trim() === "" ? {} : { smtpPassword: smtpPassword.trim() }),
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
    <form className="identity-console" onSubmit={submit}>
      <section className="identity-hero">
        <div className="identity-hero-heading">
          <span className="identity-hero-icon" aria-hidden="true">
            <SafetyCertificateOutlined />
          </span>
          <div>
            <span className="eyebrow">Identity access</span>
            <h2>登录入口控制</h2>
            <p>集中管理用户如何进入 Hoox。配置发布后立即生效，秘密材料只保存在服务端。</p>
          </div>
        </div>
        <fieldset className="identity-hero-status">
          <legend className="visually-hidden">当前身份配置摘要</legend>
          <span>
            <strong>{enabledMethods}</strong>
            <small>已启用方式</small>
          </span>
          <span>
            <strong>{registrationEnabled ? "开放" : "关闭"}</strong>
            <small>新用户注册</small>
          </span>
          <span>
            <strong>v{value.versionToken}</strong>
            <small>当前版本</small>
          </span>
        </fieldset>
      </section>

      <section className="identity-section" aria-labelledby="identity-basic-title">
        <div className="identity-section-heading">
          <span className="identity-section-index">01</span>
          <div>
            <h3 id="identity-basic-title">基础访问策略</h3>
            <p>控制第一方登录入口和新账号创建范围。</p>
          </div>
        </div>
        <div className="identity-method-grid">
          <MethodCard
            icon={<MailOutlined />}
            title="邮箱密码"
            description="允许用户使用已验证邮箱和密码完成登录。"
            checked={emailPasswordEnabled}
            badge="第一方认证"
            onChange={setEmailPasswordEnabled}
          />
          <MethodCard
            icon={<SafetyCertificateOutlined />}
            title="邮箱验证码"
            description="注册及未验证账号登录时，必须通过发信邮箱发送的一次性验证码。"
            checked={emailVerificationEnabled}
            badge="账号所有权"
            onChange={setEmailVerificationEnabled}
          />
          <MethodCard
            icon={<UserAddOutlined />}
            title="开放注册"
            description="关闭后仅允许已有账号登录，不再创建新用户。"
            checked={registrationEnabled}
            badge="全局策略"
            onChange={setRegistrationEnabled}
          />
          <MethodCard
            icon={<MobileOutlined />}
            title="手机验证码"
            description="通过受控短信 Webhook 发送一次性验证码。"
            checked={phoneEnabled}
            badge="短信通道"
            onChange={setPhoneEnabled}
          />
        </div>
        <div className={`identity-mail-settings${emailVerificationEnabled ? " active" : ""}`}>
          <div className="identity-inline-heading">
            <span className="identity-inline-icon">
              <MailOutlined />
            </span>
            <span>
              <strong>发信邮箱与 SMTP</strong>
              <small>
                {emailVerificationEnabled
                  ? "邮箱验证已开启，发布前需要完整填写 SMTP 发信配置。"
                  : "可提前保存发信邮箱，开启邮箱验证码后生效。"}
              </small>
            </span>
            <span className={`identity-state${emailVerificationEnabled ? " active" : ""}`}>
              {emailVerificationEnabled ? "待发布" : "未启用"}
            </span>
          </div>
          <div className="identity-field-grid identity-mail-field-grid">
            <label>
              <span>发件人名称</span>
              <input
                value={emailFromName}
                placeholder="Hoox"
                onChange={(event) => setEmailFromName(event.target.value)}
              />
            </label>
            <label>
              <span>发件人邮箱</span>
              <input
                type="email"
                value={emailFromAddress}
                placeholder="no-reply@example.com"
                onChange={(event) => setEmailFromAddress(event.target.value)}
              />
            </label>
            <label>
              <span>SMTP 主机</span>
              <input
                value={smtpHost}
                placeholder="smtp.example.com"
                onChange={(event) => setSmtpHost(event.target.value)}
              />
            </label>
            <label>
              <span>SMTP 端口</span>
              <input
                type="number"
                min="1"
                max="65535"
                value={smtpPort}
                onChange={(event) => setSmtpPort(event.target.value)}
              />
            </label>
            <label>
              <span>SMTP 安全模式</span>
              <select
                value={smtpSecure ? "tls" : "starttls"}
                onChange={(event) => setSmtpSecure(event.target.value === "tls")}
              >
                <option value="tls">隐式 TLS（常用端口 465）</option>
                <option value="starttls">STARTTLS（常用端口 587）</option>
              </select>
            </label>
            <label>
              <span>SMTP 用户名</span>
              <input
                value={smtpUsername}
                placeholder="no-reply@example.com"
                onChange={(event) => setSmtpUsername(event.target.value)}
              />
            </label>
            <label>
              <span>SMTP 密码或授权码</span>
              <span className="identity-secret-field">
                <LockOutlined />
                <input
                  type="password"
                  value={smtpPassword}
                  placeholder={
                    value.smtpPasswordConfigured ? "已配置 · 留空保持不变" : "输入密码或授权码"
                  }
                  onChange={(event) => setSmtpPassword(event.target.value)}
                />
              </span>
              <small>密码使用现有身份根密钥加密保存，不会在页面回显。</small>
            </label>
          </div>
        </div>
        <div className={`identity-sms-settings${phoneEnabled ? " active" : ""}`}>
          <div className="identity-inline-heading">
            <span className="identity-inline-icon">
              <MobileOutlined />
            </span>
            <span>
              <strong>短信服务连接</strong>
              <small>
                {phoneEnabled
                  ? "手机号登录已开启，发布前需要填写 Webhook。"
                  : "可提前配置，开启手机号登录后生效。"}
              </small>
            </span>
            <span className={`identity-state${phoneEnabled ? " active" : ""}`}>
              {phoneEnabled ? "待发布" : "未启用"}
            </span>
          </div>
          <div className="identity-field-grid">
            <label>
              <span>Webhook URL</span>
              <input
                type="url"
                value={smsWebhookUrl}
                placeholder="https://sms.example.com/otp"
                onChange={(event) => setSmsWebhookUrl(event.target.value)}
              />
              <small>仅允许 HTTPS 服务地址。</small>
            </label>
            <label>
              <span>Webhook 密钥</span>
              <span className="identity-secret-field">
                <LockOutlined />
                <input
                  type="password"
                  value={smsWebhookSecret}
                  placeholder={
                    value.smsWebhookSecretConfigured ? "已配置 · 留空保持不变" : "输入服务密钥"
                  }
                  onChange={(event) => setSmsWebhookSecret(event.target.value)}
                />
              </span>
              <small>保存后加密写入，页面不会再次回显。</small>
            </label>
          </div>
        </div>
      </section>

      <section className="identity-section" aria-labelledby="identity-provider-title">
        <div className="identity-section-heading">
          <span className="identity-section-index">02</span>
          <div>
            <h3 id="identity-provider-title">第三方身份源</h3>
            <p>为不同用户群配置 OAuth 登录；启用项必须具备 Client ID 和 Secret。</p>
          </div>
          <span className="identity-provider-count">{enabledProviders} / 4 已启用</span>
        </div>
        <div className="identity-provider-grid">
          {providers.map((provider) => {
            const metadata = providerMetadata[provider.key];
            const ready =
              provider.clientId.trim() !== "" &&
              (provider.secretConfigured || provider.clientSecret.trim() !== "");
            return (
              <article
                key={provider.key}
                className={`identity-provider-card${provider.enabled ? " enabled" : ""}`}
                data-provider={provider.key}
              >
                <div className="identity-provider-heading">
                  <span className={`identity-provider-glyph ${metadata.tone}`}>
                    {metadata.glyph}
                  </span>
                  <span>
                    <strong>{metadata.name}</strong>
                    <small>{metadata.description}</small>
                  </span>
                  <Toggle
                    checked={provider.enabled}
                    label={`${provider.enabled ? "关闭" : "开启"}${metadata.name} 登录`}
                    onChange={(enabled) => updateProvider(provider.key, { enabled })}
                  />
                </div>
                <div className="identity-provider-fields">
                  <label>
                    <span>Client ID</span>
                    <input
                      value={provider.clientId}
                      placeholder={`${metadata.name} Client ID`}
                      onChange={(event) =>
                        updateProvider(provider.key, { clientId: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span>Client Secret</span>
                    <span className="identity-secret-field">
                      <KeyOutlined />
                      <input
                        type="password"
                        value={provider.clientSecret}
                        placeholder={
                          provider.secretConfigured ? "已配置 · 留空保持不变" : "输入 Client Secret"
                        }
                        onChange={(event) =>
                          updateProvider(provider.key, { clientSecret: event.target.value })
                        }
                      />
                    </span>
                  </label>
                </div>
                <div className={`identity-provider-readiness${ready ? " ready" : ""}`}>
                  {ready && <CheckCircleFilled />}
                  {ready ? "凭据完整，可以启用" : "填写 Client ID 和 Secret 后方可启用"}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="identity-publish-bar" aria-labelledby="identity-publish-title">
        <div>
          <span className="identity-publish-icon">
            <SafetyCertificateOutlined />
          </span>
          <span>
            <strong id="identity-publish-title">发布身份策略</strong>
            <small>每次修改都会记录管理员、原因和版本；冲突时需要刷新后重试。</small>
          </span>
        </div>
        <label>
          <span>变更原因</span>
          <input
            required
            maxLength={500}
            value={reason}
            placeholder="例如：为内部测试开放 GitHub 登录"
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <button type="submit" className="identity-publish-button" disabled={saveDisabled}>
          {busy ? "正在发布…" : "保存并立即生效"}
        </button>
      </section>
    </form>
  );
}

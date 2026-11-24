import {
  Building2,
  ChevronUp,
  LogOut,
  MailCheck,
  RefreshCw,
  ShieldCheck,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { HOOX_APP_ICON_PATH } from "./brand.js";
import { BrandLogo, BrandingFooter, useBranding } from "@hoox/ui-theme/branding";

const SESSION_STORAGE_KEY = "hoox.auth-session.v2";
export type AccountProfile = {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
};

export type AccountSession = {
  readonly profile: AccountProfile;
  readonly accessToken: string;
  readonly expiresAt: string;
};

export type IdentityProviderKey = "google" | "github" | "wechat" | "qq";
export type IdentityAuthConfiguration = {
  readonly emailPasswordEnabled: boolean;
  readonly emailVerificationEnabled: boolean;
  readonly registrationEnabled: boolean;
  readonly phoneEnabled: boolean;
  readonly providers: readonly { readonly key: IdentityProviderKey; readonly enabled: boolean }[];
};

export type AccountAccessApi = {
  registerAccount(input: {
    readonly displayName: string;
    readonly email: string;
    readonly password: string;
  }): Promise<AccountSession>;
  loginAccount(input: {
    readonly email: string;
    readonly password: string;
  }): Promise<AccountSession>;
  getIdentityConfiguration?(): Promise<IdentityAuthConfiguration>;
  signUpWithEmail?(input: {
    readonly displayName: string;
    readonly email: string;
    readonly password: string;
  }): Promise<
    | AccountSession
    | {
        readonly emailVerificationRequired: true;
        readonly emailVerificationCodeSent: boolean;
      }
  >;
  resendEmailVerificationOtp?(email: string): Promise<void>;
  verifyEmailOtp?(email: string, otp: string): Promise<AccountSession>;
  signInWithEmail?(input: {
    readonly email: string;
    readonly password: string;
  }): Promise<AccountSession>;
  beginSocialSignIn?(provider: IdentityProviderKey, callbackURL: string): Promise<string>;
  sendPhoneOtp?(phoneNumber: string): Promise<void>;
  verifyPhoneOtp?(phoneNumber: string, code: string): Promise<AccountSession>;
};

export const developmentAccount: AccountProfile = Object.freeze({
  id: "dev-user-a",
  displayName: "Hoox",
  email: "dev-user-a@local.hoox",
});

export const developmentSession: AccountSession = Object.freeze({
  profile: developmentAccount,
  accessToken: "dev-user-a",
  expiresAt: "2099-12-31T23:59:59.000Z",
});

function normalizeEmail(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function parseSession(value: string | null): AccountSession | undefined {
  if (value === null) return undefined;
  try {
    const candidate = JSON.parse(value) as {
      readonly profile?: Partial<AccountProfile>;
      readonly accessToken?: unknown;
      readonly expiresAt?: unknown;
    };
    const profile = candidate.profile;
    if (
      profile === undefined ||
      typeof profile.id !== "string" ||
      typeof profile.displayName !== "string" ||
      typeof profile.email !== "string" ||
      profile.id.trim().length === 0 ||
      profile.displayName.trim().length === 0 ||
      normalizeEmail(profile.email).length === 0 ||
      typeof candidate.accessToken !== "string" ||
      candidate.accessToken.length === 0 ||
      typeof candidate.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.expiresAt)) ||
      Date.parse(candidate.expiresAt) <= Date.now()
    ) {
      return undefined;
    }
    return {
      profile: {
        id: profile.id,
        displayName: profile.displayName.trim(),
        email: normalizeEmail(profile.email),
      },
      accessToken: candidate.accessToken,
      expiresAt: candidate.expiresAt,
    };
  } catch {
    return undefined;
  }
}

export function readAccountSession(storage: Storage): AccountSession | undefined {
  try {
    return parseSession(storage.getItem(SESSION_STORAGE_KEY));
  } catch {
    return undefined;
  }
}

export function persistAccountSession(storage: Storage, session: AccountSession): void {
  try {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // 浏览器禁用持久化时仍允许当前页面保持登录状态。
  }
}

export function clearAccountSession(storage: Storage): void {
  try {
    storage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // 浏览器禁用持久化时由 React 当前页面状态完成退出。
  }
}

function initials(displayName: string): string {
  const characters = Array.from(displayName.trim());
  return (characters[0] ?? "H").toLocaleUpperCase();
}

function accountErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function accountErrorMessage(error: unknown, mode: "login" | "register"): string {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { readonly status?: unknown }).status)
      : 0;
  if (status === 401) return "邮箱或密码不正确";
  if (status === 409) return "该邮箱已注册，请直接登录";
  if (status === 400) return "账号信息格式不正确";
  return mode === "login" ? "登录失败，请稍后重试" : "注册失败，请稍后重试";
}

export function AccountAccess({
  api,
  storage = window.localStorage,
  onAuthenticated,
}: {
  readonly api: AccountAccessApi;
  readonly storage?: Storage;
  readonly onAuthenticated: (session: AccountSession) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const { configuration: branding } = useBranding();
  const [method, setMethod] = useState<"email" | "phone">("email");
  const [configuration, setConfiguration] = useState<IdentityAuthConfiguration>({
    emailPasswordEnabled: true,
    emailVerificationEnabled: false,
    registrationEnabled: true,
    phoneEnabled: false,
    providers: [],
  });
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [emailVerificationPending, setEmailVerificationPending] = useState(false);
  const [emailVerificationCodeSent, setEmailVerificationCodeSent] = useState(false);
  const [emailVerificationCode, setEmailVerificationCode] = useState("");
  const [emailVerificationResendCooldown, setEmailVerificationResendCooldown] = useState(0);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneCodeSent, setPhoneCodeSent] = useState(false);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (emailVerificationResendCooldown <= 0) return;
    const timer = window.setInterval(() => {
      setEmailVerificationResendCooldown((seconds) => Math.max(0, seconds - 1));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [emailVerificationResendCooldown]);

  useEffect(() => {
    let active = true;
    void api
      .getIdentityConfiguration?.()
      .then((value) => {
        if (active) setConfiguration(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api]);

  const authenticate = (session: AccountSession) => {
    persistAccountSession(storage, session);
    onAuthenticated(session);
  };

  const switchMode = (nextMode: "login" | "register") => {
    setMode(nextMode);
    setMethod("email");
    setError(undefined);
    setPassword("");
    setConfirmation("");
    setEmailVerificationPending(false);
    setEmailVerificationCodeSent(false);
    setEmailVerificationCode("");
    setEmailVerificationResendCooldown(0);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    if (emailVerificationPending) {
      if (emailVerificationCode.trim().length === 0) {
        setError("请输入邮箱验证码");
        return;
      }
      if (api.verifyEmailOtp === undefined) {
        setError("邮箱验证服务不可用");
        return;
      }
      setSubmitting(true);
      try {
        authenticate(await api.verifyEmailOtp(normalizeEmail(email), emailVerificationCode.trim()));
      } catch (reason) {
        const status =
          typeof reason === "object" && reason !== null && "status" in reason
            ? Number((reason as { readonly status?: unknown }).status)
            : 0;
        setError(status === 400 ? "验证码无效或已过期" : accountErrorMessage(reason, "register"));
      } finally {
        setSubmitting(false);
      }
      return;
    }
    if (method === "phone") {
      const normalizedPhone = phoneNumber.trim();
      if (!/^\+[1-9][0-9]{7,14}$/u.test(normalizedPhone)) {
        setError("请输入带国家区号的手机号，例如 +8613800138000");
        return;
      }
      setSubmitting(true);
      try {
        if (!phoneCodeSent) {
          if (api.sendPhoneOtp === undefined) throw new Error("PHONE_AUTH_UNAVAILABLE");
          await api.sendPhoneOtp(normalizedPhone);
          setPhoneCodeSent(true);
        } else {
          if (api.verifyPhoneOtp === undefined || phoneCode.trim().length === 0) {
            setError("请输入短信验证码");
            return;
          }
          authenticate(await api.verifyPhoneOtp(normalizedPhone, phoneCode.trim()));
        }
      } catch (reason) {
        setError(accountErrorMessage(reason, "login"));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    const normalizedEmail = normalizeEmail(email);
    if (normalizedEmail.length < 3 || !normalizedEmail.includes("@")) {
      setError("请输入有效邮箱");
      return;
    }
    if (password.length < 8) {
      setError("密码至少需要 8 个字符");
      return;
    }
    if (mode === "register" && displayName.trim().length < 2) {
      setError("用户名至少需要 2 个字符");
      return;
    }
    if (mode === "register" && password !== confirmation) {
      setError("两次输入的密码不一致");
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "register") {
        const result = await (api.signUpWithEmail ?? api.registerAccount)({
          displayName: displayName.trim(),
          email: normalizedEmail,
          password,
        });
        if ("emailVerificationRequired" in result) {
          setEmailVerificationPending(true);
          setEmailVerificationCodeSent(result.emailVerificationCodeSent);
          setEmailVerificationResendCooldown(60);
          if (!result.emailVerificationCodeSent) {
            setError("账号已创建，但首次发送状态未确认；若未收到验证码，请稍后重新发送");
          }
          return;
        }
        authenticate(result);
      } else {
        authenticate(
          await (api.signInWithEmail ?? api.loginAccount)({
            email: normalizedEmail,
            password,
          }),
        );
      }
    } catch (reason) {
      const status =
        typeof reason === "object" && reason !== null && "status" in reason
          ? Number((reason as { readonly status?: unknown }).status)
          : 0;
      if (
        mode === "login" &&
        configuration.emailVerificationEnabled &&
        status === 403 &&
        accountErrorCode(reason) === "EMAIL_NOT_VERIFIED"
      ) {
        setEmailVerificationPending(true);
        setEmailVerificationCodeSent(false);
        setError("该邮箱尚未验证，请先发送并填写验证码");
      } else {
        setError(accountErrorMessage(reason, mode));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const resendEmailVerificationCode = async () => {
    if (api.resendEmailVerificationOtp === undefined) {
      setError("邮箱验证服务不可用");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await api.resendEmailVerificationOtp(normalizeEmail(email));
      setEmailVerificationCodeSent(true);
      setEmailVerificationResendCooldown(60);
    } catch (reason) {
      const status =
        typeof reason === "object" && reason !== null && "status" in reason
          ? Number((reason as { readonly status?: unknown }).status)
          : 0;
      if (status === 429) {
        setEmailVerificationResendCooldown(60);
        setError("发送过于频繁，请在倒计时结束后重试");
      } else {
        setError(accountErrorMessage(reason, "register"));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const socialSignIn = async (provider: IdentityProviderKey) => {
    if (api.beginSocialSignIn === undefined) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const callbackURL = new URL(window.location.href);
      callbackURL.searchParams.delete("error");
      window.location.assign(await api.beginSocialSignIn(provider, callbackURL.href));
    } catch (reason) {
      setError(accountErrorMessage(reason, "login"));
      setSubmitting(false);
    }
  };

  const enabledProviders = configuration.providers.filter((provider) => provider.enabled);
  return (
    <main className="account-access-shell">
      <section className="account-access-card" aria-labelledby="account-access-title">
        <BrandLogo
          showName={false}
          className="account-access-brand"
          src={HOOX_APP_ICON_PATH}
          alt=""
          aria-hidden="true"
        />
        <div className="account-access-heading">
          <span>
            {branding.productName === "Hoox"
              ? "HOOX WORKSPACE"
              : `${branding.productName} WORKSPACE`}
          </span>
          <h1 id="account-access-title">{mode === "login" ? "欢迎回来" : "创建你的账号"}</h1>
          <p>{mode === "login" ? "登录后继续处理你的任务。" : "注册后会创建独立的个人空间。"}</p>
        </div>
        <div className="account-access-tabs" role="tablist" aria-label="账号操作">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            onClick={() => switchMode("login")}
          >
            登录
          </button>
          {configuration.registrationEnabled && configuration.emailPasswordEnabled && (
            <button
              type="button"
              role="tab"
              aria-selected={mode === "register"}
              onClick={() => switchMode("register")}
            >
              注册
            </button>
          )}
        </div>
        {mode === "login" && configuration.phoneEnabled && (
          <div className="account-access-methods">
            <button
              type="button"
              className={method === "email" ? "active" : ""}
              onClick={() => setMethod("email")}
            >
              邮箱
            </button>
            <button
              type="button"
              className={method === "phone" ? "active" : ""}
              onClick={() => setMethod("phone")}
            >
              手机号
            </button>
          </div>
        )}
        {method === "email" && configuration.emailPasswordEnabled ? (
          <form className="account-access-form" onSubmit={(event) => void submit(event)}>
            {emailVerificationPending ? (
              <>
                <div className="account-email-verification-status" aria-live="polite">
                  <span aria-hidden="true">
                    <MailCheck size={20} />
                  </span>
                  <div>
                    <strong>查收邮箱验证码</strong>
                    <p>
                      {emailVerificationCodeSent ? "验证码已发送至" : "账号正在等待验证"}
                      <b>{normalizeEmail(email)}</b>
                    </p>
                  </div>
                </div>
                <label className="account-email-otp-field">
                  邮箱验证码
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    pattern="[0-9]{6}"
                    value={emailVerificationCode}
                    onChange={(event) =>
                      setEmailVerificationCode(
                        event.target.value.replace(/[^0-9]/gu, "").slice(0, 6),
                      )
                    }
                    placeholder="请输入 6 位验证码"
                  />
                </label>
              </>
            ) : (
              <>
                {mode === "register" && (
                  <label>
                    用户名
                    <input
                      autoComplete="name"
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      placeholder="你的名字"
                    />
                  </label>
                )}
                <label>
                  邮箱
                  <input
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="name@example.com"
                  />
                </label>
                <label>
                  密码
                  <input
                    type="password"
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="至少 8 个字符"
                  />
                </label>
                {mode === "register" && (
                  <label>
                    确认密码
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                      placeholder="再次输入密码"
                    />
                  </label>
                )}
              </>
            )}
            {error !== undefined && (
              <div className="account-access-error" role="alert">
                {error}
              </div>
            )}
            <button className="account-access-submit" type="submit" disabled={submitting}>
              {submitting
                ? "请稍候…"
                : emailVerificationPending
                  ? "验证并登录"
                  : mode === "login"
                    ? "登录"
                    : "创建账号"}
            </button>
            {emailVerificationPending && (
              <div className="account-email-verification-actions">
                <button
                  type="button"
                  className="account-access-secondary"
                  disabled={submitting || emailVerificationResendCooldown > 0}
                  onClick={() => void resendEmailVerificationCode()}
                >
                  <RefreshCw size={15} />
                  {emailVerificationResendCooldown > 0
                    ? `${emailVerificationResendCooldown} 秒后可重新发送`
                    : emailVerificationCodeSent
                      ? "重新发送验证码"
                      : "发送验证码"}
                </button>
                <small>验证码 10 分钟内有效；服务端与页面均限制发送频率，请勿重复点击。</small>
              </div>
            )}
          </form>
        ) : method === "phone" && configuration.phoneEnabled ? (
          <form className="account-access-form" onSubmit={(event) => void submit(event)}>
            <label>
              手机号
              <input
                type="tel"
                autoComplete="tel"
                value={phoneNumber}
                onChange={(event) => setPhoneNumber(event.target.value)}
                placeholder="+8613800138000"
              />
            </label>
            {phoneCodeSent && (
              <label>
                短信验证码
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={phoneCode}
                  onChange={(event) => setPhoneCode(event.target.value)}
                />
              </label>
            )}
            {error !== undefined && (
              <div className="account-access-error" role="alert">
                {error}
              </div>
            )}
            <button className="account-access-submit" type="submit" disabled={submitting}>
              {submitting ? "请稍候…" : phoneCodeSent ? "验证并登录" : "发送验证码"}
            </button>
          </form>
        ) : (
          <p className="empty-state">管理员尚未启用此登录方式。</p>
        )}
        {mode === "login" && enabledProviders.length > 0 && (
          <div className="account-social-providers">
            <span>或使用第三方账号</span>
            {enabledProviders.map((provider) => (
              <button
                key={provider.key}
                type="button"
                disabled={submitting}
                onClick={() => void socialSignIn(provider.key)}
              >
                {provider.key === "google"
                  ? "Google"
                  : provider.key === "github"
                    ? "GitHub"
                    : provider.key === "wechat"
                      ? "微信"
                      : "QQ"}
              </button>
            ))}
          </div>
        )}
        {mode === "login" && api.getIdentityConfiguration === undefined && (
          <button
            className="development-account-button"
            type="button"
            onClick={() => authenticate(developmentSession)}
          >
            <ShieldCheck size={16} />
            使用本地开发身份继续
          </button>
        )}
        <small>
          认证由 {branding.productName} 内嵌身份模块处理；浏览器只保存 {branding.productName}{" "}
          会话令牌。
        </small>
        <BrandingFooter />
      </section>
    </main>
  );
}

export function AccountMenu({
  profile,
  activeTeamName,
  canManageActiveTeam,
  onOpenTeamCenter,
  onOpenTeamManagement,
  onSignOut,
  navigationReturnFocusRef,
}: {
  readonly profile: AccountProfile;
  readonly activeTeamName?: string;
  readonly canManageActiveTeam: boolean;
  readonly onOpenTeamCenter?: () => void;
  readonly onOpenTeamManagement?: () => void;
  readonly onSignOut: () => void;
  readonly navigationReturnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        rootRef.current?.querySelector<HTMLButtonElement>(".account-menu-trigger")?.focus();
      }
    };
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [open]);

  const runAction = (action: (() => void) | undefined) => {
    setOpen(false);
    action?.();
  };

  return (
    <div className="account-menu" ref={rootRef}>
      {open && (
        <section className="account-menu-popover" id={menuId} aria-label="用户设置菜单">
          <header>
            <span className="account-avatar large" aria-hidden="true">
              {initials(profile.displayName)}
            </span>
            <span>
              <strong>{profile.displayName}</strong>
              <small>{profile.email}</small>
            </span>
            <button
              type="button"
              className="account-menu-close"
              aria-label="关闭用户设置菜单"
              onClick={() => setOpen(false)}
            >
              <X size={15} />
            </button>
          </header>
          {onOpenTeamCenter !== undefined && (
            <div className="account-menu-section">
              <span>团队</span>
              <button type="button" onClick={() => runAction(onOpenTeamCenter)}>
                <UsersRound size={17} />
                <span>
                  <strong>团队中心</strong>
                  <small>新建、加入和切换团队</small>
                </span>
              </button>
              <button
                type="button"
                disabled={!canManageActiveTeam || onOpenTeamManagement === undefined}
                onClick={() => runAction(onOpenTeamManagement)}
              >
                <Building2 size={17} />
                <span>
                  <strong>管理当前团队</strong>
                  <small>{activeTeamName ?? "请先选择一个团队"}</small>
                </span>
              </button>
            </div>
          )}
          <div className="account-menu-section account-menu-session">
            <button type="button" onClick={() => runAction(onSignOut)}>
              <LogOut size={17} />
              <span>
                <strong>退出登录</strong>
                <small>返回登录与注册页面</small>
              </span>
            </button>
          </div>
        </section>
      )}
      <button
        type="button"
        className="account-menu-trigger"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        ref={navigationReturnFocusRef}
      >
        <span className="account-avatar" aria-hidden="true">
          {initials(profile.displayName)}
        </span>
        <span className="account-menu-copy">
          <strong>{profile.displayName}</strong>
          <small>{profile.email}</small>
        </span>
        {open ? <ChevronUp size={16} /> : <UserRound size={16} />}
      </button>
    </div>
  );
}

import { Building2, ChevronUp, LogOut, ShieldCheck, UserRound, UsersRound, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";

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
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const authenticate = (session: AccountSession) => {
    persistAccountSession(storage, session);
    onAuthenticated(session);
  };

  const switchMode = (nextMode: "login" | "register") => {
    setMode(nextMode);
    setError(undefined);
    setPassword("");
    setConfirmation("");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
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
      const session =
        mode === "register"
          ? await api.registerAccount({
              displayName: displayName.trim(),
              email: normalizedEmail,
              password,
            })
          : await api.loginAccount({ email: normalizedEmail, password });
      authenticate(session);
    } catch (reason) {
      setError(accountErrorMessage(reason, mode));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="account-access-shell">
      <section className="account-access-card" aria-labelledby="account-access-title">
        <div className="account-access-brand" aria-hidden="true">
          H
        </div>
        <div className="account-access-heading">
          <span>HOOX WORKSPACE</span>
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
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            onClick={() => switchMode("register")}
          >
            注册
          </button>
        </div>
        <form className="account-access-form" onSubmit={(event) => void submit(event)}>
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
          {error !== undefined && (
            <div className="account-access-error" role="alert">
              {error}
            </div>
          )}
          <button className="account-access-submit" type="submit" disabled={submitting}>
            {submitting ? "请稍候…" : mode === "login" ? "登录" : "创建账号"}
          </button>
        </form>
        {mode === "login" && (
          <button
            className="development-account-button"
            type="button"
            onClick={() => authenticate(developmentSession)}
          >
            <ShieldCheck size={16} />
            使用本地开发身份继续
          </button>
        )}
        <small>账号和任务保存在本地开发后端；浏览器只保存会话令牌。</small>
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

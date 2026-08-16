import { Building2, ChevronUp, LogOut, ShieldCheck, UserRound, UsersRound, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";

const ACCOUNT_STORAGE_KEY = "hoox.local-account.v1";
const SESSION_STORAGE_KEY = "hoox.local-session.v1";
export type AccountProfile = {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
};

type StoredAccount = AccountProfile & {
  readonly passwordDigest: string;
  readonly passwordSalt: string;
};

export const developmentAccount: AccountProfile = Object.freeze({
  id: "dev-user-a",
  displayName: "Hoox",
  email: "dev-user-a@local.hoox",
});

function normalizeEmail(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function parseProfile(value: string | null): AccountProfile | undefined {
  if (value === null) return undefined;
  try {
    const candidate = JSON.parse(value) as Partial<AccountProfile>;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.displayName !== "string" ||
      typeof candidate.email !== "string" ||
      candidate.id.trim().length === 0 ||
      candidate.displayName.trim().length === 0 ||
      normalizeEmail(candidate.email).length === 0
    ) {
      return undefined;
    }
    return {
      id: candidate.id,
      displayName: candidate.displayName.trim(),
      email: normalizeEmail(candidate.email),
    };
  } catch {
    return undefined;
  }
}

function parseStoredAccount(value: string | null): StoredAccount | undefined {
  const profile = parseProfile(value);
  if (profile === undefined || value === null) return undefined;
  try {
    const candidate = JSON.parse(value) as Partial<StoredAccount>;
    if (
      typeof candidate.passwordDigest !== "string" ||
      candidate.passwordDigest.length === 0 ||
      typeof candidate.passwordSalt !== "string" ||
      candidate.passwordSalt.length === 0
    ) {
      return undefined;
    }
    return {
      ...profile,
      passwordDigest: candidate.passwordDigest,
      passwordSalt: candidate.passwordSalt,
    };
  } catch {
    return undefined;
  }
}

export function readAccountSession(storage: Storage): AccountProfile | undefined {
  try {
    return parseProfile(storage.getItem(SESSION_STORAGE_KEY));
  } catch {
    return undefined;
  }
}

export function persistAccountSession(storage: Storage, profile: AccountProfile): void {
  try {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(profile));
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

function readStoredAccount(storage: Storage): StoredAccount | undefined {
  try {
    return parseStoredAccount(storage.getItem(ACCOUNT_STORAGE_KEY));
  } catch {
    return undefined;
  }
}

function persistStoredAccount(storage: Storage, account: StoredAccount): void {
  storage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(account));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function derivePasswordDigest(password: string, salt: Uint8Array): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const saltBuffer = Uint8Array.from(salt).buffer;
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBuffer, iterations: 120_000 },
    material,
    256,
  );
  return bytesToBase64Url(new Uint8Array(bits));
}

function initials(displayName: string): string {
  const characters = Array.from(displayName.trim());
  return (characters[0] ?? "H").toLocaleUpperCase();
}

export function AccountAccess({
  storage = window.localStorage,
  onAuthenticated,
}: {
  readonly storage?: Storage;
  readonly onAuthenticated: (profile: AccountProfile) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string>();

  const authenticate = (profile: AccountProfile) => {
    persistAccountSession(storage, profile);
    onAuthenticated(profile);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || password.length < 6) {
      setError("请输入有效邮箱，密码至少 6 位。");
      return;
    }
    if (mode === "login") {
      const account = readStoredAccount(storage);
      const passwordMatches =
        account !== undefined &&
        account.email === normalizedEmail &&
        (await derivePasswordDigest(password, base64UrlToBytes(account.passwordSalt))) ===
          account.passwordDigest;
      if (!passwordMatches || account === undefined) {
        setError("账号或密码不正确。若尚未创建本机账号，请先注册。");
        return;
      }
      setError(undefined);
      authenticate(account);
      return;
    }
    const normalizedName = displayName.trim();
    if (normalizedName.length < 2 || normalizedName.length > 32) {
      setError("用户名需要 2 至 32 个字符。");
      return;
    }
    if (password !== confirmation) {
      setError("两次输入的密码不一致。");
      return;
    }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const account: StoredAccount = {
      id: `local-${crypto.randomUUID()}`,
      displayName: normalizedName,
      email: normalizedEmail,
      passwordDigest: await derivePasswordDigest(password, salt),
      passwordSalt: bytesToBase64Url(salt),
    };
    try {
      persistStoredAccount(storage, account);
    } catch {
      setError("浏览器未允许保存账号信息，请检查隐私或存储设置。");
      return;
    }
    setError(undefined);
    authenticate(account);
  };

  return (
    <main className="account-access-shell">
      <section className="account-access-card" aria-labelledby="account-access-title">
        <div className="account-access-brand" aria-hidden="true">
          H
        </div>
        <div className="account-access-heading">
          <span>Hoox</span>
          <h1 id="account-access-title">{mode === "login" ? "欢迎回来" : "创建你的账号"}</h1>
          <p>
            {mode === "login"
              ? "登录后继续处理任务、文件和团队协作。"
              : "完成注册后，用户信息会显示在会话导航底部。"}
          </p>
        </div>
        <div className="account-access-tabs" role="tablist" aria-label="账号操作">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            onClick={() => {
              setMode("login");
              setError(undefined);
            }}
          >
            登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            onClick={() => {
              setMode("register");
              setError(undefined);
            }}
          >
            注册
          </button>
        </div>
        <form className="account-access-form" onSubmit={(event) => void submit(event)}>
          {mode === "register" && (
            <label>
              <span>用户名</span>
              <input
                autoComplete="name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="例如：林晓"
              />
            </label>
          )}
          <label>
            <span>邮箱</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@example.com"
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="至少 6 位"
            />
          </label>
          {mode === "register" && (
            <label>
              <span>确认密码</span>
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
          <button className="account-access-submit" type="submit">
            {mode === "login" ? "登录" : "创建账号"}
          </button>
        </form>
        {mode === "login" && (
          <button
            className="development-account-button"
            type="button"
            onClick={() => authenticate(developmentAccount)}
          >
            <ShieldCheck size={16} />
            使用本地开发身份继续
          </button>
        )}
        <small>本地工作台账号仅保存在当前浏览器，不会上传密码。</small>
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

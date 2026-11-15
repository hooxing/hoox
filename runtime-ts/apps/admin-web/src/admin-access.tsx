import { useEffect, useState, type FormEvent, type ReactNode } from "react";

type InstallationStatus = { initialized: boolean; setupTokenRequired: boolean };
const sessionKey = "hoox.auth-session.v2";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...init, cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? "邮箱、密码或安装令牌不正确，或当前账号没有管理员权限。"
        : response.status === 409
          ? "该实例已完成初始化，请刷新后登录。"
          : "服务暂时不可用，请检查连接后重试。",
    );
  }
  const payload = (await response.json()) as { data: T };
  return payload.data;
}

export function AdminAccessGate({ children }: { readonly children: ReactNode }) {
  const [status, setStatus] = useState<InstallationStatus>();
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload 是用户显式重试安装状态请求的触发器。
  useEffect(() => {
    let active = true;
    setError("");
    void (async () => {
      const installation = await request<InstallationStatus>("/v1/installation");
      if (!active) return;
      setStatus(installation);
      const raw = localStorage.getItem(sessionKey);
      if (raw === null || !installation.initialized) return;
      try {
        const session = JSON.parse(raw) as { accessToken?: string };
        if (typeof session.accessToken !== "string") return;
        await request("/v1/auth/admin-principal", {
          headers: { authorization: `Bearer ${session.accessToken}` },
        });
        if (active) setAuthenticated(true);
      } catch {
        if (active) localStorage.removeItem(sessionKey);
      }
    })().catch(() => {
      if (active) setError("无法连接初始化服务，请确认 API 已启动。");
    });
    return () => {
      active = false;
    };
  }, [reload]);

  if (authenticated) return children;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === undefined || busy) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));
    if (!status.initialized && password !== form.get("confirmation")) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const session = await request<{ accessToken: string; expiresAt: string }>(
        status.initialized ? "/v1/installation/login" : "/v1/installation/administrator",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(status.setupTokenRequired
              ? { "x-hoox-setup-token": String(form.get("setupToken")) }
              : {}),
          },
          body: JSON.stringify({
            email: String(form.get("email")),
            password,
            ...(!status.initialized ? { displayName: "管理员" } : {}),
          }),
        },
      );
      localStorage.setItem(sessionKey, JSON.stringify(session));
      if (!status.initialized) window.location.assign(`${import.meta.env.BASE_URL}models?setup=1`);
      else setAuthenticated(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="installation-page">
      <section className="installation-card" aria-labelledby="installation-title">
        <a className="installation-brand" href="/">
          Hoox
        </a>
        <p className="installation-eyebrow">
          {status?.initialized ? "管理控制台" : "首次运行 · 1 / 2"}
        </p>
        <h1 id="installation-title">
          {status === undefined
            ? "正在连接服务"
            : status.initialized
              ? "管理员登录"
              : "欢迎使用 Hoox"}
        </h1>
        <p className="installation-description">
          {status?.initialized
            ? "使用管理员邮箱和密码登录。"
            : "先创建管理员账号，再连接你的线上模型。"}
        </p>
        {status !== undefined && (
          <form
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            {status.setupTokenRequired && !status.initialized && (
              <label>
                安装令牌
                <input
                  name="setupToken"
                  type="password"
                  required
                  autoComplete="off"
                  minLength={32}
                />
                <small>填写部署环境中的 INSTALLATION_SETUP_TOKEN。</small>
              </label>
            )}
            <label>
              管理员邮箱
              <input name="email" type="email" required autoComplete="username" maxLength={254} />
            </label>
            <label>
              密码
              <input
                name="password"
                type="password"
                required
                minLength={8}
                maxLength={128}
                autoComplete={status.initialized ? "current-password" : "new-password"}
              />
            </label>
            {!status.initialized && (
              <label>
                确认密码
                <input
                  name="confirmation"
                  type="password"
                  required
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                />
              </label>
            )}
            {error && (
              <p role="alert" className="installation-error">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy}>
              {busy ? "正在处理…" : status.initialized ? "登录" : "创建管理员并继续"}
            </button>
          </form>
        )}
        {status === undefined &&
          (error ? (
            <>
              <p role="alert" className="installation-error">
                {error}
              </p>
              <button type="button" onClick={() => setReload(reload + 1)}>
                重新连接
              </button>
            </>
          ) : (
            <p role="status">正在检查安装状态…</p>
          ))}
        {!status?.initialized && (
          <p className="installation-note">账号保存在当前实例中。模型可稍后配置。</p>
        )}
        {status?.initialized && (
          <p className="installation-note">
            <a href="/app">使用工作台的其他登录方式</a>
          </p>
        )}
      </section>
    </main>
  );
}

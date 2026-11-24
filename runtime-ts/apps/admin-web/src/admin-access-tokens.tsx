import { useCallback, useEffect, useState } from "react";
import type { AdminAccessTokenApiContract, AdminAccessTokenDto } from "./control-api.js";

function date(value: string | null): string {
  if (value === null) return "从未使用";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "—" : parsed.toLocaleString("zh-CN", { hour12: false });
}

export function AdminAccessTokensPage({ api }: { readonly api: AdminAccessTokenApiContract }) {
  const [tokens, setTokens] = useState<readonly AdminAccessTokenDto[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [name, setName] = useState("");
  const [read, setRead] = useState(true);
  const [write, setWrite] = useState(false);
  const [expiryDays, setExpiryDays] = useState("90");
  const [oneTimeToken, setOneTimeToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    try {
      setTokens(await api.listAccessTokens());
    } catch {
      setError("无法读取后台访问令牌。");
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const expirations = tokens
      .filter((token) => token.revokedAt === null)
      .map((token) => Date.parse(token.expiresAt))
      .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > now);
    if (expirations.length === 0) return;
    const nextExpiration = Math.min(...expirations);
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(1, Math.min(nextExpiration - now, 60_000)),
    );
    return () => clearTimeout(timer);
  }, [now, tokens]);

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || (!read && !write)) return;
    setBusy(true);
    setError("");
    try {
      const scopes = [
        ...(read || write ? (["agent-config:read"] as const) : []),
        ...(write ? (["agent-config:write"] as const) : []),
      ];
      const result = await api.createAccessToken({
        name: name.trim(),
        scopes,
        expiresAt: new Date(Date.now() + Number(expiryDays) * 86_400_000).toISOString(),
      });
      setOneTimeToken(result.token);
      setName("");
      await reload();
    } catch {
      setError("令牌创建失败，请检查名称和权限后重试。");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: AdminAccessTokenDto) => {
    if (busy || token.revokedAt !== null || !window.confirm(`撤销“${token.name}”？`)) return;
    setBusy(true);
    setError("");
    try {
      await api.revokeAccessToken(token.id);
      await reload();
    } catch {
      setError("令牌撤销失败，请刷新后重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="admin-access-tokens" aria-labelledby="admin-access-tokens-title">
      <header>
        <p className="eyebrow">系统安全</p>
        <h1 id="admin-access-tokens-title">后台访问令牌</h1>
        <p>令牌以创建者身份执行，并在每次请求时检查当前后台权限。</p>
      </header>
      <form onSubmit={(event) => void create(event)}>
        <label>
          名称
          <input
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <fieldset>
          <legend>作用域</legend>
          <label>
            <input
              type="checkbox"
              checked={read}
              onChange={(event) => setRead(event.target.checked)}
            />
            Agent 配置读取
          </label>
          <label>
            <input
              type="checkbox"
              checked={write}
              onChange={(event) => setWrite(event.target.checked)}
            />
            Agent 配置写入（包含读取）
          </label>
        </fieldset>
        <label>
          有效期
          <select value={expiryDays} onChange={(event) => setExpiryDays(event.target.value)}>
            <option value="7">7 天</option>
            <option value="30">30 天</option>
            <option value="60">60 天</option>
            <option value="90">90 天（默认）</option>
          </select>
        </label>
        <button type="submit" disabled={busy || (!read && !write)}>
          创建令牌
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {oneTimeToken && (
        <section role="dialog" aria-modal="true" aria-labelledby="one-time-token-title">
          <h2 id="one-time-token-title">请立即复制令牌</h2>
          <p>明文只显示这一次。关闭后无法再次查看。</p>
          <code>{oneTimeToken}</code>
          <button type="button" onClick={() => setOneTimeToken("")}>
            我已保存，关闭
          </button>
        </section>
      )}
      <div className="admin-access-token-table">
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>作用域</th>
              <th>创建者</th>
              <th>创建时间</th>
              <th>最后使用</th>
              <th>过期时间</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((token) => (
              <tr key={token.id}>
                <td>{token.name}</td>
                <td>{token.scopes.join(", ")}</td>
                <td>{token.createdBy}</td>
                <td>{date(token.createdAt)}</td>
                <td>{date(token.lastUsedAt)}</td>
                <td>{date(token.expiresAt)}</td>
                <td>
                  {token.revokedAt !== null
                    ? "已撤销"
                    : Date.parse(token.expiresAt) <= now
                      ? "已过期"
                      : "有效"}
                </td>
                <td>
                  <button
                    type="button"
                    disabled={
                      busy || token.revokedAt !== null || Date.parse(token.expiresAt) <= now
                    }
                    onClick={() => void revoke(token)}
                  >
                    撤销
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

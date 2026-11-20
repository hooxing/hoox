import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, type ApiKey, type ApiKeyScope, type RuntimeApi } from "./api.js";

const scopes: readonly { readonly id: ApiKeyScope; readonly label: string }[] = [
  { id: "threads:read", label: "读取 Thread" },
  { id: "runs:read", label: "读取 Run" },
  { id: "threads:create", label: "创建 Thread" },
  { id: "runs:create", label: "创建 Run" },
  { id: "tool-results:submit", label: "提交工具结果" },
  { id: "webhooks:manage", label: "管理 Webhook" },
];

export function ApiKeyManager({
  api,
  onClose,
}: {
  readonly api: Pick<RuntimeApi, "listApiKeys" | "createApiKey" | "revokeApiKey">;
  readonly onClose: () => void;
}) {
  const [items, setItems] = useState<readonly ApiKey[]>([]);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [expires, setExpires] = useState("");
  const [selected, setSelected] = useState<readonly ApiKeyScope[]>(["threads:read", "runs:read"]);
  const [newToken, setNewToken] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const refresh = useCallback(
    () => api.listApiKeys().then(({ items: next }) => setItems(next)),
    [api],
  );

  useEffect(() => {
    void refresh().catch(() => setError("无法加载 API Key。"));
  }, [refresh]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.createApiKey({
        name,
        ...(note.trim() ? { note: note.trim() } : {}),
        scopes: selected,
        ...(expires ? { expiresAt: new Date(`${expires}T23:59:59.999Z`).toISOString() } : {}),
      });
      setNewToken(result.token);
      setCopied(false);
      setName("");
      setNote("");
      await refresh();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法创建 API Key。");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: ApiKey) {
    setBusy(true);
    setError(undefined);
    try {
      await api.revokeApiKey(key.id);
      await refresh();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法吊销 API Key。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="api-key-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="api-key-title"
    >
      <header>
        <div>
          <h2 id="api-key-title">API Key</h2>
          <p>服务凭据仅在创建时展示一次；请立即复制并妥善保存。</p>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭 API Key 管理">
          关闭
        </button>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {newToken && (
        <div className="api-key-once">
          <strong>请立即复制新 Key，此后无法再次查看。</strong>
          <code>{newToken}</code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                .writeText(newToken)
                .then(() => setCopied(true))
                .catch(() => setError("复制失败，请手动选中并复制 Key。"));
            }}
          >
            {copied ? "已复制" : "复制 Key"}
          </button>
          <button type="button" onClick={() => setNewToken(undefined)}>
            已保存，关闭
          </button>
        </div>
      )}
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
        <label>
          备注（可选）
          <input maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        <label>
          到期日（可选）
          <input type="date" value={expires} onChange={(event) => setExpires(event.target.value)} />
        </label>
        <fieldset>
          <legend>作用域</legend>
          {scopes.map((scope) => (
            <label key={scope.id}>
              <input
                type="checkbox"
                checked={selected.includes(scope.id)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, scope.id]
                      : current.filter((value) => value !== scope.id),
                  )
                }
              />
              {scope.label}
            </label>
          ))}
        </fieldset>
        <button type="submit" disabled={busy || name.trim().length === 0 || selected.length === 0}>
          创建 API Key
        </button>
      </form>
      <ul>
        {items.map((key) => (
          <li key={key.id}>
            <div>
              <strong>{key.name}</strong>
              <code>{key.prefix}…</code>
              <span>{key.scopes.join(", ")}</span>
              {key.revokedAt && <small>已吊销</small>}
            </div>
            {!key.revokedAt && (
              <button type="button" disabled={busy} onClick={() => void revoke(key)}>
                吊销
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

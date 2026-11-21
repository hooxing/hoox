import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, type RuntimeApi, type TenantWebhook, type WebhookEventType } from "./api.js";
const eventOptions: readonly { id: WebhookEventType; label: string }[] = [
  { id: "run.waiting", label: "Run 等待" },
  { id: "run.requires_action", label: "客户端工具需要操作" },
  { id: "run.succeeded", label: "Run 成功" },
  { id: "run.failed", label: "Run 失败" },
  { id: "run.cancelled", label: "Run 取消" },
  { id: "artifact.published", label: "Artifact 发布" },
];
export function WebhookManager({
  api,
  tenantId,
  onClose,
}: {
  readonly api: Pick<
    RuntimeApi,
    "listWebhooks" | "createWebhook" | "rotateWebhookSecret" | "disableWebhook" | "deleteWebhook"
  >;
  readonly tenantId: string | null;
  readonly onClose: () => void;
}) {
  const [items, setItems] = useState<readonly TenantWebhook[]>([]);
  const [name, setName] = useState("");
  const [endpointUrl, setEndpoint] = useState("");
  const [selected, setSelected] = useState<readonly WebhookEventType[]>([
    "run.succeeded",
    "run.failed",
  ]);
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const requestScope = useRef({ active: false });
  useEffect(() => {
    // 每次激活独占作用域，防止 StrictMode 重建后旧请求重新获得状态写入资格。
    const scope = { active: true };
    requestScope.current = scope;
    return () => {
      scope.active = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    const scope = requestScope.current;
    const result = await api.listWebhooks(tenantId);
    if (scope.active) setItems(result.items);
  }, [api, tenantId]);
  useEffect(() => {
    const scope = requestScope.current;
    void refresh().catch(() => {
      if (scope.active) setError("无法加载 Webhook。");
    });
  }, [refresh]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const scope = requestScope.current;
    try {
      const result = await api.createWebhook({ name, endpointUrl, eventTypes: selected }, tenantId);
      if (!scope.active) return;
      setSecret(result.secret);
      setName("");
      setEndpoint("");
      await refresh();
    } catch (reason) {
      if (scope.active)
        setError(reason instanceof ApiError ? reason.message : "无法创建 Webhook。");
    } finally {
      if (scope.active) setBusy(false);
    }
  }
  async function run(action: () => Promise<string | undefined>) {
    setBusy(true);
    setError(undefined);
    const scope = requestScope.current;
    try {
      const result = await action();
      if (!scope.active) return;
      if (result !== undefined) setSecret(result);
      await refresh();
    } catch (reason) {
      if (scope.active)
        setError(reason instanceof ApiError ? reason.message : "Webhook 操作失败。");
    } finally {
      if (scope.active) setBusy(false);
    }
  }
  async function copySecret(value: string) {
    const scope = requestScope.current;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      if (scope.active) setError("复制失败，请手动复制。");
    }
  }
  return (
    <section
      className="api-key-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="webhook-title"
    >
      <header>
        <div>
          <h2 id="webhook-title">Webhook</h2>
          <p>接收 Tenant 事件；新签名密钥只显示一次。</p>
        </div>
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {secret && (
        <div className="api-key-once">
          <strong>请立即复制签名密钥，此后无法再次查看。</strong>
          <code>{secret}</code>
          <button type="button" onClick={() => void copySecret(secret)}>
            复制密钥
          </button>
          <button type="button" onClick={() => setSecret(undefined)}>
            完成
          </button>
        </div>
      )}
      <form onSubmit={(event) => void submit(event)}>
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
          HTTPS 地址
          <input
            required
            type="url"
            placeholder="https://example.com/hooks/hoox"
            value={endpointUrl}
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </label>
        <fieldset>
          <legend>订阅事件</legend>
          {eventOptions.map((option) => (
            <label key={option.id}>
              <input
                type="checkbox"
                checked={selected.includes(option.id)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, option.id]
                      : current.filter((value) => value !== option.id),
                  )
                }
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <button type="submit" disabled={busy || selected.length === 0}>
          创建 Webhook
        </button>
      </form>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <code>{item.endpointUrl}</code>
              <span>{item.eventTypes.join(" · ")}</span>
              {item.disabledReason && <span role="status">已停用：{item.disabledReason}</span>}
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => (await api.rotateWebhookSecret(item.id, tenantId)).secret)
              }
            >
              轮换密钥
            </button>
            {!item.disabledAt && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.disableWebhook(item.id, tenantId);
                    return undefined;
                  })
                }
              >
                停用
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api.deleteWebhook(item.id, tenantId);
                  return undefined;
                })
              }
            >
              删除
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

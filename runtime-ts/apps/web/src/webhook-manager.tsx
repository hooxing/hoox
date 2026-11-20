import { useCallback, useEffect, useState, type FormEvent } from "react";
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
  onClose,
}: {
  readonly api: Pick<
    RuntimeApi,
    "listWebhooks" | "createWebhook" | "rotateWebhookSecret" | "disableWebhook" | "deleteWebhook"
  >;
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
  const refresh = useCallback(async () => setItems((await api.listWebhooks()).items), [api]);
  useEffect(() => {
    void refresh().catch(() => setError("无法加载 Webhook。"));
  }, [refresh]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.createWebhook({ name, endpointUrl, eventTypes: selected });
      setSecret(result.secret);
      setName("");
      setEndpoint("");
      await refresh();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法创建 Webhook。");
    } finally {
      setBusy(false);
    }
  }
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      await refresh();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Webhook 操作失败。");
    } finally {
      setBusy(false);
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
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard
                .writeText(secret)
                .catch(() => setError("复制失败，请手动复制。"))
            }
          >
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
                void run(async () => setSecret((await api.rotateWebhookSecret(item.id)).secret))
              }
            >
              轮换密钥
            </button>
            {!item.disabledAt && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => api.disableWebhook(item.id))}
              >
                停用
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => api.deleteWebhook(item.id))}
            >
              删除
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

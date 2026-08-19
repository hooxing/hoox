import type {
  AdminControlOverviewDto,
  ControlAuditEventDto,
  MemoryProviderRevisionDto,
  ModelProviderRevisionDto,
  RuntimeSettingsRevisionDto,
} from "@hoox/protocol";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { AdminApiError } from "./api.js";
import { AdminControlApi, type AdminControlApiContract } from "./control-api.js";

export type ControlView = "overview" | "models" | "memory" | "settings";
const defaultControlApi = new AdminControlApi();

function number(form: FormData, key: string): number {
  return Number(form.get(key));
}

function value(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

function errorMessage(reason: unknown): string {
  return reason instanceof AdminApiError ? reason.message : "操作未完成，请刷新后重试。";
}

function RevisionActions({
  kind,
  providerKey,
  revision,
  versionToken,
  probe,
  busy,
  onAction,
}: {
  readonly kind: "model-providers" | "memory-providers" | "runtime-settings";
  readonly providerKey: string;
  readonly revision: number;
  readonly versionToken: number;
  readonly probe: boolean;
  readonly busy: boolean;
  readonly onAction: (
    action: "probe" | "publish",
    input: { readonly expectedVersionToken: number; readonly reason: string },
  ) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="revision-actions">
      <input
        aria-label={`${providerKey} 变更原因`}
        value={reason}
        maxLength={500}
        placeholder="填写探测或发布原因"
        onChange={(event) => setReason(event.target.value)}
      />
      {probe && (
        <button
          type="button"
          className="quiet-button"
          disabled={busy || reason.trim().length === 0}
          onClick={() => void onAction("probe", { expectedVersionToken: versionToken, reason })}
        >
          探测连接
        </button>
      )}
      <button
        type="button"
        className="primary-button"
        disabled={busy || reason.trim().length === 0}
        onClick={() => void onAction("publish", { expectedVersionToken: versionToken, reason })}
      >
        发布此版本
      </button>
      <span className="visually-hidden">
        {kind} revision {revision}
      </span>
    </div>
  );
}

function RevisionCard({
  kind,
  item,
  busy,
  onAction,
}: {
  readonly kind: "model-providers" | "memory-providers" | "runtime-settings";
  readonly item: ModelProviderRevisionDto | MemoryProviderRevisionDto | RuntimeSettingsRevisionDto;
  readonly busy: boolean;
  readonly onAction: (
    action: "probe" | "publish",
    input: { readonly expectedVersionToken: number; readonly reason: string },
  ) => Promise<void>;
}) {
  const configuration = item.configuration;
  const providerKey = "providerKey" in configuration ? configuration.providerKey : "global";
  const title = "displayName" in configuration ? configuration.displayName : "运行参数";
  return (
    <article className={`control-revision ${item.status === "active" ? "active" : ""}`}>
      <div className="control-revision-heading">
        <div>
          <span className="eyebrow">
            {providerKey} · Revision {item.revision}
          </span>
          <h3>{title}</h3>
        </div>
        <span className={`status status-${item.status}`}>{item.status}</span>
      </div>
      <dl className="configuration-summary">
        {Object.entries(configuration).map(([key, field]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{typeof field === "boolean" ? (field ? "是" : "否") : String(field)}</dd>
          </div>
        ))}
      </dl>
      <p className="revision-meta">
        探测：{item.probeStatus} · 版本令牌 {item.versionToken}
      </p>
      {item.status !== "active" && (
        <RevisionActions
          kind={kind}
          providerKey={providerKey}
          revision={item.revision}
          versionToken={item.versionToken}
          probe={kind !== "runtime-settings"}
          busy={busy}
          onAction={onAction}
        />
      )}
    </article>
  );
}

function DeploymentSettings({
  items,
}: {
  readonly items: AdminControlOverviewDto["deploymentSettings"];
}) {
  return (
    <section className="control-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Environment</span>
          <h2>部署配置</h2>
        </div>
      </div>
      <div className="deployment-list">
        {items.map((setting) => (
          <div key={setting.key}>
            <code>{setting.key}</code>
            <span>{setting.description}</span>
            <span className={setting.configured ? "configured" : "missing"}>
              {setting.configured ? "已配置" : "未配置"} · {setting.category}
            </span>
          </div>
        ))}
      </div>
      <p className="boundary-note">
        Secret、数据库角色和监听地址只展示状态，不在网页中读取或修改真实值。
      </p>
    </section>
  );
}

function AuditTrail({ items }: { readonly items: readonly ControlAuditEventDto[] }) {
  return (
    <section className="control-panel revision-list" aria-label="配置审计">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Audit</span>
          <h2>最近变更</h2>
        </div>
        <span className="count">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="empty-state">尚无配置变更记录。</p>
      ) : (
        <div className="audit-list">
          {items.map((item) => (
            <article key={item.auditId}>
              <div>
                <strong>
                  {item.action} · {item.objectKey} #{item.revision}
                </strong>
                <span>{item.reason}</span>
              </div>
              <span className={`audit-outcome ${item.outcome}`}>{item.outcome}</span>
              <time>{new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })}</time>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function Overview({
  value: overview,
  audits,
}: {
  readonly value: AdminControlOverviewDto;
  readonly audits: readonly ControlAuditEventDto[];
}) {
  const stats = overview.statistics;
  const cards = [
    ["运行总数", stats.runs.total],
    ["排队运行", stats.runs.queued],
    ["正在执行", stats.runs.running],
    ["24h 成功", stats.runs.succeeded24h],
    ["24h 失败", stats.runs.failed24h],
    ["24h 取消", stats.runs.cancelled24h],
    ["待派发", stats.dispatch.pending],
    ["派发处理中", stats.dispatch.claimed],
    ["活跃沙箱", stats.sandboxes.active],
    ["暂停沙箱", stats.sandboxes.paused],
    ["待清理沙箱", stats.sandboxes.cleanupPending],
    ["记忆积压", stats.memory.pending],
    ["记忆失败", stats.memory.failed],
    ["活跃定时任务", stats.automations.active],
    ["24h 定时任务失败", stats.automations.failedOccurrences24h],
    ["已发布 Skill", stats.skills.published],
    ["已安装 Skill", stats.skills.installed],
  ] as const;
  return (
    <>
      <section className="control-hero">
        <div>
          <span className="eyebrow">Generation {overview.generation}</span>
          <h2>运行控制面</h2>
          <p>所有发布操作都形成不可变版本；新 Run 固化当前版本，进行中的 Run 不受影响。</p>
        </div>
        <div className="active-stack">
          <span>模型：{overview.activeModel?.configuration.displayName ?? "尚未发布"}</span>
          <span>记忆：{overview.activeMemory?.configuration.displayName ?? "未启用"}</span>
        </div>
      </section>
      <section className="statistics-grid" aria-label="运行统计">
        {cards.map(([label, count]) => (
          <article key={label}>
            <span>{label}</span>
            <strong>{count}</strong>
          </article>
        ))}
      </section>
      <DeploymentSettings items={overview.deploymentSettings} />
      <AuditTrail items={audits} />
    </>
  );
}

function ModelDraftForm({
  onCreate,
  busy,
}: {
  readonly onCreate: (form: FormData) => Promise<void>;
  readonly busy: boolean;
}) {
  return (
    <form
      className="control-form"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void onCreate(new FormData(event.currentTarget));
      }}
    >
      <label>
        Provider Key
        <input name="providerKey" required pattern="[a-z0-9][a-z0-9._-]{0,63}" />
      </label>
      <label>
        显示名称
        <input name="displayName" required />
      </label>
      <label className="wide">
        HTTPS Base URL
        <input name="baseUrl" required type="url" placeholder="https://api.example.com/v1/" />
      </label>
      <label>
        模型 ID
        <input name="modelId" required />
      </label>
      <label>
        上下文窗口
        <input name="contextWindow" type="number" min="1" defaultValue="128000" required />
      </label>
      <label>
        最大输出 Token
        <input name="maxOutputTokens" type="number" min="1" defaultValue="8192" required />
      </label>
      <label className="checkbox">
        <input name="supportsImages" type="checkbox" />
        支持图片
      </label>
      <label className="wide">
        变更原因
        <textarea name="reason" required maxLength={500} />
      </label>
      <button type="submit" className="primary-button" disabled={busy}>
        创建模型草稿
      </button>
    </form>
  );
}

function MemoryDraftForm({
  onCreate,
  busy,
}: {
  readonly onCreate: (form: FormData) => Promise<void>;
  readonly busy: boolean;
}) {
  return (
    <form
      className="control-form"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void onCreate(new FormData(event.currentTarget));
      }}
    >
      <label>
        Provider Key
        <input name="providerKey" required pattern="[a-z0-9][a-z0-9._-]{0,63}" />
      </label>
      <label>
        显示名称
        <input name="displayName" required />
      </label>
      <label className="wide">
        HTTPS Base URL
        <input name="baseUrl" required type="url" />
      </label>
      <label>
        请求超时（ms）
        <input
          name="requestTimeoutMs"
          type="number"
          min="100"
          max="120000"
          defaultValue="10000"
          required
        />
      </label>
      <label className="checkbox">
        <input name="enabled" type="checkbox" defaultChecked />
        启用
      </label>
      <label className="wide">
        变更原因
        <textarea name="reason" required maxLength={500} />
      </label>
      <button type="submit" className="primary-button" disabled={busy}>
        创建记忆草稿
      </button>
    </form>
  );
}

function SettingsDraftForm({
  onCreate,
  busy,
}: {
  readonly onCreate: (form: FormData) => Promise<void>;
  readonly busy: boolean;
}) {
  return (
    <form
      className="control-form"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void onCreate(new FormData(event.currentTarget));
      }}
    >
      <label>
        压缩软上限 %
        <input name="compactionSoftLimitPercent" type="number" defaultValue="80" required />
      </label>
      <label>
        压缩目标 %<input name="compactionTargetPercent" type="number" defaultValue="60" required />
      </label>
      <label>
        保留用户 Token
        <input name="compactionRecentUserTokens" type="number" defaultValue="16000" required />
      </label>
      <label>
        压缩输出 Token
        <input name="compactionMaxOutputTokens" type="number" defaultValue="4096" required />
      </label>
      <label>
        压缩超时（ms）
        <input name="compactionTimeoutMs" type="number" defaultValue="60000" required />
      </label>
      <label className="wide">
        变更原因
        <textarea name="reason" required maxLength={500} />
      </label>
      <button type="submit" className="primary-button" disabled={busy}>
        创建参数草稿
      </button>
    </form>
  );
}

export function AdminControlConsole({
  view,
  api = defaultControlApi,
}: {
  readonly view: ControlView;
  readonly api?: AdminControlApiContract;
}) {
  const [overview, setOverview] = useState<AdminControlOverviewDto>();
  const [items, setItems] = useState<
    readonly (ModelProviderRevisionDto | MemoryProviderRevisionDto | RuntimeSettingsRevisionDto)[]
  >([]);
  const [audits, setAudits] = useState<readonly ControlAuditEventDto[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [nextOverview, nextItems, nextAudits] = await Promise.all([
        api.overview(),
        view === "models"
          ? api.listModelProviders()
          : view === "memory"
            ? api.listMemoryProviders()
            : view === "settings"
              ? api.listRuntimeSettings()
              : Promise.resolve([]),
        view === "overview" ? api.listAudits(50) : Promise.resolve([]),
      ]);
      setOverview(nextOverview);
      setItems(nextItems);
      setAudits(nextAudits);
      setError(undefined);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }, [api, view]);

  useEffect(() => {
    setItems([]);
    void refresh();
  }, [refresh]);

  const operation = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await refresh();
    } catch (reason) {
      const message = errorMessage(reason);
      await refresh();
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const kind =
    view === "models"
      ? "model-providers"
      : view === "memory"
        ? "memory-providers"
        : "runtime-settings";
  return (
    <main className="admin-shell control-shell">
      <header className="topbar control-topbar">
        <div>
          <span className="eyebrow">Hoox Admin</span>
          <h1>
            {view === "overview"
              ? "总览与统计"
              : view === "models"
                ? "模型供应商"
                : view === "memory"
                  ? "记忆供应商"
                  : "运行参数"}
          </h1>
        </div>
        <button
          type="button"
          className="quiet-button refresh-button"
          onClick={() => void refresh()}
        >
          刷新
        </button>
      </header>
      {error !== undefined && (
        <div className="error-banner" role="alert">
          <span>
            <strong>操作未完成</strong>
            {error}
          </span>
          <button type="button" className="quiet-button" onClick={() => setError(undefined)}>
            关闭
          </button>
        </div>
      )}
      {overview === undefined ? (
        <p className="empty-state large">正在加载控制面…</p>
      ) : view === "overview" ? (
        <Overview value={overview} audits={audits} />
      ) : (
        <>
          <section className="control-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">New revision</span>
                <h2>创建配置草稿</h2>
              </div>
            </div>
            {view === "models" ? (
              <ModelDraftForm
                busy={busy}
                onCreate={(form) =>
                  operation(() =>
                    api.createModelDraft({
                      providerKey: value(form, "providerKey"),
                      displayName: value(form, "displayName"),
                      protocol: "openai-compatible",
                      baseUrl: value(form, "baseUrl"),
                      secretRef: "deployment:model",
                      modelId: value(form, "modelId"),
                      supportsImages: form.get("supportsImages") === "on",
                      contextWindow: number(form, "contextWindow"),
                      maxOutputTokens: number(form, "maxOutputTokens"),
                      reason: value(form, "reason"),
                    }),
                  )
                }
              />
            ) : view === "memory" ? (
              <MemoryDraftForm
                busy={busy}
                onCreate={(form) =>
                  operation(() =>
                    api.createMemoryDraft({
                      providerKey: value(form, "providerKey"),
                      displayName: value(form, "displayName"),
                      providerKind: "mem0",
                      baseUrl: value(form, "baseUrl"),
                      apiSecretRef: "deployment:memory-api",
                      scopeSecretRef: "deployment:memory-scope",
                      requestTimeoutMs: number(form, "requestTimeoutMs"),
                      enabled: form.get("enabled") === "on",
                      reason: value(form, "reason"),
                    }),
                  )
                }
              />
            ) : (
              <SettingsDraftForm
                busy={busy}
                onCreate={(form) =>
                  operation(() =>
                    api.createRuntimeSettingsDraft({
                      compactionSoftLimitPercent: number(form, "compactionSoftLimitPercent"),
                      compactionTargetPercent: number(form, "compactionTargetPercent"),
                      compactionRecentUserTokens: number(form, "compactionRecentUserTokens"),
                      compactionMaxOutputTokens: number(form, "compactionMaxOutputTokens"),
                      compactionTimeoutMs: number(form, "compactionTimeoutMs"),
                      reason: value(form, "reason"),
                    }),
                  )
                }
              />
            )}
          </section>
          <section className="control-panel revision-list">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">History</span>
                <h2>版本记录</h2>
              </div>
              <span className="count">{items.length}</span>
            </div>
            {items.length === 0 ? (
              <p className="empty-state">尚未创建配置版本。</p>
            ) : (
              items.map((item) => {
                const providerKey =
                  "providerKey" in item.configuration ? item.configuration.providerKey : "global";
                return (
                  <RevisionCard
                    key={`${providerKey}:${item.revision}`}
                    kind={kind}
                    item={item}
                    busy={busy}
                    onAction={(action, input) =>
                      operation(() =>
                        action === "probe" && kind !== "runtime-settings"
                          ? api.probe(kind, providerKey, item.revision, input)
                          : api.publish(kind, providerKey, item.revision, input),
                      )
                    }
                  />
                );
              })
            )}
          </section>
          {view === "settings" && <DeploymentSettings items={overview.deploymentSettings} />}
        </>
      )}
    </main>
  );
}

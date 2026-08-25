import type {
  AdminControlOverviewDto,
  ControlAuditEventDto,
  IdentityAdminConfigurationDto,
  MemoryProviderRevisionDto,
  ModelProviderModelConfigurationDto,
  ModelProviderRevisionDto,
  PiModelCatalogModelDto,
  PiModelCatalogProviderDto,
  PlatformUserPageDto,
  RuntimeSettingsRevisionDto,
} from "@hoox/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AdminApiError } from "./api.js";
import { AdminControlApi, type AdminControlApiContract } from "./control-api.js";
import { IdentityConfigurationPanel } from "./identity-configuration-panel.js";
import { listLocalPiModelCatalogProviders } from "./pi-model-catalog.js";
import {
  ControlDataUnavailable,
  OperationsDashboard,
  UserManagementWorkspace,
} from "./operations-console.js";

export type ControlView =
  | "overview"
  | "analytics"
  | "users"
  | "identity"
  | "models"
  | "memory"
  | "settings"
  | "audits";
const defaultControlApi = new AdminControlApi();

function number(form: FormData, key: string): number {
  return Number(form.get(key));
}

function value(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

function secretValue(form: FormData, key: string): string {
  return String(form.get(key) ?? "");
}

function errorMessage(reason: unknown): string {
  return reason instanceof AdminApiError ? reason.message : "操作未完成，请刷新后重试。";
}

const secretLikeProviderKeyPattern =
  /^(?:(?:sk|rk|pk)[._-][a-z0-9_-]{16,}|(?:gh[pousr]|xox[baprs]|hf)[_-][a-z0-9_-]{16,})$/iu;
const redactedProviderKey = "sensitive-identifier-redacted";

function isSecretLikeProviderKey(value: string): boolean {
  const normalized = value.trim();
  return normalized === redactedProviderKey || secretLikeProviderKeyPattern.test(normalized);
}

function displayedProviderKey(value: string): string {
  return isSecretLikeProviderKey(value) ? "疑似密钥（已隐藏）" : value;
}

const revisionStatusLabels = {
  draft: "待启用",
  active: "当前生效",
  retired: "已停用",
} as const;

const probeStatusLabels = {
  untested: "尚未探测",
  healthy: "连接正常",
  failed: "探测失败",
} as const;

function configurationDisplayValue(key: string, field: unknown): string {
  if (key === "providerKey" && typeof field === "string") return displayedProviderKey(field);
  if (key === "secretRef" || key === "apiSecretRef" || key === "scopeSecretRef") {
    return "部署环境（值不可见）";
  }
  return typeof field === "boolean" ? (field ? "是" : "否") : String(field);
}

function RevisionActions({
  kind,
  providerKey,
  revision,
  versionToken,
  probeStatus,
  probe,
  sensitiveIdentifier,
  busy,
  onAction,
}: {
  readonly kind: "model-providers" | "memory-providers" | "runtime-settings";
  readonly providerKey: string;
  readonly revision: number;
  readonly versionToken: number;
  readonly probeStatus: ModelProviderRevisionDto["probeStatus"];
  readonly probe: boolean;
  readonly sensitiveIdentifier: boolean;
  readonly busy: boolean;
  readonly onAction: (
    action: "probe" | "publish",
    input: { readonly expectedVersionToken: number; readonly reason: string },
  ) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const activationBlocked = probe && probeStatus !== "healthy";
  return (
    <div className="revision-actions">
      <input
        aria-label={`${displayedProviderKey(providerKey)} 变更原因`}
        value={reason}
        maxLength={500}
        placeholder="填写探测或启用原因"
        onChange={(event) => setReason(event.target.value)}
      />
      {probe && (
        <button
          type="button"
          className="quiet-button"
          disabled={busy || sensitiveIdentifier || reason.trim().length === 0}
          onClick={() => void onAction("probe", { expectedVersionToken: versionToken, reason })}
        >
          探测连接
        </button>
      )}
      <button
        type="button"
        className="primary-button"
        disabled={busy || sensitiveIdentifier || activationBlocked || reason.trim().length === 0}
        onClick={() => void onAction("publish", { expectedVersionToken: versionToken, reason })}
      >
        启用此配置
      </button>
      {(sensitiveIdentifier || activationBlocked) && (
        <small className="revision-action-note" role="status">
          {sensitiveIdentifier
            ? "Provider 标识疑似包含密钥，已隔离；请轮换密钥并新建配置。"
            : probeStatus === "failed"
              ? "上次探测失败；重新探测成功后才能启用。"
              : "请先完成连接探测，再启用此配置。"}
        </small>
      )}
      <span className="visually-hidden">
        {kind} revision {revision}
      </span>
    </div>
  );
}

const configurationFieldLabels: Readonly<Record<string, string>> = {
  providerKey: "Provider 内部标识",
  displayName: "显示名称",
  protocol: "调用协议",
  baseUrl: "服务地址",
  secretRef: "凭据来源",
  defaultModelId: "默认模型",
  providerKind: "记忆服务",
  apiSecretRef: "Mem0 API 密钥引用",
  scopeSecretRef: "记忆作用域密钥引用",
  requestTimeoutMs: "请求超时（ms）",
  enabled: "已启用",
  compactionSoftLimitPercent: "上下文压缩触发阈值（%）",
  compactionTargetPercent: "压缩后目标占用（%）",
  compactionRecentUserTokens: "优先保留用户 Token",
  compactionMaxOutputTokens: "压缩输出预算",
  compactionTimeoutMs: "压缩超时（ms）",
};

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
  const modelConfiguration = "models" in configuration ? configuration : undefined;
  const modelCatalog = modelConfiguration?.models;
  const defaultModelId = modelConfiguration?.defaultModelId;
  const sensitiveIdentifier = isSecretLikeProviderKey(providerKey);
  return (
    <article className={`control-revision ${item.status === "active" ? "active" : ""}`}>
      <div className="control-revision-heading">
        <div>
          <span className="eyebrow">
            {displayedProviderKey(providerKey)} · Revision {item.revision}
          </span>
          <h3>{title}</h3>
        </div>
        <span className={`status status-${item.status}`}>{revisionStatusLabels[item.status]}</span>
      </div>
      <dl className="configuration-summary">
        {Object.entries(configuration)
          .filter(([key]) => key !== "models")
          .map(([key, field]) => (
            <div key={key}>
              <dt>{configurationFieldLabels[key] ?? key}</dt>
              <dd>{configurationDisplayValue(key, field)}</dd>
            </div>
          ))}
      </dl>
      {modelCatalog !== undefined && (
        <fieldset className="revision-model-catalog">
          <legend className="visually-hidden">{displayedProviderKey(providerKey)} 模型目录</legend>
          {modelCatalog.map((model) => (
            <div key={model.id} className={model.enabled ? "enabled" : "disabled"}>
              <span>
                <strong>{model.name}</strong>
                <code>{model.id}</code>
              </span>
              <span>
                {model.enabled ? "已启用" : "已停用"}
                {model.id === defaultModelId ? " · 默认" : ""}
                {model.reasoning ? " · 推理" : ""}
              </span>
              <span>
                {model.input.join(" + ")} · {model.contextWindow.toLocaleString()} /{" "}
                {model.maxTokens.toLocaleString()}
              </span>
            </div>
          ))}
        </fieldset>
      )}
      <p className="revision-meta">
        探测：{probeStatusLabels[item.probeStatus]} · 版本令牌 {item.versionToken}
      </p>
      {sensitiveIdentifier && (
        <p className="sensitive-identifier-warning" role="alert">
          此历史版本的 Provider 标识疑似包含密钥，页面已隐藏并禁止继续操作。
        </p>
      )}
      {item.status !== "active" && (
        <RevisionActions
          kind={kind}
          providerKey={providerKey}
          revision={item.revision}
          versionToken={item.versionToken}
          probeStatus={item.probeStatus}
          probe={kind !== "runtime-settings"}
          sensitiveIdentifier={sensitiveIdentifier}
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
  const configured = items.filter((item) => item.configured).length;
  const categoryLabels = {
    bootstrap: "启动基础设施",
    secret: "部署秘密",
    restart_required: "需重启生效",
  } as const;
  return (
    <section className="control-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Environment</span>
          <h2>部署配置</h2>
          <p>只读检查部署层前置条件；可版本化参数在对应模块中修改。</p>
        </div>
        <span className="count">{items.length === 0 ? "—" : `${configured}/${items.length}`}</span>
      </div>
      {items.length === 0 ? (
        <p className="empty-state">
          后台控制服务连接后显示当前部署检测结果；上方配置地图仍可作为离线配置入口。
        </p>
      ) : (
        <div className="deployment-list">
          {items.map((setting) => (
            <div key={setting.key}>
              <code>{setting.key}</code>
              <span>{setting.description}</span>
              <span className={setting.configured ? "configured" : "missing"}>
                {setting.configured ? "已配置" : "未配置"} · {categoryLabels[setting.category]}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="boundary-note">
        Secret、数据库角色和监听地址只展示状态，不在网页中读取或修改真实值。
      </p>
    </section>
  );
}

const environmentConfigurationGroups = [
  {
    priority: "P0",
    title: "后台控制服务",
    owner: "admin-control-api",
    description: "先建立独立数据库身份、认证和监听边界，后台才可以读取真实状态。",
    entries: [
      {
        key: "ADMIN_CONTROL_DATABASE_URL",
        description: "独立最小权限数据库连接，不得复用 Runtime 或 Migrator 登录。",
      },
      {
        key: "DATABASE_ADMIN_CONTROL_ROLE",
        description: "用于启动时校验实际 PostgreSQL Role，生产环境必需。",
      },
      {
        key: "pnpm db:migrate:up",
        description: "应用数据库迁移并重建最小权限 ACL；必须先于控制服务启动。",
      },
      {
        key: "platform_control_operators",
        description: "由受控数据库运维事务写入首位 admin；控制 API 不提供自助提权。",
      },
      {
        key: "ADMIN_CONTROL_LISTEN_HOST / ADMIN_CONTROL_LISTEN_PORT",
        description: "管理 API 监听地址；开发默认 127.0.0.1:3003。",
      },
      {
        key: "DEV_ADMIN_CONTROL_TOKEN / ADMIN_CONTROL_JWT_*",
        description: "开发使用固定 Token；生产必须改用独立 issuer、audience 与签名密钥。",
      },
      {
        key: "ADMIN_CONTROL_PROVIDER_HOST_ALLOWLIST",
        description: "只允许控制服务向明确列出的模型或 Mem0 主机执行连接探测。",
      },
    ],
  },
  {
    priority: "P0",
    title: "模型与长期记忆",
    owner: "admin-control-api + agent-worker",
    description: "秘密由部署平台注入；地址、模型目录和超时等可审计参数由对应页面发布。",
    entries: [
      {
        key: "MODEL_API_KEY",
        description: "当前部署的模型凭据；模型地址、默认模型和能力从“模型”页发布。",
      },
      {
        key: "MEM0_API_KEY",
        description: "Mem0 Project API Key，必须与作用域密钥同时配置。",
      },
      {
        key: "MEM0_SCOPE_HMAC_KEY",
        description: "至少 32 字节，用于匿名化租户与用户作用域，不得复用 API Key。",
      },
    ],
  },
  {
    priority: "P0",
    title: "运行基础设施",
    owner: "api + worker + scheduler",
    description: "这些连接属于进程启动契约，后台只提供配置地图，不读取或回显真实凭据。",
    entries: [
      {
        key: "DATABASE_URL / DATABASE_SCHEMA",
        description: "Runtime 业务数据库与 Schema；迁移连接必须使用独立 MIGRATION_DATABASE_URL。",
      },
      {
        key: "S3_ENDPOINT / S3_BUCKET / S3_*",
        description: "工作区、附件和历史产物的对象存储；生产凭据由密钥系统注入。",
      },
      {
        key: "CUBESANDBOX_API_URL / CUBESANDBOX_TEMPLATE_ID",
        description: "Sandbox 控制面和模板；本项目依赖 uu 端口映射，不在本机启动服务。",
      },
      {
        key: "SKILL_PUBLISHER_DATABASE_URL / DATABASE_SKILL_PUBLISHER_ROLE / SKILL_PUBLISHER_S3_*",
        description:
          "统一后台内的 Skill 模块使用独立数据库角色与对象存储身份，不能复用 Runtime 凭据。",
      },
    ],
  },
  {
    priority: "P1",
    title: "运行策略与时区",
    owner: "agent-worker + scheduler",
    description: "开关和执行路径需要重新部署；百分比与 Token 预算在本页形成 Revision。",
    entries: [
      {
        key: "THREAD_CONTEXT_COMPACTION_ENABLED",
        description: "上下文压缩总开关；关闭时，本页发布的百分比参数不会执行。",
      },
      {
        key: "THREAD_CONTEXT_COMPACTION_PATH",
        description: "压缩执行路径；与启用模型和 Worker 部署能力保持一致。",
      },
      {
        key: "HISTORY_DIRECTORY_TIME_ZONE",
        description: "历史目录与定时任务的业务时区，变更后需要重启相关进程。",
      },
    ],
  },
] as const;

function EnvironmentConfigurationGuide({
  items,
}: {
  readonly items: AdminControlOverviewDto["deploymentSettings"];
}) {
  return (
    <section className="control-panel environment-guide">
      <div className="environment-guide-heading">
        <div>
          <span className="eyebrow">Configuration map</span>
          <h2>部署配置地图</h2>
          <p>
            从 P0 开始配置。开发环境以 `.env.example` 为契约，生产环境以
            `deploy/production.env.example` 为契约。
          </p>
        </div>
        <span className="environment-contract-state">
          {items.length === 0 ? "等待后台检测" : `已检测 ${items.length} 项`}
        </span>
      </div>

      <div className="configuration-source-grid">
        <article>
          <span>部署平台</span>
          <strong>Secret 与基础设施连接</strong>
          <small>只在环境变量或密钥系统中修改，网页永不读取真实值。</small>
        </article>
        <article>
          <span>后台 Revision</span>
          <strong>模型、Mem0 与运行参数</strong>
          <small>创建草稿、探测、发布；新 Run 固定发布时的配置快照。</small>
        </article>
        <article>
          <span>运行时检测</span>
          <strong>只展示是否就绪</strong>
          <small>“按契约确认”表示当前控制服务无法安全判断该进程的配置状态。</small>
        </article>
      </div>

      <div className="environment-guide-groups">
        {environmentConfigurationGroups.map((group) => (
          <article key={group.title} className="environment-guide-group">
            <header>
              <span className={`configuration-priority ${group.priority.toLowerCase()}`}>
                {group.priority}
              </span>
              <span>
                <strong>{group.title}</strong>
                <small>{group.owner}</small>
              </span>
            </header>
            <p>{group.description}</p>
            <div className="environment-guide-entries">
              {group.entries.map((entry) => {
                const state = deploymentState(items, entry.key);
                return (
                  <div key={entry.key}>
                    <span>
                      <code>{entry.key}</code>
                      <small>{entry.description}</small>
                    </span>
                    <span className={`configuration-state ${state}`}>
                      {state === "configured"
                        ? "已配置"
                        : state === "missing"
                          ? "未配置"
                          : "按契约确认"}
                    </span>
                  </div>
                );
              })}
            </div>
          </article>
        ))}
      </div>
      <p className="environment-guide-footer">
        推荐顺序：数据库与身份 → 模型与 Mem0 秘密 → Sandbox / S3 → 本页运行策略 → Provider
        探测与发布。
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
                  {item.action} · {displayedProviderKey(item.objectKey)} #{item.revision}
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
    ["累计用户", stats.users.total, `${stats.users.registered24h} 位 24h 新增`],
    ["累计对话", stats.conversations.total, `${stats.conversations.active24h} 条 24h 活跃`],
    ["累计 Run", stats.runs.total, `${stats.runs.running} 个正在执行`],
    ["24h 成功", stats.runs.succeeded24h, `${stats.runs.failed24h} 个失败`],
    ["活跃沙箱", stats.sandboxes.active, `${stats.sandboxes.cleanupPending} 个待清理`],
    ["记忆队列", stats.memory.pending, `${stats.memory.failed} 个失败`],
    [
      "活跃定时任务",
      stats.automations.active,
      `${stats.automations.failedOccurrences24h} 个 24h 失败`,
    ],
    ["已发布 Skill", stats.skills.published, `${stats.skills.installed} 次安装`],
  ] as const;
  return (
    <>
      <section className="control-hero">
        <div>
          <span className="eyebrow">Generation {overview.generation}</span>
          <h2>平台运营驾驶舱</h2>
          <p>配置、用户、对话与运行健康集中呈现；所有发布操作形成不可变版本并写入审计。</p>
        </div>
        <div className="active-stack">
          <span>
            模型：
            {overview.activeModel === undefined
              ? "尚未发布"
              : `${overview.activeModel.configuration.displayName} / ${overview.activeModel.configuration.defaultModelId}`}
          </span>
          <span>记忆：{overview.activeMemory?.configuration.displayName ?? "未启用"}</span>
        </div>
      </section>
      <section className="statistics-grid" aria-label="运行统计">
        {cards.map(([label, count, note]) => (
          <article key={label}>
            <span>{label}</span>
            <strong>{count}</strong>
            <small>{note}</small>
          </article>
        ))}
      </section>
      <DeploymentSettings items={overview.deploymentSettings} />
      <AuditTrail items={audits} />
    </>
  );
}

interface EditableModelRow {
  readonly clientId: string;
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly reasoning: boolean;
  readonly supportsImages: boolean;
  readonly contextWindow: string;
  readonly maxTokens: string;
}

function newModelRow(
  seed?: ModelProviderModelConfigurationDto | PiModelCatalogModelDto,
  enabled = true,
): EditableModelRow {
  return {
    clientId: crypto.randomUUID(),
    id: seed?.id ?? "",
    name: seed?.name ?? "",
    enabled: seed !== undefined && "enabled" in seed ? seed.enabled : enabled,
    reasoning: seed?.reasoning ?? false,
    supportsImages: seed?.input.includes("image") ?? false,
    contextWindow: String(seed?.contextWindow ?? 128_000),
    maxTokens: String(seed?.maxTokens ?? 8_192),
  };
}

function ModelDraftForm({
  onCreate,
  busy,
  api,
  initialConfiguration,
  reuseCredentialFromRevision,
  catalogProvider,
  onCancel,
}: {
  readonly onCreate: (
    form: FormData,
    models: ModelProviderModelConfigurationDto[],
    defaultModelId: string,
  ) => Promise<boolean>;
  readonly busy: boolean;
  readonly api: AdminControlApiContract;
  readonly initialConfiguration?: ModelProviderRevisionDto["configuration"];
  readonly reuseCredentialFromRevision?: number;
  readonly catalogProvider?: PiModelCatalogProviderDto;
  readonly onCancel: () => void;
}) {
  const initialProviderKey = initialConfiguration?.providerKey ?? catalogProvider?.providerId ?? "";
  const [providerKey, setProviderKey] = useState(() =>
    isSecretLikeProviderKey(initialProviderKey) ? "" : initialProviderKey,
  );
  const [providerKeyRejected, setProviderKeyRejected] = useState(() =>
    isSecretLikeProviderKey(initialProviderKey),
  );
  const [catalog, setCatalog] = useState(() => {
    const models = initialConfiguration?.models.map((model) => newModelRow(model)) ?? [
      newModelRow(),
    ];
    const defaultClientId =
      models.find((model) => model.id === initialConfiguration?.defaultModelId)?.clientId ??
      models[0]?.clientId ??
      "";
    return { models, defaultClientId };
  });
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogMessage, setCatalogMessage] = useState<string>();
  const updateModel = (clientId: string, patch: Partial<EditableModelRow>) => {
    setCatalog((current) => ({
      ...current,
      models: current.models.map((model) =>
        model.clientId === clientId ? { ...model, ...patch } : model,
      ),
    }));
  };
  const removeModel = (clientId: string) => {
    setCatalog((current) => {
      const models = current.models.filter((model) => model.clientId !== clientId);
      const defaultClientId =
        current.defaultClientId === clientId
          ? (models[0]?.clientId ?? "")
          : current.defaultClientId;
      return { models, defaultClientId };
    });
  };
  const replaceWithPiModels = useCallback((models: readonly PiModelCatalogModelDto[]) => {
    if (models.length === 0) {
      setCatalogMessage("Pi 目录中没有当前运行时可用的模型，可继续手工添加。");
      return;
    }
    const rows = models.map((model) => newModelRow(model, true));
    setCatalog({ models: rows, defaultClientId: rows[0]?.clientId ?? "" });
    setCatalogMessage(undefined);
  }, []);
  const loadProviderModels = useCallback(async () => {
    if (catalogProvider === undefined) return;
    setCatalogBusy(true);
    setCatalogMessage(undefined);
    try {
      replaceWithPiModels(
        await api.findPiModelCatalogModels({ providerId: catalogProvider.providerId, limit: 100 }),
      );
    } catch {
      setCatalogMessage("暂时无法读取 Pi 模型目录，可继续手工配置。");
    } finally {
      setCatalogBusy(false);
    }
  }, [api, catalogProvider, replaceWithPiModels]);
  useEffect(() => {
    if (catalogProvider !== undefined && initialConfiguration === undefined) {
      void loadProviderModels();
    }
  }, [catalogProvider, initialConfiguration, loadProviderModels]);
  const addBlankModel = () => {
    const row = newModelRow();
    setCatalog((current) => ({
      models: [...current.models, row],
      defaultClientId: current.defaultClientId || row.clientId,
    }));
  };
  return (
    <form
      className="control-form model-provider-editor"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const models = catalog.models.map<ModelProviderModelConfigurationDto>((model) => ({
          id: model.id.trim(),
          name: model.name.trim() || model.id.trim(),
          enabled:
            catalogProvider === undefined
              ? model.enabled || model.clientId === catalog.defaultClientId
              : model.clientId === catalog.defaultClientId,
          reasoning: model.reasoning,
          input: model.supportsImages ? ["text", "image"] : ["text"],
          contextWindow: Number(model.contextWindow),
          maxTokens: Number(model.maxTokens),
        }));
        const defaultModelId =
          catalog.models.find((model) => model.clientId === catalog.defaultClientId)?.id.trim() ??
          "";
        void onCreate(new FormData(event.currentTarget), models, defaultModelId).then((saved) => {
          if (saved) onCancel();
        });
      }}
    >
      <div className="model-editor-intro wide">
        <div>
          <span className="provider-avatar">
            {(initialConfiguration?.displayName ?? catalogProvider?.displayName ?? "自").slice(
              0,
              1,
            )}
          </span>
          <span>
            <strong>
              {initialConfiguration === undefined
                ? (catalogProvider?.displayName ?? "自定义提供方")
                : `编辑 ${initialConfiguration.displayName}`}
            </strong>
            <small>
              {catalogProvider === undefined
                ? "自定义 endpoint；模型仍可按名称复用 Pi 元数据"
                : `Pi Provider · ${catalogProvider.providerId}`}
            </small>
          </span>
        </div>
        <button type="button" className="quiet-button" onClick={onCancel}>
          取消
        </button>
      </div>
      {catalogProvider === undefined ? (
        <>
          <label>
            Provider 标识
            <input
              name="providerKey"
              required
              pattern="[a-z0-9][a-z0-9._-]{0,63}"
              placeholder="例如 deepseek 或 openrouter"
              autoComplete="off"
              value={providerKey}
              aria-invalid={providerKeyRejected}
              onChange={(event) => {
                const next = event.target.value;
                if (isSecretLikeProviderKey(next)) {
                  setProviderKey("");
                  setProviderKeyRejected(true);
                  return;
                }
                setProviderKey(next);
                setProviderKeyRejected(false);
              }}
            />
            {providerKeyRejected && (
              <small className="field-error">这里请填写名称，不是 API Key。</small>
            )}
          </label>
          <label>
            显示名称
            <input
              name="displayName"
              required
              maxLength={120}
              defaultValue={initialConfiguration?.displayName ?? ""}
            />
          </label>
        </>
      ) : (
        <>
          <input type="hidden" name="providerKey" value={catalogProvider.providerId} />
          <input
            type="hidden"
            name="displayName"
            value={initialConfiguration?.displayName ?? catalogProvider.displayName}
          />
        </>
      )}
      <label className="wide">
        接口地址
        <input
          name="baseUrl"
          required
          type="url"
          maxLength={2048}
          placeholder="https://api.example.com/v1/"
          defaultValue={initialConfiguration?.baseUrl ?? catalogProvider?.baseUrl ?? ""}
        />
      </label>
      <label className="wide">
        API Key
        <input
          name="apiKey"
          type="password"
          autoComplete="new-password"
          maxLength={8192}
          required={reuseCredentialFromRevision === undefined}
          placeholder={
            reuseCredentialFromRevision === undefined
              ? "输入此 Provider 的 API Key"
              : "留空则保留当前密钥；输入新值则替换"
          }
        />
        <small>
          {reuseCredentialFromRevision === undefined
            ? "在这里配置这个 Provider 的密钥。"
            : "留空会继续使用当前密钥。"}
        </small>
      </label>
      {reuseCredentialFromRevision !== undefined && (
        <input
          type="hidden"
          name="reuseCredentialFromRevision"
          value={reuseCredentialFromRevision}
        />
      )}
      {catalogProvider !== undefined ? (
        <label className="wide model-primary-choice">
          使用模型
          <select
            required
            value={catalog.defaultClientId}
            disabled={catalogBusy || catalog.models.length === 0}
            onChange={(event) =>
              setCatalog((current) => ({ ...current, defaultClientId: event.target.value }))
            }
          >
            {catalog.models.length === 0 && <option value="">正在读取模型…</option>}
            {catalog.models.map((model) => (
              <option key={model.clientId} value={model.clientId}>
                {model.name} · {model.id}
              </option>
            ))}
          </select>
          <small>Pi 已提供模型信息，直接选择要使用的模型即可。</small>
          {catalogMessage !== undefined && <small className="field-error">{catalogMessage}</small>}
        </label>
      ) : (
        <fieldset className="model-catalog-editor simple-model-list wide">
          <legend>模型</legend>
          <p>至少填写一个模型；选中的模型会作为默认模型。</p>
          {catalog.models.map((model, index) => (
            <div className="simple-model-row" key={model.clientId}>
              <label>
                模型 ID
                <input
                  required
                  maxLength={255}
                  aria-label={`模型 ${index + 1} ID`}
                  placeholder="例如 deepseek-chat"
                  value={model.id}
                  onChange={(event) => updateModel(model.clientId, { id: event.target.value })}
                />
              </label>
              <label>
                显示名称
                <input
                  maxLength={120}
                  aria-label={`模型 ${index + 1} 名称`}
                  placeholder="不填则使用模型 ID"
                  value={model.name}
                  onChange={(event) => updateModel(model.clientId, { name: event.target.value })}
                />
              </label>
              <label className="default-model-choice">
                <input
                  type="radio"
                  name="defaultModel"
                  aria-label={`模型 ${index + 1} 设为默认`}
                  checked={catalog.defaultClientId === model.clientId}
                  onChange={() =>
                    setCatalog((current) => ({ ...current, defaultClientId: model.clientId }))
                  }
                />
                默认
              </label>
              <button
                type="button"
                className="text-button danger"
                disabled={catalog.models.length === 1}
                onClick={() => removeModel(model.clientId)}
              >
                删除
              </button>
            </div>
          ))}
          <button
            type="button"
            className="quiet-button add-model-button"
            disabled={catalog.models.length >= 100}
            onClick={addBlankModel}
          >
            添加模型
          </button>
        </fieldset>
      )}
      <button
        type="submit"
        className="primary-button"
        disabled={
          busy ||
          catalogBusy ||
          providerKeyRejected ||
          providerKey.trim() === "" ||
          catalog.defaultClientId === ""
        }
      >
        {busy ? "正在保存…" : "保存并使用"}
      </button>
    </form>
  );
}

interface ModelEditorState {
  readonly key: string;
  readonly initialConfiguration?: ModelProviderRevisionDto["configuration"];
  readonly catalogProvider?: PiModelCatalogProviderDto;
  readonly reuseCredentialFromRevision?: number;
}

function latestModelRevisions(
  revisions: readonly ModelProviderRevisionDto[],
): readonly ModelProviderRevisionDto[] {
  const latest = new Map<string, ModelProviderRevisionDto>();
  for (const revision of revisions) {
    const key = revision.configuration.providerKey;
    const current = latest.get(key);
    if (current === undefined || current.revision < revision.revision) latest.set(key, revision);
  }
  return [...latest.values()].sort((left, right) =>
    left.configuration.displayName.localeCompare(right.configuration.displayName, "zh-CN"),
  );
}

function ModelEffectiveState({
  overview,
  unavailable,
}: {
  readonly overview?: AdminControlOverviewDto;
  readonly unavailable: boolean;
}) {
  if (overview === undefined) {
    return (
      <section
        className={`model-effective-state ${unavailable ? "unavailable" : "loading"}`}
        aria-label="当前模型生效状态"
      >
        <span className="model-effective-badge">{unavailable ? "状态未知" : "读取中"}</span>
        <div>
          <strong>{unavailable ? "无法确认当前实际使用的模型" : "正在读取当前生效配置"}</strong>
          <p>
            {unavailable
              ? "控制服务不可用，暂时无法读取或保存模型配置。请恢复 uu 端口映射与后台控制服务后重试。"
              : "正在读取当前模型配置。"}
          </p>
        </div>
      </section>
    );
  }

  const active = overview.activeModel;
  const credentialState =
    active === undefined
      ? deploymentState(overview.deploymentSettings, "MODEL_API_KEY")
      : active.configuration.credentialConfigured
        ? "configured"
        : "missing";
  return (
    <section
      className={`model-effective-state ${active === undefined ? "fallback" : "active"}`}
      aria-label="当前模型生效状态"
    >
      <span className="model-effective-badge">
        {active === undefined ? "部署默认" : "当前使用"}
      </span>
      <div>
        <strong>
          {active === undefined
            ? "当前使用部署配置"
            : `${active.configuration.displayName} / ${active.configuration.defaultModelId}`}
        </strong>
        <p>
          {active === undefined
            ? "添加并保存 Provider 后，新 Run 会直接使用保存的模型。"
            : `Provider ${displayedProviderKey(active.configuration.providerKey)}。新 Run 使用这份配置，已经开始的 Run 保持不变。`}
        </p>
      </div>
      <span className={`model-credential-state ${credentialState}`}>
        {active === undefined ? "部署 API Key" : "Provider API Key"}
        <small>
          {credentialState === "configured"
            ? "已配置"
            : credentialState === "missing"
              ? "未配置"
              : "状态未知"}
        </small>
      </span>
    </section>
  );
}

function ModelProviderWorkspace({
  api,
  revisions,
  catalogProviders,
  overview,
  controlUnavailable,
  busy,
  onCreate,
}: {
  readonly api: AdminControlApiContract;
  readonly revisions: readonly ModelProviderRevisionDto[];
  readonly catalogProviders: readonly PiModelCatalogProviderDto[];
  readonly overview?: AdminControlOverviewDto;
  readonly controlUnavailable: boolean;
  readonly busy: boolean;
  readonly onCreate: (
    form: FormData,
    models: ModelProviderModelConfigurationDto[],
    defaultModelId: string,
  ) => Promise<boolean>;
}) {
  const [editor, setEditor] = useState<ModelEditorState>();
  const [showProviderCatalog, setShowProviderCatalog] = useState(true);
  if (editor !== undefined) {
    return (
      <ModelDraftForm
        key={editor.key}
        api={api}
        busy={busy}
        {...(editor.initialConfiguration === undefined
          ? {}
          : { initialConfiguration: editor.initialConfiguration })}
        {...(editor.catalogProvider === undefined
          ? {}
          : { catalogProvider: editor.catalogProvider })}
        {...(editor.reuseCredentialFromRevision === undefined
          ? {}
          : { reuseCredentialFromRevision: editor.reuseCredentialFromRevision })}
        onCancel={() => setEditor(undefined)}
        onCreate={onCreate}
      />
    );
  }
  const providers = latestModelRevisions(revisions);
  return (
    <div className="model-provider-workspace">
      <ModelEffectiveState
        {...(overview === undefined ? {} : { overview })}
        unavailable={controlUnavailable}
      />
      <div className="provider-settings-heading">
        <span>
          <h2>供应商</h2>
          <p>选择 Provider，填入 API Key 和模型，保存后直接用于新 Run。</p>
        </span>
        <span className="provider-settings-actions">
          <button
            type="button"
            className="quiet-button"
            onClick={() => setShowProviderCatalog((visible) => !visible)}
          >
            {showProviderCatalog ? "收起 Pi Provider" : "浏览 Pi Provider"}
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => setEditor({ key: `custom:${crypto.randomUUID()}` })}
          >
            添加自定义 Provider
          </button>
        </span>
      </div>
      {showProviderCatalog && (
        <div className="provider-catalog-picker">
          <div>
            <span className="provider-catalog-title">
              <strong>Pi Provider 目录</strong>
              <small>{catalogProviders.length} 个可配置 Provider</small>
            </span>
            <small>选择后自动填入模型能力，所有字段仍可修改。</small>
          </div>
          {catalogProviders.length === 0 ? (
            <p>本地 Pi Provider 快照缺失，请重新构建后台页面。</p>
          ) : (
            <div className="provider-catalog-grid">
              {catalogProviders.map((provider) => (
                <button
                  type="button"
                  key={provider.providerId}
                  onClick={() =>
                    setEditor({
                      key: `catalog:${provider.providerId}`,
                      catalogProvider: provider,
                    })
                  }
                >
                  <span className="provider-avatar">{provider.displayName.slice(0, 1)}</span>
                  <span>
                    <strong>{provider.displayName}</strong>
                    <small>{provider.modelCount} 个 Pi 模型</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="provider-settings-list">
        {providers.length === 0 ? (
          <div className="provider-list-empty">
            <span className="provider-avatar">P</span>
            <span>
              <strong>尚未配置模型供应商</strong>
              <small>添加内置 Provider，或连接一个 OpenAI-compatible 自定义网关。</small>
            </span>
          </div>
        ) : (
          providers.map((revision) => {
            const configuration = revision.configuration;
            const sensitiveIdentifier = isSecretLikeProviderKey(configuration.providerKey);
            const catalogProvider = catalogProviders.find(
              (candidate) => candidate.providerId === configuration.providerKey,
            );
            const enabledCount = configuration.models.filter((model) => model.enabled).length;
            return (
              <article key={configuration.providerKey}>
                <span className="provider-avatar">{configuration.displayName.slice(0, 1)}</span>
                <span className="provider-list-identity">
                  <strong>{configuration.displayName}</strong>
                  <small>
                    {displayedProviderKey(configuration.providerKey)}
                    {catalogProvider === undefined ? " · 自定义" : " · Pi 内置"}
                  </small>
                </span>
                <span className="provider-list-metadata">
                  <small>{enabledCount} 个已启用</small>
                  <small>默认：{configuration.defaultModelId}</small>
                </span>
                <span className={`status status-${revision.status}`}>
                  {revision.status === "active" ? "当前使用" : "已配置"}
                </span>
                <button
                  type="button"
                  className="text-button"
                  aria-label={
                    sensitiveIdentifier
                      ? `${configuration.displayName} 已隔离`
                      : `编辑 ${configuration.displayName}`
                  }
                  disabled={sensitiveIdentifier}
                  onClick={() =>
                    setEditor({
                      key: `revision:${configuration.providerKey}:${revision.revision}`,
                      initialConfiguration: configuration,
                      reuseCredentialFromRevision: revision.revision,
                      ...(catalogProvider === undefined ? {} : { catalogProvider }),
                    })
                  }
                >
                  {sensitiveIdentifier ? "已隔离" : "编辑"}
                </button>
              </article>
            );
          })
        )}
      </div>
      <p className="boundary-note">
        编辑并保存任一 Provider 后，它会立即成为新 Run 使用的模型配置。
      </p>
    </div>
  );
}

function deploymentState(
  settings: AdminControlOverviewDto["deploymentSettings"],
  key: string,
): "configured" | "missing" | "unknown" {
  const setting = settings.find((candidate) => candidate.key === key);
  return setting === undefined ? "unknown" : setting.configured ? "configured" : "missing";
}

function DeploymentCheck({
  label,
  settingKey,
  state,
}: {
  readonly label: string;
  readonly settingKey: string;
  readonly state: "configured" | "missing" | "unknown";
}) {
  return (
    <div className={`memory-deployment-check ${state}`}>
      <span aria-hidden="true">
        {state === "configured" ? "✓" : state === "missing" ? "!" : "·"}
      </span>
      <span>
        <strong>{label}</strong>
        <code>{settingKey}</code>
      </span>
      <small>
        {state === "configured" ? "已配置" : state === "missing" ? "未配置" : "待连接后台确认"}
      </small>
    </div>
  );
}

function MemoryProviderWorkspace({
  onCreate,
  busy,
  deploymentSettings,
  activeMemory,
}: {
  readonly onCreate: (form: FormData) => Promise<void>;
  readonly busy: boolean;
  readonly deploymentSettings: AdminControlOverviewDto["deploymentSettings"];
  readonly activeMemory: AdminControlOverviewDto["activeMemory"];
}) {
  const [providerKey, setProviderKey] = useState("mem0");
  const [providerKeyRejected, setProviderKeyRejected] = useState(false);
  return (
    <div className="memory-provider-workspace">
      <section className="memory-provider-hero">
        <span className="mem0-mark" aria-hidden="true">
          M
        </span>
        <div>
          <span className="eyebrow">Managed memory provider</span>
          <h2>Mem0 Platform</h2>
          <p>
            Hoox 使用 Mem0 承载跨对话长期记忆。Run
            完成后通过可靠队列异步写入；下一轮按租户与用户作用域检索， 不把原始 userId
            直接发送给外部服务。
          </p>
        </div>
        <span
          className={`memory-active-state ${activeMemory === undefined ? "inactive" : "active"}`}
        >
          {activeMemory === undefined ? "尚未启用" : `已启用 · Revision ${activeMemory.revision}`}
        </span>
      </section>

      <section className="memory-setup-section">
        <div className="memory-section-heading">
          <span>
            <span className="step-number">1</span>
            <strong>准备部署秘密</strong>
          </span>
          <p>密钥只在部署环境中设置，后台页面只显示状态，不读取或回显真实值。</p>
        </div>
        <div className="memory-deployment-grid">
          <DeploymentCheck
            label="Mem0 Project API Key"
            settingKey="MEM0_API_KEY"
            state={deploymentState(deploymentSettings, "MEM0_API_KEY")}
          />
          <DeploymentCheck
            label="作用域 HMAC Key"
            settingKey="MEM0_SCOPE_HMAC_KEY"
            state={deploymentState(deploymentSettings, "MEM0_SCOPE_HMAC_KEY")}
          />
          <DeploymentCheck
            label="探针主机白名单"
            settingKey="ADMIN_CONTROL_PROVIDER_HOST_ALLOWLIST"
            state={deploymentState(deploymentSettings, "ADMIN_CONTROL_PROVIDER_HOST_ALLOWLIST")}
          />
        </div>
        <p className="memory-security-note">
          <strong>安全要求：</strong>HMAC Key 至少 32 字节，必须与 Mem0 API Key
          独立生成；白名单需包含
          <code>api.mem0.ai</code> 或实际自建网关域名。
        </p>
      </section>

      <section className="memory-setup-section">
        <div className="memory-section-heading">
          <span>
            <span className="step-number">2</span>
            <strong>创建 Mem0 待启用配置</strong>
          </span>
          <p>待启用配置不会立即影响 Run。保存后先执行连接探测，再由管理员启用。</p>
        </div>
        <form
          className="control-form memory-control-form"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void onCreate(new FormData(event.currentTarget));
          }}
        >
          <label>
            Provider 内部标识（不是 API Key）
            <input
              name="providerKey"
              required
              pattern="[a-z0-9][a-z0-9._-]{0,63}"
              autoComplete="off"
              value={providerKey}
              aria-invalid={providerKeyRejected}
              onChange={(event) => {
                const next = event.target.value;
                if (isSecretLikeProviderKey(next)) {
                  setProviderKey("");
                  setProviderKeyRejected(true);
                  return;
                }
                setProviderKey(next);
                setProviderKeyRejected(false);
              }}
            />
            <small className={providerKeyRejected ? "field-error" : undefined}>
              {providerKeyRejected
                ? "检测到疑似 API Key，内容已清空；请立即轮换该密钥。"
                : "平台内稳定标识，启用后用于 Run 配置快照；不得填写任何密钥。"}
            </small>
          </label>
          <label>
            显示名称
            <input name="displayName" required defaultValue="Mem0 Platform" />
            <small>管理员和审计记录中显示的名称。</small>
          </label>
          <label className="wide">
            Mem0 HTTPS API 地址
            <input name="baseUrl" required type="url" defaultValue="https://api.mem0.ai/" />
            <small>可改为兼容的企业网关，但必须加入探针白名单。</small>
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
            <small>仅控制单次外部请求；队列重试由 Runtime 负责。</small>
          </label>
          <label className="checkbox memory-enabled-checkbox">
            <input name="enabled" type="checkbox" defaultChecked />
            启用后允许写入和检索长期记忆
          </label>
          <div className="memory-secret-refs wide">
            <span>
              <small>API Secret Ref</small>
              <code>deployment:memory-api</code>
            </span>
            <span>
              <small>Scope Secret Ref</small>
              <code>deployment:memory-scope</code>
            </span>
          </div>
          <label className="wide">
            变更原因
            <textarea
              name="reason"
              required
              maxLength={500}
              placeholder="例如：接入生产 Mem0 Project，完成密钥与域名白名单配置"
            />
            <small>原因会进入不可变审计记录。</small>
          </label>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || providerKeyRejected || providerKey.trim() === ""}
          >
            保存 Mem0 待启用配置
          </button>
        </form>
      </section>

      <section className="memory-flow" aria-label="Mem0 启用流程">
        <div>
          <span>3</span>
          <strong>探测连接</strong>
          <small>验证域名白名单、密钥和服务可达性。</small>
        </div>
        <i aria-hidden="true">→</i>
        <div>
          <span>4</span>
          <strong>启用配置</strong>
          <small>新 Run 固化该 Revision，进行中的 Run 不切换。</small>
        </div>
        <i aria-hidden="true">→</i>
        <div>
          <span>5</span>
          <strong>观察队列</strong>
          <small>在数据运营页关注记忆积压和失败数。</small>
        </div>
      </section>
    </div>
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
    <div className="runtime-settings-workspace">
      <section className="runtime-settings-guide">
        <div>
          <span className="eyebrow">Context lifecycle</span>
          <h2>上下文压缩策略</h2>
          <p>控制 Thread 接近模型窗口上限时何时压缩、压到多少以及保留多少近期用户信息。</p>
        </div>
        <div className="runtime-setting-principles">
          <span>
            <strong>触发</strong>
            <small>软上限越高，单轮上下文越完整，但越接近模型硬上限。</small>
          </span>
          <span>
            <strong>目标</strong>
            <small>目标必须低于软上限，二者差值决定压缩后的余量。</small>
          </span>
          <span>
            <strong>预算</strong>
            <small>Token 与超时共同限制压缩成本；发布前需与启用模型上限核对。</small>
          </span>
        </div>
      </section>
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
          <small>推荐 75–85；达到该占用比例后进入压缩。</small>
        </label>
        <label>
          压缩目标 %
          <input name="compactionTargetPercent" type="number" defaultValue="60" required />
          <small>推荐 55–65，必须低于软上限。</small>
        </label>
        <label>
          保留用户 Token
          <input name="compactionRecentUserTokens" type="number" defaultValue="16000" required />
          <small>优先保留近期用户输入，避免压缩丢失当前任务。</small>
        </label>
        <label>
          压缩输出 Token
          <input name="compactionMaxOutputTokens" type="number" defaultValue="4096" required />
          <small>不得超过当前启用模型的最大输出。</small>
        </label>
        <label>
          压缩超时（ms）
          <input name="compactionTimeoutMs" type="number" defaultValue="60000" required />
          <small>超时后 Run 失败关闭，不静默丢弃上下文。</small>
        </label>
        <label className="wide">
          变更原因
          <textarea name="reason" required maxLength={500} />
        </label>
        <button type="submit" className="primary-button" disabled={busy}>
          创建参数草稿
        </button>
      </form>
    </div>
  );
}

export function AdminControlConsole({
  view,
  api = defaultControlApi,
}: {
  readonly view: ControlView;
  readonly api?: AdminControlApiContract;
}) {
  const queryClient = useQueryClient();
  const [overview, setOverview] = useState<AdminControlOverviewDto>();
  const [items, setItems] = useState<
    readonly (ModelProviderRevisionDto | MemoryProviderRevisionDto | RuntimeSettingsRevisionDto)[]
  >([]);
  const [audits, setAudits] = useState<readonly ControlAuditEventDto[]>([]);
  const [catalogProviders, setCatalogProviders] = useState<readonly PiModelCatalogProviderDto[]>(
    listLocalPiModelCatalogProviders,
  );
  const [users, setUsers] = useState<PlatformUserPageDto>();
  const [identity, setIdentity] = useState<IdentityAdminConfigurationDto>();
  const [userQuery, setUserQuery] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const refreshSequence = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = refreshSequence.current + 1;
    refreshSequence.current = sequence;
    try {
      const [nextOverview, nextItems, nextAudits, nextCatalogProviders, nextUsers, nextIdentity] =
        await Promise.all([
          view === "identity"
            ? Promise.resolve(undefined)
            : queryClient.fetchQuery({
                queryKey: ["admin-control", "overview", view],
                queryFn: () => api.overview(),
                staleTime: 0,
              }),
          view === "models"
            ? queryClient.fetchQuery({
                queryKey: ["admin-control", "model-providers"],
                queryFn: () => api.listModelProviders(),
                staleTime: 0,
              })
            : view === "memory"
              ? queryClient.fetchQuery({
                  queryKey: ["admin-control", "memory-providers"],
                  queryFn: () => api.listMemoryProviders(),
                  staleTime: 0,
                })
              : view === "settings"
                ? queryClient.fetchQuery({
                    queryKey: ["admin-control", "runtime-settings"],
                    queryFn: () => api.listRuntimeSettings(),
                    staleTime: 0,
                  })
                : Promise.resolve([]),
          view === "overview" || view === "audits"
            ? queryClient.fetchQuery({
                queryKey: ["admin-control", "audits", view === "overview" ? 50 : 100],
                queryFn: () => api.listAudits(view === "overview" ? 50 : 100),
                staleTime: 0,
              })
            : Promise.resolve([]),
          view === "models"
            ? queryClient.fetchQuery({
                queryKey: ["admin-control", "model-catalog-providers"],
                queryFn: () => api.listPiModelCatalogProviders(),
              })
            : Promise.resolve([]),
          view === "users"
            ? queryClient.fetchQuery({
                queryKey: ["admin-control", "users", userQuery],
                queryFn: () =>
                  api.listUsers({
                    ...(userQuery.length === 0 ? {} : { query: userQuery }),
                    limit: 100,
                  }),
                staleTime: 0,
              })
            : Promise.resolve(undefined),
          view === "identity" ? api.getIdentityConfiguration() : Promise.resolve(undefined),
        ]);
      // 模块切换时旧请求可能晚于新请求返回；过期响应不能覆盖当前模块的数据。
      if (sequence !== refreshSequence.current) return;
      if (nextOverview !== undefined) setOverview(nextOverview);
      setItems(nextItems);
      setAudits(nextAudits);
      if (view === "models") setCatalogProviders(nextCatalogProviders);
      if (view === "users") setUsers(nextUsers);
      if (view === "identity") setIdentity(nextIdentity);
      setError(undefined);
    } catch (reason) {
      if (sequence !== refreshSequence.current) return;
      setError(errorMessage(reason));
    }
  }, [api, queryClient, userQuery, view]);

  useEffect(() => {
    setItems([]);
    void refresh();
  }, [refresh]);

  const performOperation = async (work: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: ["admin-control"] });
      await refresh();
      return true;
    } catch (reason) {
      const message = errorMessage(reason);
      await refresh();
      setError(message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const operation = async (work: () => Promise<unknown>): Promise<void> => {
    await performOperation(work);
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
              ? "运营驾驶舱"
              : view === "analytics"
                ? "数据运营"
                : view === "users"
                  ? "用户管理"
                  : view === "identity"
                    ? "身份与登录"
                    : view === "models"
                      ? "模型"
                      : view === "memory"
                        ? "记忆供应商"
                        : view === "audits"
                          ? "操作审计"
                          : "运行配置"}
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
      {view === "overview" ? (
        overview === undefined ? (
          error === undefined ? (
            <p className="empty-state large">正在加载控制面…</p>
          ) : (
            <ControlDataUnavailable
              title="运营数据暂不可用"
              description="后台控制服务尚未连接 PostgreSQL；配置说明仍可浏览，但真实用户、对话和运行统计无法读取。"
            />
          )
        ) : (
          <Overview value={overview} audits={audits} />
        )
      ) : view === "analytics" ? (
        overview === undefined ? (
          error === undefined ? (
            <p className="empty-state large">正在加载运营数据…</p>
          ) : (
            <ControlDataUnavailable
              title="真实统计暂不可用"
              description="统计直接来自 PostgreSQL 受限聚合投影；请恢复 uu 端口映射和后台控制服务后重试。"
            />
          )
        ) : (
          <OperationsDashboard value={overview} />
        )
      ) : view === "users" ? (
        <UserManagementWorkspace
          value={users}
          query={userQuery}
          busy={busy}
          onSearch={setUserQuery}
          onStatusChange={(userId, status, reason) =>
            operation(() => api.updateUserStatus(userId, { status, reason }))
          }
        />
      ) : view === "identity" ? (
        <IdentityConfigurationPanel
          {...(identity === undefined ? {} : { value: identity })}
          busy={busy}
          onSave={(input) => operation(() => api.updateIdentityConfiguration(input))}
        />
      ) : view === "audits" ? (
        <div className="audit-workspace">
          <section className="audit-workspace-hero">
            <div>
              <span className="eyebrow">Governance</span>
              <h2>控制面操作记录</h2>
              <p>配置探测、发布和治理动作由服务端记录；这里仅展示不可变审计事实。</p>
            </div>
            <span className="count">{audits.length}</span>
          </section>
          <AuditTrail items={audits} />
        </div>
      ) : (
        <>
          {view === "settings" && (
            <EnvironmentConfigurationGuide items={overview?.deploymentSettings ?? []} />
          )}
          <section className="control-panel">
            {view !== "models" && view !== "memory" && (
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">New revision</span>
                  <h2>创建配置草稿</h2>
                </div>
              </div>
            )}
            {view === "models" ? (
              <ModelProviderWorkspace
                api={api}
                busy={busy}
                catalogProviders={catalogProviders}
                {...(overview === undefined ? {} : { overview })}
                controlUnavailable={overview === undefined && error !== undefined}
                revisions={items.filter(
                  (item): item is ModelProviderRevisionDto => "models" in item.configuration,
                )}
                onCreate={(form, models, defaultModelId) =>
                  performOperation(async () => {
                    const draft = await api.createModelDraft({
                      providerKey: value(form, "providerKey"),
                      displayName: value(form, "displayName"),
                      protocol: "openai-compatible",
                      baseUrl: value(form, "baseUrl"),
                      defaultModelId,
                      models,
                      ...(secretValue(form, "apiKey") === ""
                        ? {
                            reuseCredentialFromRevision: number(
                              form,
                              "reuseCredentialFromRevision",
                            ),
                          }
                        : { apiKey: secretValue(form, "apiKey") }),
                      reason: "保存并使用模型配置",
                    });
                    await api.publish(
                      "model-providers",
                      draft.configuration.providerKey,
                      draft.revision,
                      {
                        expectedVersionToken: draft.versionToken,
                        reason: "保存并使用模型配置",
                      },
                    );
                  })
                }
              />
            ) : view === "memory" ? (
              <MemoryProviderWorkspace
                busy={busy}
                deploymentSettings={overview?.deploymentSettings ?? []}
                activeMemory={overview?.activeMemory}
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
          {view !== "models" && (
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
          )}
          {view === "settings" && <DeploymentSettings items={overview?.deploymentSettings ?? []} />}
        </>
      )}
    </main>
  );
}

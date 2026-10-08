import type {
  AdminControlOverviewDto,
  ControlAuditEventDto,
  IdentityAdminConfigurationDto,
  ModelProviderModelConfigurationDto,
  ModelProviderRevisionDto,
  PiModelCatalogModelDto,
  PiModelCatalogProviderDto,
  PlatformUserPageDto,
  RuntimeToolName,
} from "@hoox/protocol";
import { RUNTIME_TOOL_CATALOG } from "@hoox/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminApiError } from "./api.js";
import { AdminControlApi, type AdminControlApiContract } from "./control-api.js";
import { IdentityConfigurationPanel } from "./identity-configuration-panel.js";
import {
  ControlDataUnavailable,
  OperationsDashboard,
  UserManagementWorkspace,
} from "./operations-console.js";
import { listLocalPiModelCatalogProviders } from "./pi-model-catalog.js";

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

function providerHostname(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "接口地址待修复";
  }
}

const auditActionLabels = {
  create_draft: "保存配置",
  probe: "测试连接",
  publish: "使用配置",
  rollback: "恢复配置",
} as const;

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
                  {auditActionLabels[item.action]} · {displayedProviderKey(item.objectKey)}
                </strong>
                <span>操作者：{item.actorUserId}</span>
                <span>{item.reason}</span>
              </div>
              <span className={`audit-outcome ${item.outcome}`}>
                {item.outcome === "succeeded" ? "成功" : "失败"}
              </span>
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
          <span className="eyebrow">平台概况</span>
          <h2>平台运营驾驶舱</h2>
          <p>查看用户使用情况、运行状态和近期操作。</p>
        </div>
        <div className="active-stack">
          <span>
            模型：
            {overview.activeModel === undefined
              ? "由部署配置管理"
              : `${overview.activeModel.configuration.displayName} / ${overview.activeModel.configuration.defaultModelId}`}
          </span>
          <span>
            记忆：
            {overview.activeMemory === undefined && overview.activeModel === undefined
              ? "由部署配置管理"
              : overview.activeMemory?.configuration.enabled
                ? overview.activeMemory.configuration.displayName
                : "未启用"}
          </span>
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
  expectedGeneration,
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
  readonly expectedGeneration: number;
}) {
  const [providerKey] = useState(
    () =>
      initialConfiguration?.providerKey ??
      catalogProvider?.providerId ??
      `custom-${crypto.randomUUID()}`,
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
  const mergePiModels = useCallback((models: readonly PiModelCatalogModelDto[]) => {
    if (models.length === 0) {
      setCatalogMessage("Pi 目录中没有可添加的模型，可继续手工添加。");
      return;
    }
    setCatalog((current) => {
      const existing = new Set(current.models.map((model) => model.id));
      const additions = models
        .filter((model) => !existing.has(model.id))
        .map((model) => newModelRow(model, false));
      return {
        models: [...current.models, ...additions],
        defaultClientId: current.defaultClientId || additions[0]?.clientId || "",
      };
    });
    setCatalogMessage("已补充 Pi 目录中尚未保存的模型；现有字段保持不变。");
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
  const addPiModels = async () => {
    if (catalogProvider === undefined) return;
    setCatalogBusy(true);
    setCatalogMessage(undefined);
    try {
      mergePiModels(
        await api.findPiModelCatalogModels({ providerId: catalogProvider.providerId, limit: 100 }),
      );
    } catch {
      setCatalogMessage("暂时无法读取 Pi 模型目录，可继续手工配置。");
    } finally {
      setCatalogBusy(false);
    }
  };
  return (
    <form
      className="control-form model-provider-editor"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const models = catalog.models.map<ModelProviderModelConfigurationDto>((model) => ({
          id: model.id.trim(),
          name: model.name.trim() || model.id.trim(),
          enabled: model.clientId === catalog.defaultClientId,
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
              {catalogProvider === undefined ? "填写服务地址与密钥" : "模型目录已提供推荐能力参数"}
            </small>
          </span>
        </div>
        <button type="button" className="quiet-button" onClick={onCancel}>
          取消
        </button>
      </div>
      <input type="hidden" name="providerKey" value={providerKey} />
      <input type="hidden" name="expectedGeneration" value={expectedGeneration} />
      <label>
        显示名称
        <input
          name="displayName"
          required
          maxLength={120}
          defaultValue={initialConfiguration?.displayName ?? catalogProvider?.displayName ?? ""}
        />
      </label>
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
      <fieldset className="model-catalog-editor wide">
        <legend>模型</legend>
        <div className="model-catalog-toolbar">
          <span>
            <strong>模型能力</strong>
            <small>选择要使用的模型；能力参数可在高级设置中调整。</small>
          </span>
          <span className="provider-settings-actions">
            <button
              type="button"
              className="quiet-button"
              disabled={
                catalogProvider === undefined || catalogBusy || catalog.models.length >= 100
              }
              onClick={() => void addPiModels()}
            >
              {catalogBusy ? "正在读取…" : "从模型目录添加"}
            </button>
            <button
              type="button"
              className="quiet-button"
              disabled={catalog.models.length >= 100}
              onClick={addBlankModel}
            >
              手动添加模型
            </button>
          </span>
        </div>
        {catalogMessage !== undefined && <div className="catalog-message">{catalogMessage}</div>}
        {catalog.models.map((model, index) => (
          <article className="model-editor-row" key={model.clientId}>
            <div className="model-editor-heading">
              <span className="model-row-identity">
                <strong>{model.name.trim() || model.id.trim() || `模型 ${index + 1}`}</strong>
                <code>{model.id.trim() || "尚未填写模型 ID"}</code>
              </span>
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
                默认模型
              </label>
              <button
                type="button"
                className="text-button danger"
                disabled={catalog.models.length === 1 || catalog.defaultClientId === model.clientId}
                onClick={() => removeModel(model.clientId)}
              >
                删除
              </button>
            </div>
            <div className="model-identity-fields">
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
            </div>
            <details className="model-advanced-settings">
              <summary>高级能力设置</summary>
              <div className="model-advanced-fields">
                <label>
                  上下文窗口
                  <input
                    required
                    type="number"
                    min={1}
                    max={10_000_000}
                    value={model.contextWindow}
                    onChange={(event) =>
                      updateModel(model.clientId, { contextWindow: event.target.value })
                    }
                  />
                </label>
                <label>
                  最大输出 Token
                  <input
                    required
                    type="number"
                    min={1}
                    max={10_000_000}
                    value={model.maxTokens}
                    onChange={(event) =>
                      updateModel(model.clientId, { maxTokens: event.target.value })
                    }
                  />
                </label>
                <label className="checkbox compact">
                  <input
                    type="checkbox"
                    checked={model.supportsImages}
                    onChange={(event) =>
                      updateModel(model.clientId, { supportsImages: event.target.checked })
                    }
                  />
                  图片输入
                </label>
                <label className="checkbox compact">
                  <input
                    type="checkbox"
                    checked={model.reasoning}
                    onChange={(event) =>
                      updateModel(model.clientId, { reasoning: event.target.checked })
                    }
                  />
                  推理模型
                </label>
              </div>
            </details>
          </article>
        ))}
      </fieldset>
      <div className="model-editor-footer wide">
        <span className="provider-settings-actions">
          <button
            type="submit"
            className="primary-button"
            disabled={busy || catalogBusy || catalog.defaultClientId === ""}
          >
            {busy ? "正在保存…" : "保存并使用"}
          </button>
        </span>
      </div>
    </form>
  );
}

interface ModelEditorState {
  readonly key: string;
  readonly revision?: ModelProviderRevisionDto;
  readonly catalogProvider?: PiModelCatalogProviderDto;
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
              ? "控制服务不可用，暂时无法读取或保存模型配置。请检查部署网络与后台控制服务后重试。"
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
            ? "添加并保存供应商后，新任务会使用所选模型。"
            : "新任务使用这份配置，已经开始的任务保持不变。"}
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
  onTest,
  onActivate,
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
  readonly onTest: (revision: ModelProviderRevisionDto) => Promise<boolean>;
  readonly onActivate: (revision: ModelProviderRevisionDto) => Promise<boolean>;
}) {
  const [editor, setEditor] = useState<ModelEditorState>();
  const [showProviderCatalog, setShowProviderCatalog] = useState(false);
  const providers = useMemo(() => latestModelRevisions(revisions), [revisions]);
  const selectedRevision =
    editor?.revision === undefined
      ? undefined
      : revisions.find(
          (candidate) =>
            candidate.configuration.providerKey === editor.revision?.configuration.providerKey &&
            candidate.revision === editor.revision.revision,
        );
  useEffect(() => {
    if (editor !== undefined || providers.length === 0) return;
    const revision =
      providers.find(
        (candidate) =>
          candidate.status === "active" &&
          !isSecretLikeProviderKey(candidate.configuration.providerKey),
      ) ??
      providers.find((candidate) => !isSecretLikeProviderKey(candidate.configuration.providerKey));
    if (revision === undefined) return;
    const catalogProvider = catalogProviders.find(
      (candidate) => candidate.providerId === revision.configuration.providerKey,
    );
    setEditor({
      key: `revision:${revision.configuration.providerKey}:${revision.revision}`,
      revision,
      ...(catalogProvider === undefined ? {} : { catalogProvider }),
    });
  }, [catalogProviders, editor, providers]);

  const editRevision = (revision: ModelProviderRevisionDto) => {
    const catalogProvider = catalogProviders.find(
      (candidate) => candidate.providerId === revision.configuration.providerKey,
    );
    setEditor({
      key: `revision:${revision.configuration.providerKey}:${revision.revision}`,
      revision,
      ...(catalogProvider === undefined ? {} : { catalogProvider }),
    });
  };

  return (
    <div className="model-provider-workspace">
      <ModelEffectiveState
        {...(overview === undefined ? {} : { overview })}
        unavailable={controlUnavailable}
      />
      <div className="model-provider-layout">
        <aside className="provider-settings-pane" aria-label="已保存的供应商">
          <div className="provider-settings-heading">
            <span>
              <h2>供应商</h2>
              <p>已配置的供应商可直接测试或使用。</p>
            </span>
            <button
              type="button"
              className="primary-button"
              onClick={() => setShowProviderCatalog((visible) => !visible)}
            >
              添加供应商
            </button>
          </div>
          {showProviderCatalog && (
            <div className="provider-catalog-picker compact">
              <div>
                <span className="provider-catalog-title">
                  <strong>从模型目录添加</strong>
                  <small>{catalogProviders.length} 个</small>
                </span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setEditor({ key: `custom:${crypto.randomUUID()}` });
                    setShowProviderCatalog(false);
                  }}
                >
                  自定义供应商
                </button>
              </div>
              {catalogProviders.length === 0 ? (
                <p>Pi Provider 快照暂不可用，仍可添加自定义供应商。</p>
              ) : (
                <div className="provider-catalog-grid">
                  {catalogProviders.map((provider) => (
                    <button
                      type="button"
                      key={provider.providerId}
                      onClick={() => {
                        setEditor({
                          key: `catalog:${provider.providerId}:${crypto.randomUUID()}`,
                          catalogProvider: provider,
                        });
                        setShowProviderCatalog(false);
                      }}
                    >
                      <span className="provider-avatar">{provider.displayName.slice(0, 1)}</span>
                      <span>
                        <strong>{provider.displayName}</strong>
                        <small>{provider.modelCount} 个模型</small>
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
                  <strong>尚未配置供应商</strong>
                  <small>可选择内置供应商，也可接入兼容服务。</small>
                </span>
              </div>
            ) : (
              providers.map((revision) => {
                const configuration = revision.configuration;
                const sensitiveIdentifier = isSecretLikeProviderKey(configuration.providerKey);
                const selected =
                  selectedRevision?.configuration.providerKey === configuration.providerKey &&
                  selectedRevision.revision === revision.revision;
                const activeProvider =
                  overview?.activeModel?.configuration.providerKey === configuration.providerKey;
                const active =
                  activeProvider === true && overview.activeModel?.revision === revision.revision;
                return (
                  <article
                    key={configuration.providerKey}
                    className={`${selected ? "selected" : ""} ${activeProvider === true ? "active" : ""}`}
                  >
                    <button
                      type="button"
                      className="provider-select-button"
                      disabled={sensitiveIdentifier}
                      onClick={() => editRevision(revision)}
                    >
                      <span className="provider-avatar">
                        {configuration.displayName.slice(0, 1)}
                      </span>
                      <span className="provider-list-identity">
                        <strong>{configuration.displayName}</strong>
                        <small>默认模型：{configuration.defaultModelId}</small>
                        <small>{providerHostname(configuration.baseUrl)}</small>
                        {sensitiveIdentifier && <small>疑似密钥（已隐藏） · 已隔离</small>}
                      </span>
                    </button>
                    <span className={`model-test-badge ${revision.probeStatus}`}>
                      {revision.probeStatus === "healthy"
                        ? "测试成功"
                        : revision.probeStatus === "failed"
                          ? "测试失败"
                          : "未测试"}
                    </span>
                    <span className="provider-row-actions">
                      {activeProvider === true && (
                        <span className="status status-active">
                          {active ? "当前使用" : "当前使用旧配置"}
                        </span>
                      )}
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy || sensitiveIdentifier}
                        onClick={() => void onTest(revision)}
                      >
                        测试已保存配置
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy || active || sensitiveIdentifier}
                        onClick={() => void onActivate(revision)}
                      >
                        {active ? "使用中" : "使用"}
                      </button>
                    </span>
                  </article>
                );
              })
            )}
          </div>
        </aside>
        <section className="model-editor-pane" aria-label="供应商配置编辑器">
          {editor === undefined ? (
            <div className="model-editor-empty">
              <span className="provider-avatar">+</span>
              <strong>选择或添加一个供应商</strong>
              <p>保存后即可使用所选模型。</p>
            </div>
          ) : (
            <ModelDraftForm
              key={`${editor.key}:${overview?.generation ?? "unavailable"}`}
              api={api}
              busy={busy || overview === undefined}
              expectedGeneration={overview?.generation ?? 0}
              {...(selectedRevision === undefined
                ? {}
                : {
                    initialConfiguration: selectedRevision.configuration,
                    reuseCredentialFromRevision: selectedRevision.revision,
                  })}
              {...(editor.catalogProvider === undefined
                ? {}
                : { catalogProvider: editor.catalogProvider })}
              onCancel={() => setEditor(undefined)}
              onCreate={onCreate}
            />
          )}
        </section>
      </div>
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

function MemoryProviderWorkspace({
  onSave,
  busy,
  deploymentSettings,
  activeMemory,
  available,
}: {
  readonly onSave: (form: FormData) => Promise<void>;
  readonly busy: boolean;
  readonly deploymentSettings: AdminControlOverviewDto["deploymentSettings"];
  readonly activeMemory: AdminControlOverviewDto["activeMemory"];
  readonly available: boolean;
}) {
  const [validationError, setValidationError] = useState("");
  const configuration = activeMemory?.configuration;
  const enabled = configuration?.enabled ?? false;
  const ready =
    configuration?.apiSecretRef === "managed:memory-api" ||
    ["MEM0_API_KEY", "MEM0_SCOPE_HMAC_KEY"].every(
      (key) => deploymentState(deploymentSettings, key) === "configured",
    );
  return (
    <div className="memory-provider-workspace">
      <section className="memory-provider-hero">
        <span className="mem0-mark" aria-hidden="true">
          M
        </span>
        <div>
          <h2>长期记忆</h2>
          <p>让后续对话记住用户的长期偏好。保存后对新任务生效。</p>
        </div>
        <span className={`memory-active-state ${enabled ? "active" : "inactive"}`}>
          {!available ? "状态未知" : enabled ? "已开启" : "已关闭"}
        </span>
      </section>
      <form
        key={activeMemory?.revision ?? "initial"}
        className="control-form memory-control-form"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (!available || busy) return;
          const form = new FormData(event.currentTarget);
          if (form.get("enabled") === "on" && !ready && !value(form, "apiKey")) {
            setValidationError("请输入 Mem0 API Key 后再开启长期记忆。");
            return;
          }
          setValidationError("");
          void onSave(form);
        }}
      >
        <fieldset
          className="control-form wide memory-configuration-fields"
          disabled={busy || !available}
        >
          <label className="checkbox wide">
            <input name="enabled" type="checkbox" defaultChecked={enabled} />
            开启长期记忆
          </label>
          <p className="wide boundary-note">
            {ready
              ? "密钥已配置，留空保留现有密钥。"
              : "填入 Mem0 API Key 后即可开启，无需修改配置文件或重启服务。"}
          </p>
          <label className="wide">
            Mem0 API Key
            <input
              name="apiKey"
              type="password"
              autoComplete="new-password"
              maxLength={8192}
              onChange={() => setValidationError("")}
              placeholder={ready ? "留空保留现有密钥" : "输入 Mem0 API Key"}
            />
            <small>密钥加密保存，保存后不再显示。</small>
          </label>
          {validationError && (
            <p role="alert" className="wide">
              {validationError}
            </p>
          )}
          <details className="wide memory-connection-settings">
            <summary>服务连接设置</summary>
            <div className="control-form">
              <label>
                显示名称
                <input
                  name="displayName"
                  required
                  defaultValue={configuration?.displayName ?? "Mem0 Platform"}
                />
              </label>
              <label className="wide">
                服务地址
                <input
                  name="baseUrl"
                  required
                  type="url"
                  defaultValue={configuration?.baseUrl ?? "https://api.mem0.ai/"}
                />
              </label>
              <label>
                请求超时（毫秒）
                <input
                  name="requestTimeoutMs"
                  type="number"
                  min="100"
                  max="120000"
                  required
                  defaultValue={configuration?.requestTimeoutMs ?? 10000}
                />
              </label>
            </div>
          </details>
          <button type="submit" className="primary-button" disabled={busy || !available}>
            {busy ? "正在保存…" : "保存并生效"}
          </button>
        </fieldset>
      </form>
    </div>
  );
}

const runtimeSettingFields = [
  ["workerMaxConcurrentRuns", "每个 Worker 同时运行的任务数", 1, 100, 20],
  ["userMaxConcurrentRunsPerTenant", "每位用户同时运行的任务数", 1, 100, 2],
  ["compactionSoftLimitPercent", "开始压缩的上下文占比（%）", 50, 95, 80],
  ["compactionTargetPercent", "压缩后的目标占比（%）", 20, 90, 55],
  ["compactionRecentUserTokens", "保留的近期用户内容（Token）", 1, 1000000, 4096],
  ["compactionMaxOutputTokens", "压缩摘要最大长度（Token）", 128, 1000000, 4096],
  ["compactionTimeoutMs", "压缩请求超时（毫秒）", 1000, 600000, 60000],
] as const;

const runtimeToolGroups = [...new Set(RUNTIME_TOOL_CATALOG.map((tool) => tool.group))];

function RuntimeToolSelection({
  enabledTools,
}: {
  readonly enabledTools: readonly RuntimeToolName[] | undefined;
}) {
  // 表单按配置 revision 重挂载；保存失败不会重置尚未保存的勾选。
  const [selected, setSelected] = useState(
    () => new Set(enabledTools ?? RUNTIME_TOOL_CATALOG.map((tool) => tool.name)),
  );
  return (
    <section className="runtime-tool-selection" aria-labelledby="runtime-tools-heading">
      <div className="runtime-tool-heading">
        <h3 id="runtime-tools-heading">可用工具</h3>
        <div className="runtime-tool-actions">
          <button
            type="button"
            className="quiet-button"
            onClick={() => setSelected(new Set(RUNTIME_TOOL_CATALOG.map((tool) => tool.name)))}
          >
            全选
          </button>
          <button type="button" className="quiet-button" onClick={() => setSelected(new Set())}>
            全部关闭
          </button>
        </div>
      </div>
      <p id="runtime-tools-description" className="runtime-tool-description">
        正常模式与 PTC 模式共用此工具名单。名单在 Worker 首次建立 Run 配置快照时固定；已有快照的 Run
        执行和恢复均保持原名单。run_code 与 collapse_process_for_final_answer
        属于框架机制，不参与勾选。
      </p>
      <p className="runtime-tool-description">
        工具选择不能替代沙箱隔离：exec_command 仍可操作文件，关闭 read 不代表禁止读取文件系统。
      </p>
      <div className="runtime-tool-groups" aria-describedby="runtime-tools-description">
        {runtimeToolGroups.map((group) => (
          <fieldset key={group} className="runtime-tool-group">
            <legend>{group}</legend>
            <div className="runtime-tool-options">
              {RUNTIME_TOOL_CATALOG.filter((tool) => tool.group === group).map((tool) => (
                <label key={tool.name} className="runtime-tool-option">
                  <input
                    type="checkbox"
                    name="enabledTools"
                    value={tool.name}
                    checked={selected.has(tool.name)}
                    aria-describedby={`runtime-tool-description-${tool.name}`}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setSelected((previous) => {
                        const next = new Set(previous);
                        if (checked) next.add(tool.name);
                        else next.delete(tool.name);
                        return next;
                      });
                    }}
                  />
                  <span className="runtime-tool-content">
                    <span className="runtime-tool-name">
                      <strong>{tool.label}</strong>
                      <code>{tool.name}</code>
                    </span>
                    <small id={`runtime-tool-description-${tool.name}`}>{tool.description}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
    </section>
  );
}

function RuntimeSettingsWorkspace({
  overview,
  busy,
  onSave,
}: {
  readonly overview: AdminControlOverviewDto | undefined;
  readonly busy: boolean;
  readonly onSave: (form: FormData) => Promise<void>;
}) {
  const configuration = overview?.activeRuntimeSettings?.configuration;
  return (
    <section className="control-panel">
      <h2>运行设置</h2>
      <p>
        保存后无需重启。并发上限影响新任务领取，上下文压缩设置对新任务生效，正在执行的任务继续完成。
      </p>
      {overview !== undefined && configuration === undefined && (
        <p>尚未保存后台设置，下面为推荐默认值；保存前继续使用部署默认值。</p>
      )}
      <form
        key={overview?.activeRuntimeSettings?.revision ?? "defaults"}
        className="control-form runtime-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave(new FormData(event.currentTarget));
        }}
      >
        <input type="hidden" name="expectedGeneration" value={overview?.generation ?? 0} />
        <fieldset disabled={busy || overview === undefined}>
          <label htmlFor="runtime-tool-calling-mode">工具调用模式</label>
          <select
            id="runtime-tool-calling-mode"
            name="toolCallingMode"
            aria-describedby="runtime-tool-calling-mode-description"
            defaultValue={configuration?.toolCallingMode ?? "native"}
          >
            <option value="native">正常模式</option>
            <option value="ptc">PTC 模式（实验）</option>
          </select>
          <p id="runtime-tool-calling-mode-description">
            工具调用模式在 Worker 首次建立 Run 配置快照时固定；已有快照的 Run
            执行和恢复均保持原模式。
          </p>
          <RuntimeToolSelection enabledTools={configuration?.enabledTools} />
          <div className="form-grid">
            {runtimeSettingFields.slice(0, 2).map(([name, label, min, max, fallback]) => (
              <label key={name}>
                {label}
                <input
                  name={name}
                  type="number"
                  min={min}
                  max={max}
                  required
                  defaultValue={configuration?.[name] ?? fallback}
                />
              </label>
            ))}
          </div>
          <details>
            <summary>上下文压缩设置</summary>
            <div className="form-grid">
              {runtimeSettingFields.slice(2).map(([name, label, min, max, fallback]) => (
                <label key={name}>
                  {label}
                  <input
                    name={name}
                    type="number"
                    min={min}
                    max={max}
                    required
                    defaultValue={configuration?.[name] ?? fallback}
                  />
                </label>
              ))}
            </div>
          </details>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || overview === undefined}
          >
            {busy ? "正在保存…" : "保存并生效"}
          </button>
        </fieldset>
      </form>
    </section>
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
  const [items, setItems] = useState<readonly ModelProviderRevisionDto[]>([]);
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
      // 失败时保留输入与原并发检查值；用户显式刷新后才能基于新配置继续编辑。
      setError(errorMessage(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const operation = async (work: () => Promise<unknown>): Promise<void> => {
    await performOperation(work);
  };

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
                      ? "模型配置"
                      : view === "memory"
                        ? "记忆供应商"
                        : view === "audits"
                          ? "操作审计"
                          : "运行配置"}
          </h1>
          {view === "models" && <p>管理供应商、模型能力与运行时切换</p>}
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
              description="统计直接来自 PostgreSQL 受限聚合投影；请检查部署网络和后台控制服务后重试。"
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
          onStatusChange={(userId, status) =>
            performOperation(() => api.updateUserStatus(userId, { status }))
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
      ) : view === "settings" ? (
        <RuntimeSettingsWorkspace
          overview={overview}
          busy={busy}
          onSave={(form) =>
            operation(() =>
              api.saveRuntimeSettingsConfiguration({
                toolCallingMode: form.get("toolCallingMode") === "ptc" ? "ptc" : "native",
                enabledTools: form.getAll("enabledTools") as RuntimeToolName[],
                workerMaxConcurrentRuns: number(form, "workerMaxConcurrentRuns"),
                userMaxConcurrentRunsPerTenant: number(form, "userMaxConcurrentRunsPerTenant"),
                compactionSoftLimitPercent: number(form, "compactionSoftLimitPercent"),
                compactionTargetPercent: number(form, "compactionTargetPercent"),
                compactionRecentUserTokens: number(form, "compactionRecentUserTokens"),
                compactionMaxOutputTokens: number(form, "compactionMaxOutputTokens"),
                compactionTimeoutMs: number(form, "compactionTimeoutMs"),
                expectedGeneration: number(form, "expectedGeneration"),
              }),
            )
          }
        />
      ) : view === "models" ? (
        <section className="control-panel">
          <ModelProviderWorkspace
            api={api}
            busy={busy}
            catalogProviders={catalogProviders}
            {...(overview === undefined ? {} : { overview })}
            controlUnavailable={overview === undefined && error !== undefined}
            revisions={items}
            onCreate={(form, models, defaultModelId) =>
              performOperation(() =>
                api.saveModelConfiguration({
                  expectedGeneration: number(form, "expectedGeneration"),
                  providerKey: value(form, "providerKey"),
                  displayName: value(form, "displayName"),
                  protocol: "openai-compatible",
                  baseUrl: value(form, "baseUrl"),
                  defaultModelId,
                  models,
                  ...(secretValue(form, "apiKey") === ""
                    ? { reuseCredentialFromRevision: number(form, "reuseCredentialFromRevision") }
                    : { apiKey: secretValue(form, "apiKey") }),
                }),
              )
            }
            onTest={(revision) =>
              performOperation(() =>
                api.probe(
                  "model-providers",
                  revision.configuration.providerKey,
                  revision.revision,
                  { expectedVersionToken: revision.versionToken },
                ),
              )
            }
            onActivate={(revision) =>
              performOperation(() =>
                api.publish(
                  "model-providers",
                  revision.configuration.providerKey,
                  revision.revision,
                  { expectedVersionToken: revision.versionToken },
                ),
              )
            }
          />
        </section>
      ) : (
        <section className="control-panel">
          <MemoryProviderWorkspace
            busy={busy}
            deploymentSettings={overview?.deploymentSettings ?? []}
            activeMemory={overview?.activeMemory}
            available={overview !== undefined}
            onSave={(form) =>
              operation(() =>
                api.saveMemoryConfiguration({
                  expectedGeneration: overview?.generation ?? 0,
                  providerKey: overview?.activeMemory?.configuration.providerKey ?? "mem0",
                  displayName: value(form, "displayName"),
                  providerKind: "mem0",
                  baseUrl: value(form, "baseUrl"),
                  apiSecretRef:
                    value(form, "apiKey") ||
                    overview?.activeMemory?.configuration.apiSecretRef === "managed:memory-api"
                      ? "managed:memory-api"
                      : "deployment:memory-api",
                  scopeSecretRef:
                    value(form, "apiKey") ||
                    overview?.activeMemory?.configuration.apiSecretRef === "managed:memory-api"
                      ? "platform:memory-scope"
                      : "deployment:memory-scope",
                  ...(value(form, "apiKey")
                    ? { apiKey: value(form, "apiKey") }
                    : overview?.activeMemory?.configuration.apiSecretRef === "managed:memory-api"
                      ? { reuseCredentialFromRevision: overview.activeMemory.revision }
                      : {}),
                  requestTimeoutMs: number(form, "requestTimeoutMs"),
                  enabled: form.get("enabled") === "on",
                }),
              )
            }
          />
        </section>
      )}
    </main>
  );
}

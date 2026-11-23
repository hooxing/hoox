import {
  type AgentPinnedModelReferenceDto,
  isIsoUtcTimestamp,
  normalizeRuntimeToolSelection,
  type RuntimeToolName,
} from "@hoox/protocol";
import { createHash } from "node:crypto";

export * from "./agent-definition.js";
export * from "./external-tools.js";
export * from "./run-compaction-settings.js";
export * from "./run-explorer.js";
export * from "./sandbox-configuration.js";

export type ControlOperatorRole = "viewer" | "operator" | "admin";
export type ControlRevisionStatus = "draft" | "active" | "retired";
export type ProviderProbeStatus = "untested" | "healthy" | "failed";
export type ProviderSecretRef =
  | "deployment:model"
  | "deployment:memory-api"
  | "deployment:memory-scope";

export type ModelInputCapability = "text" | "image";

export interface ModelPricingConfiguration {
  readonly currency: string;
  readonly inputPerMillion?: number;
  readonly outputPerMillion?: number;
  readonly cacheReadPerMillion?: number;
}

/** 对齐 Pi Provider 模型的必要字段；enabled 是平台控制面的发布策略。 */
export interface ModelProviderModelConfiguration {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly reasoning: boolean;
  readonly input: readonly ModelInputCapability[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly pricing?: ModelPricingConfiguration;
}

export interface ModelProviderConfiguration {
  readonly providerKey: string;
  readonly displayName: string;
  readonly protocol: "openai-compatible";
  readonly baseUrl: string;
  /** 只表示该 Revision 已绑定托管凭据，任何读取接口都不得返回凭据值。 */
  readonly credentialConfigured: boolean;
  readonly defaultModelId: string;
  readonly models: readonly ModelProviderModelConfiguration[];
}

export interface MemoryProviderConfiguration {
  readonly providerKey: string;
  readonly displayName: string;
  readonly providerKind: "mem0";
  readonly baseUrl: string;
  readonly apiSecretRef: "deployment:memory-api" | "managed:memory-api";
  readonly scopeSecretRef: "deployment:memory-scope" | "platform:memory-scope";
  readonly requestTimeoutMs: number;
  readonly enabled: boolean;
}

export const DEFAULT_WORKER_MAX_CONCURRENT_RUNS = 20;
export const DEFAULT_USER_MAX_CONCURRENT_RUNS_PER_TENANT = 2;

export type TitleGenerationConfiguration =
  | Readonly<{ enabled: false }>
  | Readonly<{ enabled: true; providerKey: string; providerRevision: number; modelId: string }>;

export interface RuntimeSettingsConfiguration {
  readonly titleGeneration?: TitleGenerationConfiguration;
  readonly compactionEnabled?: boolean;
  readonly enabledTools?: readonly RuntimeToolName[];
  readonly toolCallingMode?: "native" | "ptc";
  readonly workerMaxConcurrentRuns: number;
  readonly userMaxConcurrentRunsPerTenant: number;
  readonly compactionSoftLimitPercent: number;
  readonly compactionTargetPercent: number;
  readonly compactionRecentUserTokens: number;
  readonly compactionMaxOutputTokens: number;
  readonly compactionTimeoutMs: number;
}

export interface ControlRevision<T> {
  readonly revision: number;
  readonly versionToken: number;
  readonly status: ControlRevisionStatus;
  readonly configuration: T;
  readonly probeStatus: ProviderProbeStatus;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activatedAt?: string;
}

export interface ControlAuditEvent {
  readonly auditId: string;
  readonly actorUserId: string;
  readonly objectKind: "model_provider" | "memory_provider" | "runtime_settings";
  readonly objectKey: string;
  readonly revision: number;
  readonly action: "create_draft" | "probe" | "publish" | "rollback";
  readonly reason: string;
  readonly outcome: "succeeded" | "failed";
  readonly createdAt: string;
}

export interface RuntimeStatistics {
  readonly generatedAt: string;
  readonly users: Readonly<{
    readonly total: number;
    readonly registered24h: number;
    readonly active7d: number;
    readonly disabled: number;
  }>;
  readonly conversations: Readonly<{
    readonly total: number;
    readonly created24h: number;
    readonly active24h: number;
    readonly archived: number;
  }>;
  readonly runs: Readonly<{
    readonly total: number;
    readonly queued: number;
    readonly running: number;
    readonly succeeded24h: number;
    readonly failed24h: number;
    readonly cancelled24h: number;
  }>;
  readonly dispatch: Readonly<{ readonly pending: number; readonly claimed: number }>;
  readonly sandboxes: Readonly<{
    readonly active: number;
    readonly paused: number;
    readonly cleanupPending: number;
  }>;
  readonly memory: Readonly<{ readonly pending: number; readonly failed: number }>;
  readonly automations: Readonly<{
    readonly active: number;
    readonly failedOccurrences24h: number;
  }>;
  readonly skills: Readonly<{ readonly published: number; readonly installed: number }>;
  readonly modelUsage24h: Readonly<{
    /** 未缓存输入与缓存读取之和。 */
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly outputTokensPerSecond: number | null;
    readonly cacheHitRate: number | null;
  }>;
}

export type PlatformUserStatus = "active" | "disabled";

export interface PlatformUserSummary {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly source?: "api_mapping";
  readonly status: PlatformUserStatus;
  readonly createdAt: string;
  readonly lastActiveAt?: string;
  readonly activeSessions: number;
  readonly conversationCount: number;
  readonly runCount: number;
}

export interface PlatformUserPage {
  readonly items: readonly PlatformUserSummary[];
  readonly total: number;
}

export interface DeploymentSettingDescriptor {
  readonly key: string;
  readonly category: "bootstrap" | "secret" | "restart_required";
  readonly source: "environment";
  readonly configured: boolean;
  readonly mutable: false;
  readonly description: string;
}

export interface AdminControlOverview {
  readonly runtimeEnvironment?: "development" | "test" | "production";
  readonly generation: number;
  readonly activeModel?: ControlRevision<ModelProviderConfiguration>;
  readonly activeMemory?: ControlRevision<MemoryProviderConfiguration>;
  readonly activeRuntimeSettings?: ControlRevision<RuntimeSettingsConfiguration>;
  readonly statistics: RuntimeStatistics;
  readonly deploymentSettings: readonly DeploymentSettingDescriptor[];
}

export type ControlObjectKind = ControlAuditEvent["objectKind"];

export interface CreateModelProviderDraftCommand
  extends Omit<ModelProviderConfiguration, "credentialConfigured"> {
  /** 写入后即加密，绝不能进入配置投影、响应或日志。 */
  readonly apiKey?: string;
  /** 编辑时允许复用同一 Provider 的既有密文，不需要回显密钥。 */
  readonly reuseCredentialFromRevision?: number;
}

export interface CreateMemoryProviderDraftCommand extends MemoryProviderConfiguration {
  readonly reason?: string;
}

export interface SaveModelProviderConfigurationCommand extends CreateModelProviderDraftCommand {
  readonly expectedGeneration: number;
}

export interface SaveMemoryProviderConfigurationCommand extends CreateMemoryProviderDraftCommand {
  readonly expectedGeneration: number;
  readonly apiKey?: string;
  readonly reuseCredentialFromRevision?: number;
}

export interface CreateRuntimeSettingsDraftCommand extends RuntimeSettingsConfiguration {
  readonly reason: string;
}

export interface SaveRuntimeSettingsConfigurationCommand extends RuntimeSettingsConfiguration {
  readonly expectedGeneration: number;
}

export interface PublishControlRevisionCommand {
  readonly expectedVersionToken: number;
  readonly reason?: string;
}

export interface ProbeControlRevisionCommand {
  readonly expectedVersionToken: number;
  readonly reason: string;
}

export interface ControlMutationContext {
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
}

export type ControlMutationResult<T> =
  | { readonly outcome: "applied" | "replayed"; readonly value: T }
  | { readonly outcome: "not_found" | "conflict" | "not_authorized" | "key_conflict" };

export interface AdminControlRepository {
  resolveRole(userId: string): Promise<ControlOperatorRole | undefined>;
  readAgentMetrics?(input: AgentMetricsQuery): Promise<readonly AgentMetricsBucket[]>;
  generation(userId: string): Promise<number>;
  listModelProviders(
    userId: string,
  ): Promise<readonly ControlRevision<ModelProviderConfiguration>[]>;
  listMemoryProviders(
    userId: string,
  ): Promise<readonly ControlRevision<MemoryProviderConfiguration>[]>;
  listRuntimeSettings(
    userId: string,
  ): Promise<readonly ControlRevision<RuntimeSettingsConfiguration>[]>;
  getActiveRuntimeSettings(
    userId: string,
  ): Promise<ControlRevision<RuntimeSettingsConfiguration> | undefined>;
  createModelDraft(
    input: ControlMutationContext & {
      readonly command: CreateModelProviderDraftCommand & { readonly reason: string };
    },
  ): Promise<ControlMutationResult<ControlRevision<ModelProviderConfiguration>>>;
  resolveModelCredential(
    userId: string,
    providerKey: string,
    revision: number,
  ): Promise<string | undefined>;
  resolveMemoryCredential?(
    userId: string,
    providerKey: string,
    revision: number,
  ): Promise<string | undefined>;
  createMemoryDraft(
    input: ControlMutationContext & {
      readonly command: CreateMemoryProviderDraftCommand & { readonly reason: string };
    },
  ): Promise<ControlMutationResult<ControlRevision<MemoryProviderConfiguration>>>;
  saveModelConfiguration(
    input: ControlMutationContext & {
      readonly command: SaveModelProviderConfigurationCommand & { readonly reason: string };
    },
  ): Promise<ControlMutationResult<ControlRevision<ModelProviderConfiguration>>>;
  saveMemoryConfiguration(
    input: ControlMutationContext & {
      readonly command: SaveMemoryProviderConfigurationCommand & { readonly reason: string };
    },
  ): Promise<ControlMutationResult<ControlRevision<MemoryProviderConfiguration>>>;
  createRuntimeSettingsDraft(
    input: ControlMutationContext & { readonly command: CreateRuntimeSettingsDraftCommand },
  ): Promise<ControlMutationResult<ControlRevision<RuntimeSettingsConfiguration>>>;
  saveRuntimeSettingsConfiguration(
    input: ControlMutationContext & {
      readonly command: SaveRuntimeSettingsConfigurationCommand & { readonly reason: string };
    },
  ): Promise<ControlMutationResult<ControlRevision<RuntimeSettingsConfiguration>>>;
  recordProbe(
    input: ControlMutationContext & {
      readonly kind: "model_provider" | "memory_provider";
      readonly objectKey: string;
      readonly revision: number;
      readonly expectedVersionToken: number;
      readonly reason: string;
      readonly status: Exclude<ProviderProbeStatus, "untested">;
    },
  ): Promise<
    ControlMutationResult<
      ControlRevision<ModelProviderConfiguration> | ControlRevision<MemoryProviderConfiguration>
    >
  >;
  publish(
    input: ControlMutationContext & {
      readonly kind: ControlObjectKind;
      readonly objectKey: string;
      readonly revision: number;
      readonly expectedVersionToken: number;
      readonly reason: string;
    },
  ): Promise<
    ControlMutationResult<
      | ControlRevision<ModelProviderConfiguration>
      | ControlRevision<MemoryProviderConfiguration>
      | ControlRevision<RuntimeSettingsConfiguration>
    >
  >;
  listAudits(userId: string, limit: number): Promise<readonly ControlAuditEvent[]>;
  listUsers(input: {
    readonly actorUserId: string;
    readonly query?: string;
    readonly limit: number;
  }): Promise<PlatformUserPage>;
  updateUserStatus(
    input: ControlMutationContext & {
      readonly targetUserId: string;
      readonly status: PlatformUserStatus;
      readonly reason: string;
    },
  ): Promise<ControlMutationResult<PlatformUserSummary>>;
}

export interface AgentMetricsQuery {
  readonly actorUserId: string;
  readonly from: string;
  readonly to: string;
  readonly agentDefinitionId?: string;
  readonly agentRevisionId?: string;
  readonly tenantId?: string;
  readonly origin?: "normal" | "api" | "playground" | "evaluation";
}

export interface AgentMetricsBucket {
  readonly windowStart: string;
  readonly agentDefinitionId: string | null;
  readonly agentRevisionId: string | null;
  readonly tenantId: string;
  readonly origin: string;
  readonly currency: string | null;
  readonly runCount: number;
  readonly succeededCount: number;
  readonly failedCount: number;
  readonly resultUnknownCount: number;
  readonly successRate: number | null;
  readonly failureRate: number | null;
  readonly resultUnknownRate: number | null;
  readonly feedbackUpCount: number;
  readonly feedbackDownCount: number;
  readonly feedbackUpRate: number | null;
  readonly feedbackDownRate: number | null;
  readonly toolFailureRate: number | null;
  readonly latencyP50Ms: number | null;
  readonly latencyP90Ms: number | null;
  readonly latencyP99Ms: number | null;
  readonly averageModelRounds: number | null;
  readonly toolCalls: number;
  readonly failedToolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cost: number | null;
}

export interface AdminControlStatisticsPort {
  read(userId: string): Promise<RuntimeStatistics>;
}

export interface ProviderProbePort {
  probeModel(configuration: ModelProviderConfiguration, apiKey: string): Promise<void>;
  probeMemory(configuration: MemoryProviderConfiguration, apiKey?: string): Promise<void>;
}

export class AdminControlServiceError extends Error {
  constructor(
    readonly code:
      | "NOT_AUTHORIZED"
      | "NOT_FOUND"
      | "CONFLICT"
      | "KEY_CONFLICT"
      | "PROBE_FAILED"
      | "INVALID_INPUT",
  ) {
    super(code);
    this.name = "AdminControlServiceError";
  }
}

const providerKeyPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const secretLikeProviderKeyPattern =
  /^(?:(?:sk|rk|pk)[._-][a-z0-9_-]{16,}|(?:gh[pousr]|xox[baprs]|hf)[_-][a-z0-9_-]{16,})$/iu;
const redactedProviderKey = "sensitive-identifier-redacted";

function normalizedText(value: string, name: string, maximum: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length < 1 || Array.from(normalized).length > maximum) {
    throw new TypeError(`${name} 长度无效`);
  }
  return normalized;
}

function normalizedProviderKey(value: string): string {
  const trimmed = value.trim();
  if (secretLikeProviderKeyPattern.test(trimmed)) {
    throw new TypeError("Provider 内部标识疑似包含 API Key");
  }
  return normalizedStoredProviderKey(trimmed);
}

function normalizedStoredProviderKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!providerKeyPattern.test(normalized)) throw new TypeError("Provider Key 格式无效");
  return normalized;
}

function redactedModelRevision(
  value: ControlRevision<ModelProviderConfiguration>,
): ControlRevision<ModelProviderConfiguration> {
  if (!secretLikeProviderKeyPattern.test(value.configuration.providerKey)) return value;
  return {
    ...value,
    configuration: { ...value.configuration, providerKey: redactedProviderKey },
  };
}

function redactedMemoryRevision(
  value: ControlRevision<MemoryProviderConfiguration>,
): ControlRevision<MemoryProviderConfiguration> {
  if (!secretLikeProviderKeyPattern.test(value.configuration.providerKey)) return value;
  return {
    ...value,
    configuration: { ...value.configuration, providerKey: redactedProviderKey },
  };
}

function redactedAuditEvent(value: ControlAuditEvent): ControlAuditEvent {
  if (!secretLikeProviderKeyPattern.test(value.objectKey)) return value;
  return { ...value, objectKey: redactedProviderKey };
}

function normalizedUserId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(normalized)) {
    throw new TypeError("用户 ID 格式无效");
  }
  return normalized;
}

function normalizedUserQuery(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  if (normalized === undefined || normalized.length === 0) return undefined;
  if (Array.from(normalized).length > 120) throw new TypeError("用户查询条件过长");
  return normalized;
}

function normalizedHttpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Provider 地址不是有效 URL");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new TypeError("Provider 地址必须是无凭据 HTTPS URL");
  }
  url.hash = "";
  return url.href;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} 超出允许范围`);
  }
  return value;
}

function normalizedModelProviderConfiguration(
  input: ModelProviderConfiguration,
  providerKey: string,
): ModelProviderConfiguration {
  if (input.protocol !== "openai-compatible") throw new TypeError("模型协议不受支持");
  if (typeof input.credentialConfigured !== "boolean") throw new TypeError("模型凭据状态无效");
  if (!Array.isArray(input.models) || input.models.length < 1 || input.models.length > 100) {
    throw new TypeError("Provider 模型数量无效");
  }
  const identifiers = new Set<string>();
  const models = input.models.map((model) => {
    const id = normalizedText(model.id, "模型 ID", 255);
    if (identifiers.has(id)) throw new TypeError("Provider 内模型 ID 不能重复");
    identifiers.add(id);
    if (typeof model.enabled !== "boolean" || typeof model.reasoning !== "boolean") {
      throw new TypeError("模型启用和推理能力必须是布尔值");
    }
    if (!Array.isArray(model.input) || model.input.length < 1 || model.input.length > 2) {
      throw new TypeError("模型输入能力无效");
    }
    const capabilities = model.input.map((capability: ModelInputCapability) => {
      if (capability !== "text" && capability !== "image") {
        throw new TypeError("模型输入能力不受支持");
      }
      return capability;
    });
    if (new Set(capabilities).size !== capabilities.length || !capabilities.includes("text")) {
      throw new TypeError("模型输入能力必须包含且不能重复 text");
    }
    const contextWindow = boundedInteger(model.contextWindow, "上下文窗口", 1, 10_000_000);
    const maxTokens = boundedInteger(model.maxTokens, "最大输出 Token", 1, 10_000_000);
    if (maxTokens > contextWindow) throw new TypeError("最大输出 Token 不能超过上下文窗口");
    let pricing: ModelPricingConfiguration | undefined;
    if (model.pricing !== undefined) {
      if (!/^[A-Z]{3}$/.test(model.pricing.currency))
        throw new TypeError("计价币种必须是三位大写代码");
      for (const [label, price] of [
        ["输入", model.pricing.inputPerMillion],
        ["输出", model.pricing.outputPerMillion],
        ["缓存读取", model.pricing.cacheReadPerMillion],
      ] as const) {
        if (
          price !== undefined &&
          (!Number.isFinite(price) ||
            price < 0 ||
            price > 1_000_000 ||
            Number(price.toFixed(6)) !== price)
        ) {
          throw new TypeError(`${label}单价无效`);
        }
      }
      pricing = Object.freeze({
        currency: model.pricing.currency,
        ...(model.pricing.inputPerMillion === undefined
          ? {}
          : { inputPerMillion: model.pricing.inputPerMillion }),
        ...(model.pricing.outputPerMillion === undefined
          ? {}
          : { outputPerMillion: model.pricing.outputPerMillion }),
        ...(model.pricing.cacheReadPerMillion === undefined
          ? {}
          : { cacheReadPerMillion: model.pricing.cacheReadPerMillion }),
      });
    }
    return Object.freeze({
      id,
      name: normalizedText(model.name, "模型名称", 120),
      enabled: model.enabled,
      reasoning: model.reasoning,
      input: Object.freeze(capabilities),
      contextWindow,
      maxTokens,
      ...(pricing === undefined ? {} : { pricing }),
    });
  });
  if (!models.some((model) => model.enabled)) throw new TypeError("至少需要启用一个模型");
  const defaultModelId = normalizedText(input.defaultModelId, "默认模型 ID", 255);
  if (!models.some((model) => model.id === defaultModelId && model.enabled)) {
    throw new TypeError("默认模型必须引用已启用模型");
  }
  return Object.freeze({
    providerKey,
    displayName: normalizedText(input.displayName, "显示名称", 120),
    protocol: "openai-compatible",
    baseUrl: normalizedHttpsUrl(input.baseUrl),
    credentialConfigured: input.credentialConfigured,
    defaultModelId,
    models: Object.freeze(models),
  });
}

export function normalizeModelProviderConfiguration(
  input: ModelProviderConfiguration,
): ModelProviderConfiguration {
  return normalizedModelProviderConfiguration(input, normalizedProviderKey(input.providerKey));
}

/** 持久化读取保留历史对象键；写入期疑似密钥门禁不得阻断已有 Revision 的安全投影。 */
export function normalizeStoredModelProviderConfiguration(
  input: ModelProviderConfiguration,
): ModelProviderConfiguration {
  return normalizedModelProviderConfiguration(
    input,
    normalizedStoredProviderKey(input.providerKey),
  );
}

export function defaultModelConfiguration(
  configuration: ModelProviderConfiguration,
): ModelProviderModelConfiguration {
  const model = configuration.models.find(
    (candidate) => candidate.id === configuration.defaultModelId && candidate.enabled,
  );
  if (model === undefined) throw new TypeError("默认模型配置损坏");
  return model;
}

function normalizedMemoryProviderConfiguration(
  input: MemoryProviderConfiguration,
  providerKey: string,
): MemoryProviderConfiguration {
  if (input.providerKind !== "mem0") throw new TypeError("记忆 Provider 类型不受支持");
  if (
    !["deployment:memory-api", "managed:memory-api"].includes(input.apiSecretRef) ||
    !["deployment:memory-scope", "platform:memory-scope"].includes(input.scopeSecretRef)
  ) {
    throw new TypeError("记忆 Secret Ref 不受支持");
  }
  return Object.freeze({
    providerKey,
    displayName: normalizedText(input.displayName, "显示名称", 120),
    providerKind: "mem0",
    baseUrl: normalizedHttpsUrl(input.baseUrl),
    apiSecretRef: input.apiSecretRef,
    scopeSecretRef: input.scopeSecretRef,
    requestTimeoutMs: boundedInteger(input.requestTimeoutMs, "记忆请求超时", 100, 120_000),
    enabled: input.enabled,
  });
}

export function normalizeMemoryProviderConfiguration(
  input: MemoryProviderConfiguration,
): MemoryProviderConfiguration {
  return normalizedMemoryProviderConfiguration(input, normalizedProviderKey(input.providerKey));
}

/** 持久化读取保留历史对象键；写入期疑似密钥门禁不得阻断已有 Revision 的安全投影。 */
export function normalizeStoredMemoryProviderConfiguration(
  input: MemoryProviderConfiguration,
): MemoryProviderConfiguration {
  return normalizedMemoryProviderConfiguration(
    input,
    normalizedStoredProviderKey(input.providerKey),
  );
}

export function normalizeTitleGenerationConfiguration(
  input: TitleGenerationConfiguration | undefined,
): TitleGenerationConfiguration | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input.enabled !== "boolean") throw new TypeError("标题生成配置无效");
  if (!input.enabled) return Object.freeze({ enabled: false });
  return Object.freeze({
    enabled: true,
    providerKey: normalizedStoredProviderKey(input.providerKey),
    providerRevision: boundedInteger(
      input.providerRevision,
      "标题供应商版本",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    modelId: normalizedText(input.modelId, "标题模型", 512),
  });
}

export function normalizeRuntimeSettingsConfiguration(
  input: RuntimeSettingsConfiguration,
): RuntimeSettingsConfiguration & { readonly toolCallingMode: "native" | "ptc" } {
  // 旧修订缺少字段时保持正常模式；非法值不能静默回退。
  const toolCallingMode = input.toolCallingMode === undefined ? "native" : input.toolCallingMode;
  if (toolCallingMode !== "native" && toolCallingMode !== "ptc") {
    throw new TypeError("工具调用模式必须为 native 或 ptc");
  }
  const enabledTools = normalizeRuntimeToolSelection(input.enabledTools);
  const titleGeneration = normalizeTitleGenerationConfiguration(input.titleGeneration);
  if (input.compactionEnabled !== undefined && typeof input.compactionEnabled !== "boolean")
    throw new TypeError("上下文压缩开关无效");
  const softLimit = boundedInteger(input.compactionSoftLimitPercent, "压缩软上限", 50, 95);
  const target = boundedInteger(input.compactionTargetPercent, "压缩目标", 20, 90);
  if (target >= softLimit) throw new TypeError("压缩目标必须低于软上限");
  return Object.freeze({
    toolCallingMode,
    ...(titleGeneration === undefined ? {} : { titleGeneration }),
    ...(input.compactionEnabled === undefined
      ? {}
      : { compactionEnabled: input.compactionEnabled }),
    ...(enabledTools === undefined ? {} : { enabledTools }),
    workerMaxConcurrentRuns: boundedInteger(
      input.workerMaxConcurrentRuns,
      "单 Worker 并行 Run 上限",
      1,
      100,
    ),
    userMaxConcurrentRunsPerTenant: boundedInteger(
      input.userMaxConcurrentRunsPerTenant,
      "单用户在 Tenant 内并行 Run 上限",
      1,
      100,
    ),
    compactionSoftLimitPercent: softLimit,
    compactionTargetPercent: target,
    compactionRecentUserTokens: boundedInteger(
      input.compactionRecentUserTokens,
      "保留用户 Token",
      1,
      1_000_000,
    ),
    compactionMaxOutputTokens: boundedInteger(
      input.compactionMaxOutputTokens,
      "压缩最大输出 Token",
      128,
      1_000_000,
    ),
    compactionTimeoutMs: boundedInteger(input.compactionTimeoutMs, "压缩超时", 1_000, 600_000),
  });
}

export function normalizeChangeReason(value: string): string {
  return normalizedText(value, "变更原因", 500);
}

export function digestControlRequest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function requireRole(
  role: ControlOperatorRole | undefined,
  allowed: readonly ControlOperatorRole[],
): void {
  if (role === undefined || !allowed.includes(role))
    throw new AdminControlServiceError("NOT_AUTHORIZED");
}

function unwrapMutation<T>(result: ControlMutationResult<T>): T {
  if (result.outcome === "applied" || result.outcome === "replayed") return result.value;
  const mapping = {
    not_found: "NOT_FOUND",
    conflict: "CONFLICT",
    not_authorized: "NOT_AUTHORIZED",
    key_conflict: "KEY_CONFLICT",
  } as const;
  throw new AdminControlServiceError(mapping[result.outcome]);
}

export class AdminControlService {
  constructor(
    private readonly repository: AdminControlRepository,
    private readonly statistics: AdminControlStatisticsPort,
    private readonly probes: ProviderProbePort,
    private readonly deploymentSettings: readonly DeploymentSettingDescriptor[],
    private readonly runtimeEnvironment?: AdminControlOverview["runtimeEnvironment"],
  ) {}

  async overview(actorUserId: string): Promise<AdminControlOverview> {
    requireRole(await this.repository.resolveRole(actorUserId), ["viewer", "operator", "admin"]);
    const [generation, models, memories, activeRuntimeSettings, statistics] = await Promise.all([
      this.repository.generation(actorUserId),
      this.repository.listModelProviders(actorUserId),
      this.repository.listMemoryProviders(actorUserId),
      this.repository.getActiveRuntimeSettings(actorUserId),
      this.statistics.read(actorUserId),
    ]);
    const activeModel = models.find((revision) => revision.status === "active");
    const activeMemory = memories.find((revision) => revision.status === "active");
    return Object.freeze({
      generation,
      ...(this.runtimeEnvironment === undefined
        ? {}
        : { runtimeEnvironment: this.runtimeEnvironment }),
      ...(activeModel === undefined ? {} : { activeModel: redactedModelRevision(activeModel) }),
      ...(activeMemory === undefined ? {} : { activeMemory: redactedMemoryRevision(activeMemory) }),
      ...(activeRuntimeSettings === undefined
        ? {}
        : {
            activeRuntimeSettings: {
              ...activeRuntimeSettings,
              configuration: normalizeRuntimeSettingsConfiguration(
                activeRuntimeSettings.configuration,
              ),
            },
          }),
      statistics,
      deploymentSettings: this.deploymentSettings,
    });
  }

  async agentMetrics(
    actorUserId: string,
    query: Omit<AgentMetricsQuery, "actorUserId">,
  ): Promise<readonly AgentMetricsBucket[]> {
    requireRole(await this.repository.resolveRole(actorUserId), ["viewer", "operator", "admin"]);
    const from = isIsoUtcTimestamp(query.from) ? Date.parse(query.from) : Number.NaN;
    const to = isIsoUtcTimestamp(query.to) ? Date.parse(query.to) : Number.NaN;
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      to <= from ||
      to - from > 90 * 86_400_000
    ) {
      throw new AdminControlServiceError("INVALID_INPUT");
    }
    if (this.repository.readAgentMetrics === undefined) {
      throw new AdminControlServiceError("INVALID_INPUT");
    }
    return this.repository.readAgentMetrics({ actorUserId, ...query });
  }

  async listModelProviders(actorUserId: string) {
    requireRole(await this.repository.resolveRole(actorUserId), ["viewer", "operator", "admin"]);
    return (await this.repository.listModelProviders(actorUserId)).map(redactedModelRevision);
  }

  async listMemoryProviders(actorUserId: string) {
    requireRole(await this.repository.resolveRole(actorUserId), ["viewer", "operator", "admin"]);
    return (await this.repository.listMemoryProviders(actorUserId)).map(redactedMemoryRevision);
  }

  async listRuntimeSettings(actorUserId: string) {
    requireRole(await this.repository.resolveRole(actorUserId), ["viewer", "operator", "admin"]);
    return (await this.repository.listRuntimeSettings(actorUserId)).map((revision) => ({
      ...revision,
      configuration: normalizeRuntimeSettingsConfiguration(revision.configuration),
    }));
  }

  async listAudits(actorUserId: string, limit = 100) {
    requireRole(await this.repository.resolveRole(actorUserId), ["viewer", "operator", "admin"]);
    return (
      await this.repository.listAudits(actorUserId, boundedInteger(limit, "审计条数", 1, 200))
    ).map(redactedAuditEvent);
  }

  async listUsers(actorUserId: string, query?: string, limit = 50): Promise<PlatformUserPage> {
    requireRole(await this.repository.resolveRole(actorUserId), ["admin"]);
    const normalizedQuery = normalizedUserQuery(query);
    return await this.repository.listUsers({
      actorUserId,
      ...(normalizedQuery === undefined ? {} : { query: normalizedQuery }),
      limit: boundedInteger(limit, "用户条数", 1, 200),
    });
  }

  async updateUserStatus(
    context: ControlMutationContext,
    input: {
      readonly targetUserId: string;
      readonly status: PlatformUserStatus;
      readonly reason?: string;
    },
  ): Promise<PlatformUserSummary> {
    requireRole(await this.repository.resolveRole(context.actorUserId), ["admin"]);
    const targetUserId = normalizedUserId(input.targetUserId);
    if (targetUserId === context.actorUserId) {
      throw new AdminControlServiceError("CONFLICT");
    }
    if (input.status !== "active" && input.status !== "disabled") {
      throw new TypeError("用户状态不受支持");
    }
    return unwrapMutation(
      await this.repository.updateUserStatus({
        ...context,
        targetUserId,
        status: input.status,
        reason: normalizeChangeReason(
          input.reason ?? (input.status === "disabled" ? "管理员停用用户" : "管理员恢复用户"),
        ),
      }),
    );
  }

  async createModelDraft(
    context: ControlMutationContext,
    command: CreateModelProviderDraftCommand,
  ) {
    requireRole(await this.repository.resolveRole(context.actorUserId), ["operator", "admin"]);
    return unwrapMutation(
      await this.repository.createModelDraft({
        ...context,
        command: { ...this.normalizeModelCommand(command), reason: "保存模型供应商配置" },
      }),
    );
  }

  async saveModelConfiguration(
    context: ControlMutationContext,
    command: SaveModelProviderConfigurationCommand,
  ) {
    requireRole(await this.repository.resolveRole(context.actorUserId), ["admin"]);
    const { expectedGeneration, ...configuration } = command;
    return unwrapMutation(
      await this.repository.saveModelConfiguration({
        ...context,
        command: {
          ...this.normalizeModelCommand(configuration),
          expectedGeneration: boundedInteger(
            expectedGeneration,
            "配置更新状态",
            0,
            Number.MAX_SAFE_INTEGER,
          ),
          reason: "保存并使用模型配置",
        },
      }),
    );
  }

  async saveMemoryConfiguration(
    context: ControlMutationContext,
    command: SaveMemoryProviderConfigurationCommand,
  ) {
    requireRole(await this.repository.resolveRole(context.actorUserId), ["admin"]);
    const { expectedGeneration, reason, apiKey, reuseCredentialFromRevision, ...configuration } =
      command;
    if (
      apiKey !== undefined &&
      (apiKey.length < 1 || Buffer.byteLength(apiKey, "utf8") > 8192 || /[\r\n\0]/u.test(apiKey))
    ) {
      throw new TypeError("记忆密钥格式无效");
    }
    if (apiKey !== undefined && reuseCredentialFromRevision !== undefined)
      throw new TypeError("记忆密钥不能同时更新和复用");
    if (
      configuration.apiSecretRef === "managed:memory-api" &&
      apiKey === undefined &&
      reuseCredentialFromRevision === undefined
    )
      throw new TypeError("请输入 Mem0 API Key");
    if (
      configuration.apiSecretRef === "deployment:memory-api" &&
      (apiKey !== undefined || reuseCredentialFromRevision !== undefined)
    )
      throw new TypeError("托管密钥需要使用后台配置");
    return unwrapMutation(
      await this.repository.saveMemoryConfiguration({
        ...context,
        command: {
          ...normalizeMemoryProviderConfiguration(configuration),
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(reuseCredentialFromRevision === undefined
            ? {}
            : {
                reuseCredentialFromRevision: boundedInteger(
                  reuseCredentialFromRevision,
                  "复用凭据",
                  1,
                  Number.MAX_SAFE_INTEGER,
                ),
              }),
          expectedGeneration: boundedInteger(
            expectedGeneration,
            "配置更新状态",
            0,
            Number.MAX_SAFE_INTEGER,
          ),
          reason: normalizeChangeReason(reason ?? "保存长期记忆设置"),
        },
      }),
    );
  }

  private normalizeModelCommand(
    command: CreateModelProviderDraftCommand,
  ): CreateModelProviderDraftCommand {
    const { apiKey, reuseCredentialFromRevision, ...configuration } = command;
    const hasApiKey = apiKey !== undefined;
    const hasReuse = reuseCredentialFromRevision !== undefined;
    if (hasApiKey === hasReuse) throw new TypeError("必须输入新模型密钥或明确复用既有密钥");
    if (apiKey !== undefined) {
      if (
        apiKey.length < 1 ||
        Buffer.byteLength(apiKey, "utf8") > 8_192 ||
        /[\r\n\0]/u.test(apiKey)
      ) {
        throw new TypeError("模型密钥格式无效");
      }
    }
    const normalizedReuse =
      reuseCredentialFromRevision === undefined
        ? undefined
        : boundedInteger(
            reuseCredentialFromRevision,
            "复用凭据 Revision",
            1,
            Number.MAX_SAFE_INTEGER,
          );
    const normalized = normalizeModelProviderConfiguration({
      ...configuration,
      credentialConfigured: true,
    });
    const { credentialConfigured: _credentialConfigured, ...persistedConfiguration } = normalized;
    return {
      ...persistedConfiguration,
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(normalizedReuse === undefined ? {} : { reuseCredentialFromRevision: normalizedReuse }),
    };
  }

  async createMemoryDraft(
    context: ControlMutationContext,
    command: CreateMemoryProviderDraftCommand,
  ) {
    requireRole(await this.repository.resolveRole(context.actorUserId), ["operator", "admin"]);
    const { reason, ...configuration } = command;
    return unwrapMutation(
      await this.repository.createMemoryDraft({
        ...context,
        command: {
          ...normalizeMemoryProviderConfiguration(configuration),
          reason: normalizeChangeReason(reason ?? "保存长期记忆设置"),
        },
      }),
    );
  }

  private async validateTitleModel(
    actorUserId: string,
    configuration: RuntimeSettingsConfiguration,
  ) {
    const title = configuration.titleGeneration;
    if (title?.enabled) {
      const models = await this.repository.listModelProviders(actorUserId);
      const selected = models.find(
        (item) =>
          item.configuration.providerKey === title.providerKey &&
          item.revision === title.providerRevision,
      );
      if (
        !selected?.configuration.credentialConfigured ||
        !selected.configuration.models.some(
          (model) => model.id === title.modelId && model.enabled && model.maxTokens >= 32,
        )
      )
        throw new TypeError("请选择已保存且启用的标题模型");
    }
  }

  async createRuntimeSettingsDraft(
    context: ControlMutationContext,
    command: CreateRuntimeSettingsDraftCommand,
  ) {
    requireRole(await this.repository.resolveRole(context.actorUserId), ["operator", "admin"]);
    const { reason, ...configuration } = command;
    const normalized = normalizeRuntimeSettingsConfiguration(configuration);
    await this.validateTitleModel(context.actorUserId, normalized);
    return unwrapMutation(
      await this.repository.createRuntimeSettingsDraft({
        ...context,
        command: {
          ...normalized,
          reason: normalizeChangeReason(reason),
        },
      }),
    );
  }

  async saveRuntimeSettingsConfiguration(
    context: ControlMutationContext,
    command: SaveRuntimeSettingsConfigurationCommand,
  ) {
    requireRole(await this.repository.resolveRole(context.actorUserId), ["admin"]);
    const normalized = normalizeRuntimeSettingsConfiguration(command);
    await this.validateTitleModel(context.actorUserId, normalized);
    return unwrapMutation(
      await this.repository.saveRuntimeSettingsConfiguration({
        ...context,
        command: {
          ...normalized,
          expectedGeneration: boundedInteger(
            command.expectedGeneration,
            "配置更新状态",
            0,
            Number.MAX_SAFE_INTEGER,
          ),
          reason: "保存并使用运行设置",
        },
      }),
    );
  }

  async probe(
    context: ControlMutationContext,
    input: {
      readonly kind: "model_provider" | "memory_provider";
      readonly revision:
        | ControlRevision<ModelProviderConfiguration>
        | ControlRevision<MemoryProviderConfiguration>;
      readonly expectedVersionToken: number;
      readonly reason?: string;
    },
  ) {
    requireRole(await this.repository.resolveRole(context.actorUserId), ["operator", "admin"]);
    const objectKey = normalizedProviderKey(input.revision.configuration.providerKey);
    const expectedVersionToken = boundedInteger(
      input.expectedVersionToken,
      "版本令牌",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (input.revision.versionToken !== expectedVersionToken) {
      throw new AdminControlServiceError("CONFLICT");
    }
    let status: Exclude<ProviderProbeStatus, "untested"> = "healthy";
    try {
      if (input.kind === "model_provider") {
        const apiKey = await this.repository.resolveModelCredential(
          context.actorUserId,
          objectKey,
          input.revision.revision,
        );
        if (apiKey === undefined) throw new Error("MODEL_CREDENTIAL_UNAVAILABLE");
        await this.probes.probeModel(
          input.revision.configuration as ModelProviderConfiguration,
          apiKey,
        );
      } else {
        const memory = input.revision.configuration as MemoryProviderConfiguration;
        const apiKey =
          memory.apiSecretRef === "managed:memory-api"
            ? await this.repository.resolveMemoryCredential?.(
                context.actorUserId,
                objectKey,
                input.revision.revision,
              )
            : undefined;
        if (memory.apiSecretRef === "managed:memory-api" && apiKey === undefined)
          throw new Error("MEMORY_CREDENTIAL_UNAVAILABLE");
        await this.probes.probeMemory(memory, apiKey);
      }
    } catch {
      status = "failed";
    }
    const value = unwrapMutation(
      await this.repository.recordProbe({
        ...context,
        kind: input.kind,
        objectKey,
        revision: input.revision.revision,
        expectedVersionToken,
        reason:
          input.kind === "model_provider"
            ? status === "healthy"
              ? "模型文本请求测试成功"
              : "模型文本请求测试失败"
            : normalizeChangeReason(input.reason ?? "测试长期记忆连接"),
        status,
      }),
    );
    // 幂等重放必须复现首次持久化结果，不能被本次重复网络探测的瞬时状态改写。
    if (value.probeStatus === "failed") throw new AdminControlServiceError("PROBE_FAILED");
    return value;
  }

  async publish(
    context: ControlMutationContext,
    input: {
      readonly kind: ControlObjectKind;
      readonly objectKey: string;
      readonly revision: number;
      readonly command: PublishControlRevisionCommand;
    },
  ) {
    requireRole(await this.repository.resolveRole(context.actorUserId), ["admin"]);
    const objectKey = normalizedProviderKey(input.objectKey);
    const revision = boundedInteger(input.revision, "Revision", 1, Number.MAX_SAFE_INTEGER);
    if (input.kind === "runtime_settings") {
      const [models, settings] = await Promise.all([
        this.repository.listModelProviders(context.actorUserId),
        this.repository.listRuntimeSettings(context.actorUserId),
      ]);
      const model = models.find((candidate) => candidate.status === "active");
      const runtimeSettings = settings.find((candidate) => candidate.revision === revision);
      if (runtimeSettings !== undefined)
        await this.validateTitleModel(context.actorUserId, runtimeSettings.configuration);
      if (
        model !== undefined &&
        runtimeSettings !== undefined &&
        runtimeSettings.configuration.compactionMaxOutputTokens >
          defaultModelConfiguration(model.configuration).maxTokens
      ) {
        throw new AdminControlServiceError("CONFLICT");
      }
    }
    return unwrapMutation(
      await this.repository.publish({
        ...context,
        kind: input.kind,
        objectKey,
        revision,
        expectedVersionToken: boundedInteger(
          input.command.expectedVersionToken,
          "版本令牌",
          1,
          Number.MAX_SAFE_INTEGER,
        ),
        reason:
          input.kind === "model_provider"
            ? "切换当前模型配置"
            : normalizeChangeReason(input.command.reason ?? "保存长期记忆设置"),
      }),
    );
  }
}

export type PinnedRunModelReference = Omit<AgentPinnedModelReferenceDto, "mode">;

export interface PinnedRunModelConfiguration {
  readonly model: ControlRevision<ModelProviderConfiguration>;
  readonly apiKey: string;
}

export class PinnedRunModelUnavailableError extends Error {
  constructor() {
    super("PINNED_MODEL_CONFIGURATION_UNAVAILABLE");
  }
}

export interface PinnedRunModelConfigurationPort {
  /** 只读当前 Run 已固定的精确版本与模型；引用、版本或凭据不匹配时抛错。 */
  resolvePinnedModelConfiguration(
    scope: { readonly tenantId: string; readonly runId: string },
    reference: PinnedRunModelReference,
  ): Promise<PinnedRunModelConfiguration>;
}

export interface RuntimeControlConfigurationSnapshot {
  readonly generation: number;
  readonly model?: ControlRevision<ModelProviderConfiguration>;
  /** 仅存在于 Worker 内存中的解密结果，不属于任何控制面 DTO。 */
  readonly modelApiKey?: string;
  readonly memoryApiKey?: string;
  /** 固定模型覆盖执行模型，但不改变平台记忆的部署回退条件。 */
  readonly platformModelConfigured?: boolean;
  readonly memory?: ControlRevision<MemoryProviderConfiguration>;
  readonly runtimeSettings?: ControlRevision<RuntimeSettingsConfiguration>;
}

export interface RuntimeControlConfigurationPort {
  resolveForRun(input: {
    readonly tenantId: string;
    readonly runId: string;
  }): Promise<RuntimeControlConfigurationSnapshot | undefined>;
}

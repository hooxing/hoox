import { createHash } from "node:crypto";

export type ControlOperatorRole = "viewer" | "operator" | "admin";
export type ControlRevisionStatus = "draft" | "active" | "retired";
export type ProviderProbeStatus = "untested" | "healthy" | "failed";
export type ProviderSecretRef =
  | "deployment:model"
  | "deployment:memory-api"
  | "deployment:memory-scope";

export type ModelInputCapability = "text" | "image";

/** 对齐 Pi Provider 模型的必要字段；enabled 是平台控制面的发布策略。 */
export interface ModelProviderModelConfiguration {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly reasoning: boolean;
  readonly input: readonly ModelInputCapability[];
  readonly contextWindow: number;
  readonly maxTokens: number;
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
  readonly apiSecretRef: "deployment:memory-api";
  readonly scopeSecretRef: "deployment:memory-scope";
  readonly requestTimeoutMs: number;
  readonly enabled: boolean;
}

export const DEFAULT_WORKER_MAX_CONCURRENT_RUNS = 20;
export const DEFAULT_USER_MAX_CONCURRENT_RUNS_PER_TENANT = 2;

export interface RuntimeSettingsConfiguration {
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
  readonly reason: string;
}

export interface CreateRuntimeSettingsDraftCommand extends RuntimeSettingsConfiguration {
  readonly reason: string;
}

export interface PublishControlRevisionCommand {
  readonly expectedVersionToken: number;
  readonly reason: string;
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
  createMemoryDraft(
    input: ControlMutationContext & { readonly command: CreateMemoryProviderDraftCommand },
  ): Promise<ControlMutationResult<ControlRevision<MemoryProviderConfiguration>>>;
  createRuntimeSettingsDraft(
    input: ControlMutationContext & { readonly command: CreateRuntimeSettingsDraftCommand },
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

export interface AdminControlStatisticsPort {
  read(userId: string): Promise<RuntimeStatistics>;
}

export interface ProviderProbePort {
  probeModel(configuration: ModelProviderConfiguration, apiKey: string): Promise<void>;
  probeMemory(configuration: MemoryProviderConfiguration): Promise<void>;
}

export class AdminControlServiceError extends Error {
  constructor(
    readonly code: "NOT_AUTHORIZED" | "NOT_FOUND" | "CONFLICT" | "KEY_CONFLICT" | "PROBE_FAILED",
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
    return Object.freeze({
      id,
      name: normalizedText(model.name, "模型名称", 120),
      enabled: model.enabled,
      reasoning: model.reasoning,
      input: Object.freeze(capabilities),
      contextWindow,
      maxTokens,
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
    input.apiSecretRef !== "deployment:memory-api" ||
    input.scopeSecretRef !== "deployment:memory-scope"
  ) {
    throw new TypeError("记忆 Secret Ref 不受支持");
  }
  return Object.freeze({
    providerKey,
    displayName: normalizedText(input.displayName, "显示名称", 120),
    providerKind: "mem0",
    baseUrl: normalizedHttpsUrl(input.baseUrl),
    apiSecretRef: "deployment:memory-api",
    scopeSecretRef: "deployment:memory-scope",
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

export function normalizeRuntimeSettingsConfiguration(
  input: RuntimeSettingsConfiguration,
): RuntimeSettingsConfiguration {
  const softLimit = boundedInteger(input.compactionSoftLimitPercent, "压缩软上限", 50, 95);
  const target = boundedInteger(input.compactionTargetPercent, "压缩目标", 20, 90);
  if (target >= softLimit) throw new TypeError("压缩目标必须低于软上限");
  return Object.freeze({
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
      ...(activeRuntimeSettings === undefined ? {} : { activeRuntimeSettings }),
      statistics,
      deploymentSettings: this.deploymentSettings,
    });
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
    return await this.repository.listRuntimeSettings(actorUserId);
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
      readonly reason: string;
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
        reason: normalizeChangeReason(input.reason),
      }),
    );
  }

  async createModelDraft(
    context: ControlMutationContext,
    command: CreateModelProviderDraftCommand,
  ) {
    requireRole(await this.repository.resolveRole(context.actorUserId), ["operator", "admin"]);
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
    return unwrapMutation(
      await this.repository.createModelDraft({
        ...context,
        command: {
          ...persistedConfiguration,
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(normalizedReuse === undefined
            ? {}
            : { reuseCredentialFromRevision: normalizedReuse }),
          reason: "保存模型供应商配置",
        },
      }),
    );
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
          reason: normalizeChangeReason(reason),
        },
      }),
    );
  }

  async createRuntimeSettingsDraft(
    context: ControlMutationContext,
    command: CreateRuntimeSettingsDraftCommand,
  ) {
    requireRole(await this.repository.resolveRole(context.actorUserId), ["operator", "admin"]);
    const { reason, ...configuration } = command;
    return unwrapMutation(
      await this.repository.createRuntimeSettingsDraft({
        ...context,
        command: {
          ...normalizeRuntimeSettingsConfiguration(configuration),
          reason: normalizeChangeReason(reason),
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
        await this.probes.probeMemory(input.revision.configuration as MemoryProviderConfiguration);
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
            : normalizeChangeReason(input.reason ?? ""),
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
    const [models, memories, settings] = await Promise.all([
      input.kind === "model_provider" || input.kind === "runtime_settings"
        ? this.repository.listModelProviders(context.actorUserId)
        : Promise.resolve([]),
      input.kind === "memory_provider"
        ? this.repository.listMemoryProviders(context.actorUserId)
        : Promise.resolve([]),
      input.kind === "model_provider" || input.kind === "runtime_settings"
        ? this.repository.listRuntimeSettings(context.actorUserId)
        : Promise.resolve([]),
    ]);
    const memoryRevision =
      input.kind === "memory_provider"
        ? memories.find(
            (candidate) =>
              candidate.configuration.providerKey === objectKey && candidate.revision === revision,
          )
        : undefined;
    if (memoryRevision !== undefined && memoryRevision.probeStatus !== "healthy") {
      // 记忆服务仍依赖独立探测确认其读写语义；模型配置则允许保存后直接启用。
      throw new AdminControlServiceError("CONFLICT");
    }
    if (input.kind === "model_provider" || input.kind === "runtime_settings") {
      const model =
        input.kind === "model_provider"
          ? models.find(
              (candidate) =>
                candidate.configuration.providerKey === objectKey &&
                candidate.revision === revision,
            )
          : models.find((candidate) => candidate.status === "active");
      const runtimeSettings =
        input.kind === "runtime_settings"
          ? settings.find((candidate) => candidate.revision === revision)
          : settings.find((candidate) => candidate.status === "active");
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
            : normalizeChangeReason(input.command.reason ?? ""),
      }),
    );
  }
}

export interface RuntimeControlConfigurationSnapshot {
  readonly generation: number;
  readonly model: ControlRevision<ModelProviderConfiguration>;
  /** 仅存在于 Worker 内存中的解密结果，不属于任何控制面 DTO。 */
  readonly modelApiKey: string;
  readonly memory?: ControlRevision<MemoryProviderConfiguration>;
  readonly runtimeSettings?: ControlRevision<RuntimeSettingsConfiguration>;
}

export interface RuntimeControlConfigurationPort {
  resolveForRun(input: {
    readonly tenantId: string;
    readonly runId: string;
  }): Promise<RuntimeControlConfigurationSnapshot | undefined>;
}

import { createHash } from "node:crypto";

export type ControlOperatorRole = "viewer" | "operator" | "admin";
export type ControlRevisionStatus = "draft" | "active" | "retired";
export type ProviderProbeStatus = "untested" | "healthy" | "failed";
export type ProviderSecretRef =
  | "deployment:model"
  | "deployment:memory-api"
  | "deployment:memory-scope";

export interface ModelProviderConfiguration {
  readonly providerKey: string;
  readonly displayName: string;
  readonly protocol: "openai-compatible";
  readonly baseUrl: string;
  readonly secretRef: "deployment:model";
  readonly modelId: string;
  readonly supportsImages: boolean;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
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

export interface RuntimeSettingsConfiguration {
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
  readonly generation: number;
  readonly activeModel?: ControlRevision<ModelProviderConfiguration>;
  readonly activeMemory?: ControlRevision<MemoryProviderConfiguration>;
  readonly activeRuntimeSettings?: ControlRevision<RuntimeSettingsConfiguration>;
  readonly statistics: RuntimeStatistics;
  readonly deploymentSettings: readonly DeploymentSettingDescriptor[];
}

export type ControlObjectKind = ControlAuditEvent["objectKind"];

export interface CreateModelProviderDraftCommand extends ModelProviderConfiguration {
  readonly reason: string;
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
    input: ControlMutationContext & { readonly command: CreateModelProviderDraftCommand },
  ): Promise<ControlMutationResult<ControlRevision<ModelProviderConfiguration>>>;
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
}

export interface AdminControlStatisticsPort {
  read(userId: string): Promise<RuntimeStatistics>;
}

export interface ProviderProbePort {
  probeModel(configuration: ModelProviderConfiguration): Promise<void>;
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

function normalizedText(value: string, name: string, maximum: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length < 1 || Array.from(normalized).length > maximum) {
    throw new TypeError(`${name} 长度无效`);
  }
  return normalized;
}

function normalizedProviderKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!providerKeyPattern.test(normalized)) throw new TypeError("Provider Key 格式无效");
  return normalized;
}

function normalizedHttpsUrl(value: string): string {
  const url = new URL(value);
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

export function normalizeModelProviderConfiguration(
  input: ModelProviderConfiguration,
): ModelProviderConfiguration {
  const contextWindow = boundedInteger(input.contextWindow, "上下文窗口", 1, 10_000_000);
  const maxOutputTokens = boundedInteger(input.maxOutputTokens, "最大输出 Token", 1, 10_000_000);
  if (maxOutputTokens > contextWindow) throw new TypeError("最大输出 Token 不能超过上下文窗口");
  if (input.protocol !== "openai-compatible") throw new TypeError("模型协议不受支持");
  if (input.secretRef !== "deployment:model") throw new TypeError("模型 Secret Ref 不受支持");
  return Object.freeze({
    providerKey: normalizedProviderKey(input.providerKey),
    displayName: normalizedText(input.displayName, "显示名称", 120),
    protocol: "openai-compatible",
    baseUrl: normalizedHttpsUrl(input.baseUrl),
    secretRef: "deployment:model",
    modelId: normalizedText(input.modelId, "模型 ID", 255),
    supportsImages: input.supportsImages,
    contextWindow,
    maxOutputTokens,
  });
}

export function normalizeMemoryProviderConfiguration(
  input: MemoryProviderConfiguration,
): MemoryProviderConfiguration {
  if (input.providerKind !== "mem0") throw new TypeError("记忆 Provider 类型不受支持");
  if (
    input.apiSecretRef !== "deployment:memory-api" ||
    input.scopeSecretRef !== "deployment:memory-scope"
  ) {
    throw new TypeError("记忆 Secret Ref 不受支持");
  }
  return Object.freeze({
    providerKey: normalizedProviderKey(input.providerKey),
    displayName: normalizedText(input.displayName, "显示名称", 120),
    providerKind: "mem0",
    baseUrl: normalizedHttpsUrl(input.baseUrl),
    apiSecretRef: "deployment:memory-api",
    scopeSecretRef: "deployment:memory-scope",
    requestTimeoutMs: boundedInteger(input.requestTimeoutMs, "记忆请求超时", 100, 120_000),
    enabled: input.enabled,
  });
}

export function normalizeRuntimeSettingsConfiguration(
  input: RuntimeSettingsConfiguration,
): RuntimeSettingsConfiguration {
  const softLimit = boundedInteger(input.compactionSoftLimitPercent, "压缩软上限", 50, 95);
  const target = boundedInteger(input.compactionTargetPercent, "压缩目标", 20, 90);
  if (target >= softLimit) throw new TypeError("压缩目标必须低于软上限");
  return Object.freeze({
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
      ...(activeModel === undefined ? {} : { activeModel }),
      ...(activeMemory === undefined ? {} : { activeMemory }),
      ...(activeRuntimeSettings === undefined ? {} : { activeRuntimeSettings }),
      statistics,
      deploymentSettings: this.deploymentSettings,
    });
  }

  async listModelProviders(actorUserId: string) {
    requireRole(await this.repository.resolveRole(actorUserId), ["viewer", "operator", "admin"]);
    return await this.repository.listModelProviders(actorUserId);
  }

  async listMemoryProviders(actorUserId: string) {
    requireRole(await this.repository.resolveRole(actorUserId), ["viewer", "operator", "admin"]);
    return await this.repository.listMemoryProviders(actorUserId);
  }

  async listRuntimeSettings(actorUserId: string) {
    requireRole(await this.repository.resolveRole(actorUserId), ["viewer", "operator", "admin"]);
    return await this.repository.listRuntimeSettings(actorUserId);
  }

  async listAudits(actorUserId: string, limit = 100) {
    requireRole(await this.repository.resolveRole(actorUserId), ["viewer", "operator", "admin"]);
    return await this.repository.listAudits(actorUserId, boundedInteger(limit, "审计条数", 1, 200));
  }

  async createModelDraft(
    context: ControlMutationContext,
    command: CreateModelProviderDraftCommand,
  ) {
    requireRole(await this.repository.resolveRole(context.actorUserId), ["operator", "admin"]);
    const { reason, ...configuration } = command;
    return unwrapMutation(
      await this.repository.createModelDraft({
        ...context,
        command: {
          ...normalizeModelProviderConfiguration(configuration),
          reason: normalizeChangeReason(reason),
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
      readonly reason: string;
    },
  ) {
    requireRole(await this.repository.resolveRole(context.actorUserId), ["operator", "admin"]);
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
        await this.probes.probeModel(input.revision.configuration as ModelProviderConfiguration);
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
        objectKey: input.revision.configuration.providerKey,
        revision: input.revision.revision,
        expectedVersionToken,
        reason: normalizeChangeReason(input.reason),
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
    if (input.kind === "model_provider" || input.kind === "runtime_settings") {
      const [models, settings] = await Promise.all([
        this.repository.listModelProviders(context.actorUserId),
        this.repository.listRuntimeSettings(context.actorUserId),
      ]);
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
          model.configuration.maxOutputTokens
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
        reason: normalizeChangeReason(input.command.reason),
      }),
    );
  }
}

export interface RuntimeControlConfigurationSnapshot {
  readonly generation: number;
  readonly model: ControlRevision<ModelProviderConfiguration>;
  readonly memory?: ControlRevision<MemoryProviderConfiguration>;
  readonly runtimeSettings?: ControlRevision<RuntimeSettingsConfiguration>;
}

export interface RuntimeControlConfigurationPort {
  resolveForRun(input: {
    readonly tenantId: string;
    readonly runId: string;
  }): Promise<RuntimeControlConfigurationSnapshot | undefined>;
}

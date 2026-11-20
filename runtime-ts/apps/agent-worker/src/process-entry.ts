import type { Model, Models } from "@earendil-works/pi-ai";
import {
  DEFAULT_USER_MAX_CONCURRENT_RUNS_PER_TENANT,
  DEFAULT_WORKER_MAX_CONCURRENT_RUNS,
  type ModelProviderModelConfiguration,
} from "@hoox/admin-control";
import {
  createArtifactExecutionAuthorizationAuthority,
  PgSimpleDeliveredFileRepository,
  SimpleArtifactDeliveryService,
} from "@hoox/artifact";
import { tenantId } from "@hoox/domain";
import {
  type Mem0DevelopmentConfiguration,
  Mem0PlatformMemoryProvider,
  MemoryIngestionConsumer,
  parseMem0DevelopmentEnvironment,
} from "@hoox/memory";
import {
  ModelProviderCredentialCipher,
  PgRuntimeControlConfigurationRepository,
  PgSandboxConfigurationResolver,
} from "@hoox/persistence/admin";
import {
  createS3BlobStore,
  createS3StableBlobGarbageCollector,
  DurableResourceBlobWriter,
  DurableTraceBlobPersistenceAdapter,
  DurableWorkspaceCandidateBlobWriter,
  PgBlobLifecycleRepository,
  probeS3BlobStore,
  RUNTIME_BLOB_OBJECT_PREFIX,
} from "@hoox/persistence/blob";
import { createPostgresPool, probePostgres } from "@hoox/persistence/postgres";
import {
  PgAgentControlRepository,
  PgBackedSandboxSessionRegistry,
  PgExecutionPersistence,
  PgMemoryIngestionStore,
  PgModelWireTraceRepository,
  PgRecoveryMetrics,
  PgRunCancellationReader,
  PgRunCompactionSettingsRepository,
  PgRunDispatchOutbox,
  PgRuntimeRolloutRepository,
  PgScheduledTaskDueConsumer,
  PgScheduledTaskRepository,
  PgThreadContextCompactionRepository,
  PgThreadContextHistoryRepository,
  PgThreadSandboxSessionLifecycle,
  PgWorkerDispatchWakeListener,
  PgWorkerTenantAssignments,
  PgWorkspaceCandidateHandoff,
  PgWorkspaceManifestRepository,
  PgWorkspaceStableBlobAccess,
  ThreadContextBodyPersistence,
} from "@hoox/persistence/run-execution";
import {
  BlobSkillContentStore,
  DEFAULT_HISTORY_DIRECTORY_TIME_ZONE,
  PgPersonalizationSettingsRepository,
  PgResourceFilesystemCatalog,
  PgSkillFilesystemCatalog,
  PgSkillRuntimeRepository,
  PgThreadContinuityMetrics,
  PgThreadTitleGenerationStore,
} from "@hoox/persistence/thread";
import {
  bindTrustedPiModelContextCapability,
  createOpenAiCompatiblePiProvider,
  isOfficialDeepSeekV4FlashModel,
  loadTrustedModelTokenizerCapability,
  type TrustedPiModelContextCapability,
} from "@hoox/pi-adapter";
import {
  assertProductionInheritedEnvironment,
  booleanEnvironmentField,
  EnvironmentConfigurationError,
  integerEnvironmentField,
  type ProcessSignalSource,
  parseProductionPostgresTransport,
  parseStrictEnvironment,
  type RunningServiceProcess,
  type RuntimeEnvironment,
  readRequiredEnvironmentValue,
  type ServiceAssemblyFactory,
  selectDeclaredEnvironment,
  startServiceProcess,
  stringEnvironmentField,
  urlEnvironmentField,
} from "@hoox/process-runtime";
import { digestCanonical } from "@hoox/run-contracts/mutation-protocol";
import {
  CubeTenantResourceVolume,
  resolveCubeProxyRouting,
  type SandboxProviderKey,
  type TenantResourceVolumePort,
} from "@hoox/sandbox";
import { SkillRuntimeService } from "@hoox/skill";
import {
  OpenAiCompatibleThreadTitleGenerator,
  ThreadTitleGenerationConsumer,
} from "@hoox/thread-title";
import { DeliverFileToolRouterFactory } from "@hoox/tool-router";
import { SandboxDeliverFileSource } from "./deliver-file-source.js";
import { createManagedSandboxRegistry } from "./managed-sandbox-registry.js";
import { installModelWireFetchInstrumentation, ModelWireTraceSession } from "./model-wire-trace.js";
import { createPgDurableObservationSession } from "./pg-observation-assembly.js";
import { PiWorkerSessionFactory } from "./pi-session-factory.js";
import {
  AgentWorkerPollingLoop,
  CubeSandboxSessionRegistry,
  DatabaseRunCancellation,
  E2BSandboxSessionRegistry,
  ProcessShutdown,
  SandboxSessionRegistryRouter,
  SystemWorkerClock,
  TencentAgsSandboxSessionRegistry,
} from "./production-worker-runtime.js";
import {
  createDevelopmentProjectInternalTrajectoryMirror,
  createDevelopmentProjectRunEventMirror,
  createDevelopmentProjectRunPhaseTimingMirror,
  createDevelopmentProjectRunStartupTimingMirror,
  withDevelopmentProjectModelWireTraceMirror,
} from "./project-model-wire-trace.js";
import { BlobPromptImageLoader } from "./prompt-image-loader.js";
import { RunWorker } from "./run-worker.js";
import { RuntimeCompactionCoordinator } from "./runtime-compaction.js";
import {
  RuntimeConfiguredMemoryProvider,
  RuntimeConfiguredSessionFactory,
  type RuntimeModelProbeConfiguration,
  resolveRuntimeModelProbeConfiguration,
} from "./runtime-configured-providers.js";
import { ManagedResourceFilesystemSnapshotMaterializer } from "./sandbox-resource-filesystem-materializer.js";
import { performWorkerMaintenance } from "./worker-maintenance.js";
import { ManifestWorkspaceRuntime } from "./workspace-runtime.js";

/** Artifact 服务请求的 TTL 必须不超过同一 Worker BlobStore 的预签名策略上限。 */
export const WORKER_ARTIFACT_DOWNLOAD_TTL_SECONDS = 60;
/** Worker 需要读取中心校验过的 Skill 包文件；写侧服务仍保留各自更小的业务配额。 */
const WORKER_MAX_BLOB_SIZE_BYTES = 32 * 1024 * 1024;

const workerEnvironmentSchema = Object.freeze({
  DATABASE_URL: urlEnvironmentField({
    secret: true,
    protocols: ["postgres:", "postgresql:"],
    allowCredentials: true,
    maxLength: 8_192,
  }),
  DATABASE_SCHEMA: stringEnvironmentField({ maxLength: 63 }),
  DATABASE_RUNTIME_ROLE: stringEnvironmentField({ maxLength: 63 }),
  DATABASE_WORKER_COORDINATOR_URL: urlEnvironmentField({
    secret: true,
    protocols: ["postgres:", "postgresql:"],
    allowCredentials: true,
    maxLength: 8_192,
  }),
  DATABASE_WORKER_COORDINATOR_ROLE: stringEnvironmentField({ maxLength: 63 }),
  S3_ENDPOINT: urlEnvironmentField(),
  S3_BUCKET: stringEnvironmentField({ maxLength: 255 }),
  S3_REGION: stringEnvironmentField({ maxLength: 128 }),
  S3_ACCESS_KEY_ID: stringEnvironmentField({ secret: true, maxLength: 1_024 }),
  S3_SECRET_ACCESS_KEY: stringEnvironmentField({ secret: true, maxLength: 4_096 }),
  S3_FORCE_PATH_STYLE: booleanEnvironmentField(),
  SANDBOX_DEFAULT_PROVIDER: stringEnvironmentField({ maxLength: 16, requiredIn: [] }),
  SANDBOX_ENABLED_PROVIDERS: stringEnvironmentField({ maxLength: 64, requiredIn: [] }),
  E2B_API_KEY: stringEnvironmentField({ secret: true, maxLength: 8_192, requiredIn: [] }),
  E2B_TEMPLATE_ID: stringEnvironmentField({ maxLength: 255, requiredIn: [] }),
  E2B_DOMAIN: stringEnvironmentField({ maxLength: 255, requiredIn: [] }),
  E2B_SESSION_TTL_SECONDS: integerEnvironmentField({
    minimum: 1,
    maximum: 86_400,
    requiredIn: [],
  }),
  TENCENT_AGS_API_KEY: stringEnvironmentField({ secret: true, maxLength: 8_192, requiredIn: [] }),
  TENCENT_AGS_TEMPLATE_ID: stringEnvironmentField({ maxLength: 255, requiredIn: [] }),
  TENCENT_AGS_DOMAIN: stringEnvironmentField({ maxLength: 255, requiredIn: [] }),
  TENCENT_AGS_SESSION_TTL_SECONDS: integerEnvironmentField({
    minimum: 1,
    maximum: 86_400,
    requiredIn: [],
  }),
  CUBESANDBOX_API_URL: urlEnvironmentField({ requiredIn: [] }),
  CUBESANDBOX_TEMPLATE_ID: stringEnvironmentField({ maxLength: 255, requiredIn: [] }),
  CUBESANDBOX_API_KEY: stringEnvironmentField({
    secret: true,
    maxLength: 4_096,
    requiredIn: [],
  }),
  CUBESANDBOX_PROXY_NODE_IP: stringEnvironmentField({ maxLength: 255, requiredIn: [] }),
  CUBESANDBOX_PROXY_PORT: integerEnvironmentField({
    minimum: 1,
    maximum: 65_535,
    requiredIn: [],
  }),
  CUBESANDBOX_PROXY_SCHEME: stringEnvironmentField({ maxLength: 5, requiredIn: [] }),
  CUBESANDBOX_RESOURCE_VOLUME_DRIVER: stringEnvironmentField({ requiredIn: [], maxLength: 128 }),
  MODEL_BASE_URL: urlEnvironmentField({ requiredIn: [] }),
  MODEL_API_KEY: stringEnvironmentField({ requiredIn: [], secret: true, maxLength: 8_192 }),
  MODEL_CREDENTIAL_ENCRYPTION_KEY: stringEnvironmentField({
    requiredIn: ["production"],
    secret: true,
    maxLength: 4_096,
  }),
  MODEL_ID: stringEnvironmentField({ requiredIn: [], maxLength: 255 }),
  MODEL_SUPPORTS_IMAGES: booleanEnvironmentField({ requiredIn: [] }),
  MODEL_CONTEXT_WINDOW: integerEnvironmentField({
    requiredIn: [],
    minimum: 1,
    maximum: 10_000_000,
  }),
  MODEL_MAX_OUTPUT_TOKENS: integerEnvironmentField({
    requiredIn: [],
    minimum: 1,
    maximum: 10_000_000,
  }),
  MODEL_WIRE_TRACE_ENABLED: booleanEnvironmentField(),
  EXTERNAL_TOOLS_ALLOW_PRIVATE_ADDRESSES: booleanEnvironmentField({ requiredIn: [] }),
  MODEL_WIRE_TRACE_RETENTION_DAYS: integerEnvironmentField({ minimum: 1, maximum: 365 }),
  // 每个 request/response 原始字节独立上限；超过后保存精确前缀并标为 truncated。
  MODEL_WIRE_TRACE_MAX_BYTES: integerEnvironmentField({ minimum: 1, maximum: 8 * 1024 * 1024 }),
  MEM0_MEMORY_ENABLED: booleanEnvironmentField({ requiredIn: [] }),
  MEM0_API_BASE_URL: urlEnvironmentField({ requiredIn: [] }),
  MEM0_API_KEY: stringEnvironmentField({ secret: true, maxLength: 8_192, requiredIn: [] }),
  MEM0_SCOPE_HMAC_KEY: stringEnvironmentField({ secret: true, maxLength: 8_192, requiredIn: [] }),
  MEM0_REQUEST_TIMEOUT_MS: integerEnvironmentField({
    minimum: 100,
    maximum: 120_000,
    requiredIn: [],
  }),
  AGENT_WORKER_TENANT_ID: stringEnvironmentField({ maxLength: 200 }),
  AGENT_WORKER_ID: stringEnvironmentField({ maxLength: 200 }),
  AGENT_WORKER_MAX_CONCURRENT_RUNS: integerEnvironmentField({
    minimum: 1,
    maximum: 100,
    requiredIn: [],
  }),
  AGENT_WORKER_USER_MAX_CONCURRENT_RUNS_PER_TENANT: integerEnvironmentField({
    minimum: 1,
    maximum: 100,
    requiredIn: [],
  }),
  AGENT_WORKER_POLL_INTERVAL_MS: integerEnvironmentField({ minimum: 10, maximum: 60_000 }),
  AGENT_WORKER_DISPATCH_LEASE_MS: integerEnvironmentField({ minimum: 1_000, maximum: 300_000 }),
  AGENT_WORKER_RUN_LEASE_MS: integerEnvironmentField({ minimum: 9_000, maximum: 300_000 }),
  AGENT_WORKER_RUN_TIMEOUT_MS: integerEnvironmentField({ minimum: 1_000, maximum: 86_400_000 }),
  THREAD_SERIAL_QUEUE_V2_ENABLED: booleanEnvironmentField({ requiredIn: [] }),
  THREAD_CONTEXT_V2_WRITE_ENABLED: booleanEnvironmentField({ requiredIn: [] }),
  THREAD_CONTEXT_V2_SHADOW_READ_ENABLED: booleanEnvironmentField({ requiredIn: [] }),
  THREAD_CONTEXT_V2_READ_ENABLED: booleanEnvironmentField({ requiredIn: [] }),
  THREAD_INPUT_ROUTING_V2_ENABLED: booleanEnvironmentField({ requiredIn: [] }),
  THREAD_CONTEXT_INLINE_BODY_MAX_BYTES: integerEnvironmentField({
    minimum: 256,
    maximum: 1_048_576,
    requiredIn: [],
  }),
  THREAD_CONTEXT_COMPACTION_ENABLED: booleanEnvironmentField({ requiredIn: [] }),
  THREAD_CONTEXT_COMPACTION_PATH: stringEnvironmentField({ maxLength: 16, requiredIn: [] }),
  THREAD_CONTEXT_COMPACTION_SOFT_LIMIT_PERCENT: integerEnvironmentField({
    minimum: 1,
    maximum: 99,
    requiredIn: [],
  }),
  THREAD_CONTEXT_COMPACTION_TARGET_PERCENT: integerEnvironmentField({
    minimum: 1,
    maximum: 98,
    requiredIn: [],
  }),
  THREAD_CONTEXT_COMPACTION_RECENT_USER_TOKENS: integerEnvironmentField({
    minimum: 1,
    maximum: 10_000_000,
    requiredIn: [],
  }),
  THREAD_CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS: integerEnvironmentField({
    minimum: 1,
    maximum: 10_000_000,
    requiredIn: [],
  }),
  THREAD_CONTEXT_COMPACTION_TIMEOUT_MS: integerEnvironmentField({
    minimum: 1,
    maximum: 600_000,
    requiredIn: [],
  }),
  THREAD_SANDBOX_SESSION_REUSE_ENABLED: booleanEnvironmentField({ requiredIn: [] }),
  HISTORY_FILESYSTEM_ENABLED: booleanEnvironmentField({ requiredIn: [] }),
  HISTORY_DIRECTORY_TIME_ZONE: stringEnvironmentField({ requiredIn: [], maxLength: 128 }),
  SUBAGENTS_ENABLED: booleanEnvironmentField({ requiredIn: [] }),
  CUBESANDBOX_SESSION_TTL_SECONDS: integerEnvironmentField({
    minimum: 1,
    maximum: 86_400,
    requiredIn: [],
  }),
  THREAD_SANDBOX_PAUSED_RETENTION_SECONDS: integerEnvironmentField({
    minimum: 1,
    maximum: 31_536_000,
    requiredIn: [],
  }),
  THREAD_SANDBOX_LIFECYCLE_TIMEOUT_MS: integerEnvironmentField({
    minimum: 1,
    maximum: 600_000,
    requiredIn: [],
  }),
  // 这些字段在 production 显式禁止；保留在投影视图中是为了让遗留部署携带开发身份时也失败关闭。
  DEV_AUTH_ENABLED: booleanEnvironmentField({ requiredIn: ["development"] }),
  DEV_AUTH_USER_A_ID: stringEnvironmentField({ requiredIn: [], maxLength: 128 }),
  DEV_AUTH_USER_A_TENANT_ID: stringEnvironmentField({
    requiredIn: ["development"],
    maxLength: 128,
  }),
  DEV_AUTH_USER_B_ID: stringEnvironmentField({ requiredIn: [], maxLength: 128 }),
  DEV_AUTH_USER_B_TENANT_ID: stringEnvironmentField({ requiredIn: [], maxLength: 128 }),
  PROCESS_SHUTDOWN_TIMEOUT_MS: integerEnvironmentField({ minimum: 1, maximum: 600_000 }),
});
export const workerProcessEnvironmentKeys = Object.freeze(Object.keys(workerEnvironmentSchema));

export interface WorkerProcessConfiguration {
  readonly runtimeEnvironment: RuntimeEnvironment;
  readonly databaseUrl: string;
  readonly databaseSsl?: Readonly<{ readonly rejectUnauthorized: true }>;
  readonly databaseWorkerCoordinatorUrl: string;
  readonly databaseWorkerCoordinatorSsl?: Readonly<{ readonly rejectUnauthorized: true }>;
  readonly databaseSchema: string;
  /** 仅用于启动时证明连接 URL 未误用 Migrator/Owner；服务永不 SET ROLE。 */
  readonly databaseRuntimeRole: string;
  /** 仅登录无业务载荷的全局 assignment claim 控制面。 */
  readonly databaseWorkerCoordinatorRole: string;
  readonly objectStorage: Readonly<{
    endpoint: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  }>;
  readonly sandbox: Readonly<{
    defaultProviderKey: SandboxProviderKey;
    enabledProviderKeys: readonly SandboxProviderKey[];
    e2b?: Readonly<{
      apiKey: string;
      templateId: string;
      domain?: string;
      sessionTtlSeconds: number;
    }>;
    tencentAgs?: Readonly<{
      apiKey: string;
      templateId: string;
      domain: string;
      sessionTtlSeconds: number;
    }>;
    apiUrl?: string;
    templateId?: string;
    apiKey?: string;
    proxyNodeIp?: string;
    proxyPort?: number;
    proxyScheme?: "http" | "https";
    resourceVolumeDriver: string;
  }>;
  readonly externalToolsAllowPrivateAddresses: boolean;
  readonly model: Readonly<{
    baseUrl: string;
    apiKey: string;
    credentialEncryptionKey: string;
    modelId: string;
    supportsImages: boolean;
    contextWindow: number;
    maxOutputTokens: number;
    wireTraceMaxBytes: number;
    wireTraceEnabled: boolean;
    wireTraceRetentionDays: number;
  }>;
  readonly worker: Readonly<{
    tenantId: string;
    workerId: string;
    maxConcurrentRuns: number;
    userMaxConcurrentRunsPerTenant: number;
    pollIntervalMs: number;
    dispatchLeaseMs: number;
    runLeaseMs: number;
    runTimeoutMs: number;
  }>;
  readonly threadContext: Readonly<{
    serialQueueV2Enabled: boolean;
    writeEnabled: boolean;
    shadowReadEnabled: boolean;
    readEnabled: boolean;
    inputRoutingEnabled: boolean;
    inlineBodyMaxBytes: number;
    compaction: Readonly<{
      enabled: boolean;
      path: "local" | "remote";
      softLimitPercent: number;
      targetPercent: number;
      recentUserTokens: number;
      maxOutputTokens: number;
      timeoutMs: number;
    }>;
  }>;
  readonly threadSandbox: Readonly<{
    reuseEnabled: boolean;
    sessionTtlSeconds: number;
    pausedRetentionSeconds: number;
    lifecycleTimeoutMs: number;
  }>;
  readonly historyFilesystemEnabled: boolean;
  readonly historyDirectoryTimeZone: string;
  readonly subagents: Readonly<{ enabled: boolean }>;
  readonly memory: Mem0DevelopmentConfiguration;
  readonly memoryDeploymentSecrets?: Readonly<{
    readonly apiKey: string;
    readonly scopeHmacKey: string;
  }>;
  readonly development?: Readonly<{
    readonly userATenantId: string;
  }>;
  readonly shutdownTimeoutMilliseconds: number;
}

function parseSandboxProviderKey(value: string): SandboxProviderKey {
  if (value === "cube" || value === "e2b" || value === "tencent-ags") return value;
  throw new TypeError("SANDBOX_DEFAULT_PROVIDER 只能是 cube、e2b 或 tencent-ags");
}

function parseEnabledSandboxProviders(value: string): readonly SandboxProviderKey[] {
  if (value === "") return Object.freeze([]);
  const keys = value.split(",").map((item) => parseSandboxProviderKey(item.trim()));
  if (keys.length === 0 || new Set(keys).size !== keys.length) {
    throw new TypeError("SANDBOX_ENABLED_PROVIDERS 必须是非空且不重复的 Provider 列表");
  }
  return Object.freeze(keys);
}

function requireOptionalEnvironment(value: string | undefined, name: string): string {
  if (value === undefined) throw new TypeError(`${name} 在启用 E2B Provider 时必填`);
  return value;
}

export function selectWorkerProcessEnvironment(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string | undefined>> {
  assertProductionInheritedEnvironment(source);
  return selectDeclaredEnvironment(source, workerProcessEnvironmentKeys);
}

export function parseWorkerProcessEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): WorkerProcessConfiguration {
  assertProductionInheritedEnvironment(source);
  const memory = parseMem0DevelopmentEnvironment(source);
  const parsed = parseStrictEnvironment(source, workerEnvironmentSchema);
  if (parsed.runtimeEnvironment === "production") {
    assertProductionHasNoDevelopmentIdentity(source);
  }
  const defaultProviderKey = parseSandboxProviderKey(
    parsed.values.SANDBOX_DEFAULT_PROVIDER ?? "cube",
  );
  const enabledProviderKeys = parseEnabledSandboxProviders(
    parsed.values.SANDBOX_ENABLED_PROVIDERS ?? (parsed.values.CUBESANDBOX_API_URL ? "cube" : ""),
  );
  if (enabledProviderKeys.length > 0 && !enabledProviderKeys.includes(defaultProviderKey)) {
    throw new TypeError("SANDBOX_DEFAULT_PROVIDER 必须包含在 SANDBOX_ENABLED_PROVIDERS 中");
  }
  const e2b = enabledProviderKeys.includes("e2b")
    ? Object.freeze({
        apiKey: requireOptionalEnvironment(parsed.values.E2B_API_KEY, "E2B_API_KEY"),
        templateId: requireOptionalEnvironment(parsed.values.E2B_TEMPLATE_ID, "E2B_TEMPLATE_ID"),
        sessionTtlSeconds: parsed.values.E2B_SESSION_TTL_SECONDS ?? 3_600,
        ...(parsed.values.E2B_DOMAIN === undefined ? {} : { domain: parsed.values.E2B_DOMAIN }),
      })
    : undefined;
  const tencentAgs = enabledProviderKeys.includes("tencent-ags")
    ? Object.freeze({
        apiKey: requireOptionalEnvironment(
          parsed.values.TENCENT_AGS_API_KEY,
          "TENCENT_AGS_API_KEY",
        ),
        templateId: requireOptionalEnvironment(
          parsed.values.TENCENT_AGS_TEMPLATE_ID,
          "TENCENT_AGS_TEMPLATE_ID",
        ),
        sessionTtlSeconds: parsed.values.TENCENT_AGS_SESSION_TTL_SECONDS ?? 3_600,
        domain: requireOptionalEnvironment(parsed.values.TENCENT_AGS_DOMAIN, "TENCENT_AGS_DOMAIN"),
      })
    : undefined;
  const proxyScheme = parsed.values.CUBESANDBOX_PROXY_SCHEME;
  const configuredDatabaseUrl = readRequiredEnvironmentValue(parsed, "DATABASE_URL");
  const configuredWorkerCoordinatorUrl = readRequiredEnvironmentValue(
    parsed,
    "DATABASE_WORKER_COORDINATOR_URL",
  );
  const productionDatabase =
    parsed.runtimeEnvironment === "production"
      ? parseProductionPostgresTransport(configuredDatabaseUrl)
      : undefined;
  const productionWorkerCoordinatorDatabase =
    parsed.runtimeEnvironment === "production"
      ? parseProductionPostgresTransport(configuredWorkerCoordinatorUrl)
      : undefined;
  if (proxyScheme !== undefined && proxyScheme !== "http" && proxyScheme !== "https") {
    throw new TypeError("CUBESANDBOX_PROXY_SCHEME 只能是 http 或 https");
  }
  if (parsed.runtimeEnvironment === "development") {
    if (
      readRequiredEnvironmentValue(parsed, "AGENT_WORKER_TENANT_ID") !==
      readRequiredEnvironmentValue(parsed, "DEV_AUTH_USER_A_TENANT_ID")
    ) {
      throw new TypeError("AGENT_WORKER_TENANT_ID 必须与 DEV_AUTH_USER_A_TENANT_ID 一致");
    }
  }
  const configuredTenantId = readRequiredEnvironmentValue(parsed, "AGENT_WORKER_TENANT_ID");
  tenantId(configuredTenantId);
  const configuredWorkerId = readRequiredEnvironmentValue(parsed, "AGENT_WORKER_ID");
  if (Buffer.byteLength(configuredWorkerId, "utf8") > 200) {
    throw new TypeError("AGENT_WORKER_ID UTF-8 字节长度不能超过 200");
  }
  const configuredRuntimeRole = readRequiredEnvironmentValue(parsed, "DATABASE_RUNTIME_ROLE");
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(configuredRuntimeRole)) {
    throw new TypeError("DATABASE_RUNTIME_ROLE 格式无效");
  }
  const configuredWorkerCoordinatorRole = readRequiredEnvironmentValue(
    parsed,
    "DATABASE_WORKER_COORDINATOR_ROLE",
  );
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(configuredWorkerCoordinatorRole)) {
    throw new TypeError("DATABASE_WORKER_COORDINATOR_ROLE 格式无效");
  }
  if (configuredWorkerCoordinatorRole === configuredRuntimeRole) {
    throw new TypeError("DATABASE_WORKER_COORDINATOR_ROLE 必须与 DATABASE_RUNTIME_ROLE 不同");
  }
  const modelKeys = ["MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_ID"] as const;
  const deploymentModelConfigured = modelKeys.some((key) => parsed.values[key] !== undefined);
  if (deploymentModelConfigured) {
    const missing = modelKeys.filter((key) => parsed.values[key] === undefined);
    if (missing.length > 0)
      throw new EnvironmentConfigurationError(
        missing.map((key) => ({ code: "MISSING" as const, key })),
      );
  }
  const contextWindow = deploymentModelConfigured
    ? readRequiredEnvironmentValue(parsed, "MODEL_CONTEXT_WINDOW")
    : 128_000;
  const maxOutputTokens = deploymentModelConfigured
    ? readRequiredEnvironmentValue(parsed, "MODEL_MAX_OUTPUT_TOKENS")
    : 8_192;
  const wireTraceEnabled = readRequiredEnvironmentValue(parsed, "MODEL_WIRE_TRACE_ENABLED");
  if (maxOutputTokens > contextWindow) {
    throw new TypeError("MODEL_MAX_OUTPUT_TOKENS 不能大于 MODEL_CONTEXT_WINDOW");
  }
  // raw prompt/SSE 的保留清理消费者尚未随本 Worker 部署；production 不能留下无界敏感引用。
  if (parsed.runtimeEnvironment === "production" && wireTraceEnabled) {
    throw new TypeError("MODEL_WIRE_TRACE_ENABLED 在 production 需要已部署保留清理消费者");
  }
  const serialQueueV2Enabled = parsed.values.THREAD_SERIAL_QUEUE_V2_ENABLED ?? true;
  const contextWriteEnabled = parsed.values.THREAD_CONTEXT_V2_WRITE_ENABLED ?? true;
  const contextShadowReadEnabled = parsed.values.THREAD_CONTEXT_V2_SHADOW_READ_ENABLED ?? true;
  const contextReadEnabled = parsed.values.THREAD_CONTEXT_V2_READ_ENABLED ?? true;
  const inputRoutingEnabled = parsed.values.THREAD_INPUT_ROUTING_V2_ENABLED ?? true;
  const compactionEnabled = parsed.values.THREAD_CONTEXT_COMPACTION_ENABLED ?? true;
  const sandboxSessionReuseEnabled = parsed.values.THREAD_SANDBOX_SESSION_REUSE_ENABLED ?? true;
  const historyFilesystemEnabled = parsed.values.HISTORY_FILESYSTEM_ENABLED ?? false;
  const historyDirectoryTimeZone =
    parsed.values.HISTORY_DIRECTORY_TIME_ZONE ?? DEFAULT_HISTORY_DIRECTORY_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: historyDirectoryTimeZone }).format(new Date(0));
  } catch {
    throw new TypeError("HISTORY_DIRECTORY_TIME_ZONE 无效");
  }
  const subagentsEnabled = parsed.values.SUBAGENTS_ENABLED ?? true;
  const runTimeoutMs = parsed.values.AGENT_WORKER_RUN_TIMEOUT_MS ?? 12 * 60 * 60_000;
  const sessionTtlSeconds = parsed.values.CUBESANDBOX_SESSION_TTL_SECONDS ?? 12 * 60 * 60 + 600;
  const sandboxLifecycleTimeoutMs = parsed.values.THREAD_SANDBOX_LIFECYCLE_TIMEOUT_MS ?? 90_000;
  const compactionPath = parsed.values.THREAD_CONTEXT_COMPACTION_PATH ?? "local";
  if (compactionPath !== "local" && compactionPath !== "remote") {
    throw new TypeError("THREAD_CONTEXT_COMPACTION_PATH 只能是 local 或 remote");
  }
  if (contextWriteEnabled && !serialQueueV2Enabled) {
    throw new TypeError("THREAD_CONTEXT_V2_WRITE_ENABLED 依赖 Thread 串行队列");
  }
  if (contextShadowReadEnabled && !contextWriteEnabled) {
    throw new TypeError("THREAD_CONTEXT_V2_SHADOW_READ_ENABLED 依赖 V2 write");
  }
  if (contextReadEnabled && !contextShadowReadEnabled) {
    throw new TypeError("THREAD_CONTEXT_V2_READ_ENABLED 依赖 shadow read");
  }
  if (inputRoutingEnabled && (!serialQueueV2Enabled || !contextReadEnabled)) {
    throw new TypeError("THREAD_INPUT_ROUTING_V2_ENABLED 依赖串行队列与 V2 Context read");
  }
  if (compactionEnabled && (!serialQueueV2Enabled || !contextWriteEnabled || !contextReadEnabled)) {
    throw new TypeError("THREAD_CONTEXT_COMPACTION_ENABLED 依赖串行队列与 V2 Context write/read");
  }
  if (
    sandboxSessionReuseEnabled &&
    (!serialQueueV2Enabled || !contextWriteEnabled || !contextReadEnabled)
  ) {
    throw new TypeError(
      "THREAD_SANDBOX_SESSION_REUSE_ENABLED 依赖串行队列与 V2 Context write/read",
    );
  }
  // Provider TTL 从创建时开始倒计时；它必须覆盖整个 Run 以及超时后的安全收敛窗口，
  // 否则活跃任务会在 Worker 截止时间前被平台主动销毁。
  if (sessionTtlSeconds * 1_000 < runTimeoutMs + sandboxLifecycleTimeoutMs) {
    throw new TypeError(
      "CUBESANDBOX_SESSION_TTL_SECONDS 必须覆盖 AGENT_WORKER_RUN_TIMEOUT_MS 与 Sandbox 收敛窗口",
    );
  }
  const compactionSoftLimitPercent =
    parsed.values.THREAD_CONTEXT_COMPACTION_SOFT_LIMIT_PERCENT ?? 80;
  const compactionTargetPercent = parsed.values.THREAD_CONTEXT_COMPACTION_TARGET_PERCENT ?? 55;
  if (compactionTargetPercent >= compactionSoftLimitPercent) {
    throw new TypeError("THREAD_CONTEXT_COMPACTION_TARGET_PERCENT 必须小于 soft limit");
  }
  const memoryApiKey = parsed.values.MEM0_API_KEY;
  const memoryScopeHmacKey = parsed.values.MEM0_SCOPE_HMAC_KEY;
  if ((memoryApiKey === undefined) !== (memoryScopeHmacKey === undefined)) {
    throw new TypeError("MEM0_API_KEY 与 MEM0_SCOPE_HMAC_KEY 必须同时配置");
  }
  const sandboxApiUrl = parsed.values.CUBESANDBOX_API_URL;
  if (enabledProviderKeys.includes("cube")) {
    readRequiredEnvironmentValue(parsed, "CUBESANDBOX_API_URL");
    readRequiredEnvironmentValue(parsed, "CUBESANDBOX_TEMPLATE_ID");
  }
  if (parsed.runtimeEnvironment === "production") {
    assertProductionWorkerTransport({
      modelBaseUrl: parsed.values.MODEL_BASE_URL,
      objectStorageEndpoint: readRequiredEnvironmentValue(parsed, "S3_ENDPOINT"),
      sandboxApiUrl,
    });
  }
  const proxyRouting: Partial<ReturnType<typeof resolveCubeProxyRouting>> =
    sandboxApiUrl === undefined
      ? {}
      : resolveCubeProxyRouting({
          apiUrl: sandboxApiUrl,
          ...(parsed.values.CUBESANDBOX_PROXY_NODE_IP === undefined
            ? {}
            : { proxyNodeIp: parsed.values.CUBESANDBOX_PROXY_NODE_IP }),
          ...(parsed.values.CUBESANDBOX_PROXY_PORT === undefined
            ? {}
            : { proxyPort: parsed.values.CUBESANDBOX_PROXY_PORT }),
          ...(proxyScheme === undefined ? {} : { proxyScheme }),
        });
  if (
    parsed.runtimeEnvironment === "production" &&
    sandboxApiUrl !== undefined &&
    proxyRouting.proxyScheme !== "https"
  ) {
    throw new TypeError("CUBESANDBOX_PROXY_SCHEME 在 production 必须为 https");
  }
  return Object.freeze({
    runtimeEnvironment: parsed.runtimeEnvironment,
    databaseUrl: productionDatabase?.connectionString ?? configuredDatabaseUrl,
    ...(productionDatabase === undefined ? {} : { databaseSsl: productionDatabase.ssl }),
    databaseWorkerCoordinatorUrl:
      productionWorkerCoordinatorDatabase?.connectionString ?? configuredWorkerCoordinatorUrl,
    ...(productionWorkerCoordinatorDatabase === undefined
      ? {}
      : { databaseWorkerCoordinatorSsl: productionWorkerCoordinatorDatabase.ssl }),
    databaseSchema: readRequiredEnvironmentValue(parsed, "DATABASE_SCHEMA"),
    databaseRuntimeRole: configuredRuntimeRole,
    databaseWorkerCoordinatorRole: configuredWorkerCoordinatorRole,
    objectStorage: Object.freeze({
      endpoint: readRequiredEnvironmentValue(parsed, "S3_ENDPOINT"),
      bucket: readRequiredEnvironmentValue(parsed, "S3_BUCKET"),
      region: readRequiredEnvironmentValue(parsed, "S3_REGION"),
      accessKeyId: readRequiredEnvironmentValue(parsed, "S3_ACCESS_KEY_ID"),
      secretAccessKey: readRequiredEnvironmentValue(parsed, "S3_SECRET_ACCESS_KEY"),
      forcePathStyle: readRequiredEnvironmentValue(parsed, "S3_FORCE_PATH_STYLE"),
    }),
    sandbox: Object.freeze({
      defaultProviderKey,
      enabledProviderKeys,
      ...(e2b === undefined ? {} : { e2b }),
      ...(tencentAgs === undefined ? {} : { tencentAgs }),
      ...(sandboxApiUrl === undefined ? {} : { apiUrl: sandboxApiUrl }),
      ...(parsed.values.CUBESANDBOX_TEMPLATE_ID === undefined
        ? {}
        : { templateId: parsed.values.CUBESANDBOX_TEMPLATE_ID }),
      ...(parsed.values.CUBESANDBOX_API_KEY === undefined
        ? {}
        : { apiKey: parsed.values.CUBESANDBOX_API_KEY }),
      resourceVolumeDriver:
        parsed.values.CUBESANDBOX_RESOURCE_VOLUME_DRIVER ?? "runtime-resourcefs",
      ...proxyRouting,
    }),
    externalToolsAllowPrivateAddresses:
      parsed.values.EXTERNAL_TOOLS_ALLOW_PRIVATE_ADDRESSES ?? false,
    model: Object.freeze({
      baseUrl: parsed.values.MODEL_BASE_URL ?? "https://unconfigured.invalid/v1",
      apiKey: parsed.values.MODEL_API_KEY ?? "",
      credentialEncryptionKey:
        parsed.values.MODEL_CREDENTIAL_ENCRYPTION_KEY ??
        readRequiredEnvironmentValue(parsed, "MODEL_API_KEY"),
      modelId: parsed.values.MODEL_ID ?? "unconfigured",
      supportsImages: deploymentModelConfigured
        ? readRequiredEnvironmentValue(parsed, "MODEL_SUPPORTS_IMAGES")
        : false,
      contextWindow,
      maxOutputTokens,
      wireTraceMaxBytes: readRequiredEnvironmentValue(parsed, "MODEL_WIRE_TRACE_MAX_BYTES"),
      wireTraceEnabled,
      wireTraceRetentionDays: readRequiredEnvironmentValue(
        parsed,
        "MODEL_WIRE_TRACE_RETENTION_DAYS",
      ),
    }),
    worker: Object.freeze({
      tenantId: configuredTenantId,
      workerId: configuredWorkerId,
      maxConcurrentRuns:
        parsed.values.AGENT_WORKER_MAX_CONCURRENT_RUNS ?? DEFAULT_WORKER_MAX_CONCURRENT_RUNS,
      userMaxConcurrentRunsPerTenant:
        parsed.values.AGENT_WORKER_USER_MAX_CONCURRENT_RUNS_PER_TENANT ??
        DEFAULT_USER_MAX_CONCURRENT_RUNS_PER_TENANT,
      pollIntervalMs: readRequiredEnvironmentValue(parsed, "AGENT_WORKER_POLL_INTERVAL_MS"),
      dispatchLeaseMs: readRequiredEnvironmentValue(parsed, "AGENT_WORKER_DISPATCH_LEASE_MS"),
      runLeaseMs: readRequiredEnvironmentValue(parsed, "AGENT_WORKER_RUN_LEASE_MS"),
      runTimeoutMs,
    }),
    threadContext: Object.freeze({
      serialQueueV2Enabled,
      writeEnabled: contextWriteEnabled,
      shadowReadEnabled: contextShadowReadEnabled,
      readEnabled: contextReadEnabled,
      inputRoutingEnabled,
      inlineBodyMaxBytes: parsed.values.THREAD_CONTEXT_INLINE_BODY_MAX_BYTES ?? 16 * 1024,
      compaction: Object.freeze({
        enabled: compactionEnabled,
        path: compactionPath,
        softLimitPercent: compactionSoftLimitPercent,
        targetPercent: compactionTargetPercent,
        recentUserTokens: parsed.values.THREAD_CONTEXT_COMPACTION_RECENT_USER_TOKENS ?? 4_096,
        maxOutputTokens:
          parsed.values.THREAD_CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS ?? maxOutputTokens,
        timeoutMs: parsed.values.THREAD_CONTEXT_COMPACTION_TIMEOUT_MS ?? 60_000,
      }),
    }),
    threadSandbox: Object.freeze({
      reuseEnabled: sandboxSessionReuseEnabled,
      sessionTtlSeconds,
      pausedRetentionSeconds: parsed.values.THREAD_SANDBOX_PAUSED_RETENTION_SECONDS ?? 86_400,
      lifecycleTimeoutMs: sandboxLifecycleTimeoutMs,
    }),
    historyFilesystemEnabled,
    historyDirectoryTimeZone,
    subagents: Object.freeze({ enabled: subagentsEnabled }),
    memory,
    ...(memoryApiKey === undefined || memoryScopeHmacKey === undefined
      ? {}
      : {
          memoryDeploymentSecrets: Object.freeze({
            apiKey: memoryApiKey,
            scopeHmacKey: memoryScopeHmacKey,
          }),
        }),
    ...(parsed.runtimeEnvironment === "development"
      ? {
          development: Object.freeze({
            userATenantId: readRequiredEnvironmentValue(parsed, "DEV_AUTH_USER_A_TENANT_ID"),
          }),
        }
      : {}),
    shutdownTimeoutMilliseconds: readRequiredEnvironmentValue(
      parsed,
      "PROCESS_SHUTDOWN_TIMEOUT_MS",
    ),
  });
}

/**
 * 本地 Provider 已由真实探针证明实现 Chat Completions；这里同时固定 Provider 与 Model 的
 * Pi 协议，避免其中一处漂移后静默改走不受支持的 Responses 路由。
 */
export async function createOpenAiCompatibleModel(
  configuration: Pick<
    WorkerProcessConfiguration["model"],
    "baseUrl" | "apiKey" | "modelId" | "supportsImages" | "contextWindow" | "maxOutputTokens"
  >,
): Promise<
  Readonly<{
    modelRuntime: Models;
    model: Model<"openai-completions">;
  }>
> {
  return await createOpenAiCompatibleProvider({
    baseUrl: configuration.baseUrl,
    apiKey: configuration.apiKey,
    defaultModelId: configuration.modelId,
    models: [
      {
        id: configuration.modelId,
        name: configuration.modelId,
        enabled: true,
        reasoning: isOfficialDeepSeekV4FlashModel(configuration.modelId),
        input: configuration.supportsImages ? ["text", "image"] : ["text"],
        contextWindow: configuration.contextWindow,
        maxTokens: configuration.maxOutputTokens,
      },
    ],
  });
}

/** Pi Provider 拥有启用模型目录；当前 Session 使用显式默认模型。 */
export async function createOpenAiCompatibleProvider(configuration: {
  readonly displayName?: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly defaultModelId: string;
  readonly models: readonly ModelProviderModelConfiguration[];
}): Promise<
  Readonly<{
    modelRuntime: Models;
    model: Model<"openai-completions">;
  }>
> {
  return await createOpenAiCompatiblePiProvider(configuration);
}

/** 模型计数能力由 Worker 自动解析；未知模型使用本地估算，不能阻断已发布 Provider。 */
export async function createOpenAiCompatibleModelContextCapability(
  modelRuntime: Models,
  model: Model<"openai-completions">,
): Promise<TrustedPiModelContextCapability> {
  const tokenizer = await loadTrustedModelTokenizerCapability(model.id);
  return bindTrustedPiModelContextCapability(modelRuntime, model, tokenizer);
}

/** 向后兼容本地开发测试的导出名；生产路径与固定开发身份无关。 */
export const createDevelopmentOpenAiCompatibleModel = createOpenAiCompatibleModel;

/**
 * 仅本地 development 使用的真实装配：PG dispatch、CubeSandbox、S3 durable observation 和
 * OpenAI-compatible provider 均为外部事实源；这里没有内存队列或 Sandbox 替身。
 */
export const developmentWorkerAssembler: ServiceAssemblyFactory<WorkerProcessConfiguration> = {
  async assemble(configuration) {
    if (
      configuration.runtimeEnvironment !== "development" ||
      configuration.development === undefined ||
      configuration.development.userATenantId !== configuration.worker.tenantId
    ) {
      throw new Error("DEVELOPMENT_WORKER_ASSEMBLY_FORBIDDEN");
    }
    return assembleWorkerRuntime(configuration, "development");
  },
};

/**
 * 将开关判断、fetch instrumentation 安装与 Session 创建收束为一个可验证的装配边界。
 * disabled 必须零副作用；enabled 必须先安装 instrumentation，再创建具体 Session。
 */
export function assembleModelWireTraceIfEnabled<T>(
  enabled: boolean,
  dependencies: Readonly<{
    readonly installFetchInstrumentation: () => void;
    readonly createSession: () => T;
  }>,
): T | undefined {
  if (!enabled) return undefined;
  dependencies.installFetchInstrumentation();
  return dependencies.createSession();
}

interface WorkerStartupProbes {
  readonly postgres: () => Promise<void>;
  readonly workerCoordinatorPostgres: () => Promise<void>;
  readonly objectStorage: () => Promise<void>;
  readonly sandbox: () => Promise<void>;
  readonly model: () => Promise<void>;
}

/** production 必须先独占完成数据库角色证明，才允许携带其他服务凭据发起远端探针。 */
export async function startWorkerLoopAfterDependencyProbes(
  runtimeMode: "development" | "production",
  probes: WorkerStartupProbes,
  startLoop: () => void,
): Promise<void> {
  if (runtimeMode === "production") {
    // 两个数据库登录身份都必须先证明为预期的非特权角色，再触达携带其他秘密的远端依赖。
    await Promise.all([probes.postgres(), probes.workerCoordinatorPostgres()]);
    await Promise.all([probes.objectStorage(), probes.sandbox(), probes.model()]);
  } else {
    await Promise.all([
      probes.postgres(),
      probes.workerCoordinatorPostgres(),
      probes.objectStorage(),
      probes.sandbox(),
      probes.model(),
    ]);
  }
  startLoop();
}

/**
 * 生产 assembler 是模块私有封闭依赖图：startWorkerProcess 从不接受调用方提供的替身。
 * 它与 development 共用持久化语义，但绝不继承 development 身份、明文下载或宽松模型探针。
 */
const productionWorkerAssembler: ServiceAssemblyFactory<WorkerProcessConfiguration> = {
  async assemble(configuration) {
    if (
      configuration.runtimeEnvironment !== "production" ||
      configuration.development !== undefined ||
      configuration.databaseSsl === undefined ||
      configuration.databaseWorkerCoordinatorSsl === undefined
    ) {
      throw new Error("PRODUCTION_WORKER_ASSEMBLY_FORBIDDEN");
    }
    if (process.platform !== "linux") throw new Error("PRODUCTION_WORKER_LINUX_REQUIRED");
    return assembleWorkerRuntime(configuration, "production");
  },
};

async function assembleWorkerRuntime(
  configuration: WorkerProcessConfiguration,
  runtimeMode: "development" | "production",
) {
  const pool = createPostgresPool({
    connectionString: configuration.databaseUrl,
    ...(configuration.databaseSsl === undefined ? {} : { ssl: configuration.databaseSsl }),
    schema: configuration.databaseSchema,
    expectedRuntimeRole: configuration.databaseRuntimeRole,
    applicationName:
      runtimeMode === "production"
        ? "hoox-agent-worker-production"
        : "hoox-agent-worker-development",
    // Worker 每个事件都走同一组带 RLS 的事务查询；复用执行计划可把单笔事务的规划开销降到原来的约 1/10。
    preparedStatements: true,
  });
  const coordinatorPool = createPostgresPool({
    connectionString: configuration.databaseWorkerCoordinatorUrl,
    ...(configuration.databaseWorkerCoordinatorSsl === undefined
      ? {}
      : { ssl: configuration.databaseWorkerCoordinatorSsl }),
    schema: configuration.databaseSchema,
    expectedRuntimeRole: configuration.databaseWorkerCoordinatorRole,
    applicationName:
      runtimeMode === "production"
        ? "hoox-agent-worker-coordinator-production"
        : "hoox-agent-worker-coordinator-development",
    maxConnections: 2,
  });
  try {
    const blobRepository = new PgBlobLifecycleRepository(pool, {
      objectPrefix: RUNTIME_BLOB_OBJECT_PREFIX,
    });
    const s3Config = {
      bucket: configuration.objectStorage.bucket,
      endpoint: configuration.objectStorage.endpoint,
      region: configuration.objectStorage.region,
      accessKeyId: configuration.objectStorage.accessKeyId,
      secretAccessKey: configuration.objectStorage.secretAccessKey,
      forcePathStyle: configuration.objectStorage.forcePathStyle,
      prefix: RUNTIME_BLOB_OBJECT_PREFIX,
      maxPresignTtlSeconds: WORKER_ARTIFACT_DOWNLOAD_TTL_SECONDS,
      // Resource 上传仍由 API 限制为 16 MiB；Worker 还需读取中心校验过的 32 MiB Skill 资源。
      maxBlobSizeBytes: WORKER_MAX_BLOB_SIZE_BYTES,
    } as const;
    const blobs = createS3BlobStore(s3Config, blobRepository);
    const resourceFilesystem = new PgResourceFilesystemCatalog(pool);
    const skillFilesystem = new PgSkillFilesystemCatalog(pool);
    const skillContents = new BlobSkillContentStore(blobs);
    const skillRuntime = new SkillRuntimeService(new PgSkillRuntimeRepository(pool), skillContents);
    const rolloutRepository = new PgRuntimeRolloutRepository(pool);
    const durableObservation = createPgDurableObservationSession({
      blobRepository,
      blobs,
      rolloutRepository,
      policy: { maxModelObservationBytes: 4 * 1024 },
    });
    const threadContextHistory = new PgThreadContextHistoryRepository(pool, blobs);
    const threadContextBodies = new ThreadContextBodyPersistence(
      new DurableTraceBlobPersistenceAdapter(blobRepository, blobs),
      configuration.threadContext.inlineBodyMaxBytes,
    );
    const createModelWireTraceSession = (baseUrl: string) =>
      new ModelWireTraceSession(
        withDevelopmentProjectModelWireTraceMirror(
          runtimeMode,
          new PgModelWireTraceRepository(
            pool,
            blobRepository,
            blobs,
            configuration.model.wireTraceRetentionDays,
          ),
        ),
        configuration.model.wireTraceMaxBytes,
        baseUrl,
      );
    const modelWireTraces = assembleModelWireTraceIfEnabled(configuration.model.wireTraceEnabled, {
      installFetchInstrumentation: installModelWireFetchInstrumentation,
      createSession: () => createModelWireTraceSession(configuration.model.baseUrl),
    });
    const runEventDiagnostics = createDevelopmentProjectRunEventMirror(
      runtimeMode,
      configuration.model.wireTraceEnabled,
    );
    const internalTrajectoryDiagnostics = createDevelopmentProjectInternalTrajectoryMirror(
      runtimeMode,
      configuration.model.wireTraceEnabled,
    );
    const phaseTimingDiagnostics = createDevelopmentProjectRunPhaseTimingMirror(
      runtimeMode,
      configuration.model.wireTraceEnabled,
    );
    const startupTimingDiagnostics = createDevelopmentProjectRunStartupTimingMirror(
      runtimeMode,
      configuration.model.wireTraceEnabled,
    );
    const { modelRuntime, model } = await createOpenAiCompatibleModel(configuration.model);
    const modelContext = await createOpenAiCompatibleModelContextCapability(modelRuntime, model);
    const threadContinuityMetrics = new PgThreadContinuityMetrics(pool);
    const runtimeCompaction = new RuntimeCompactionCoordinator(
      {
        ...configuration.threadContext.compaction,
        maxOutputTokens: Math.min(
          configuration.threadContext.compaction.maxOutputTokens,
          model.maxTokens,
        ),
      },
      model,
      modelRuntime,
      modelContext,
      new PgThreadContextCompactionRepository(pool, blobs),
      undefined,
      threadContinuityMetrics,
    );
    const artifactAuthorization = createArtifactExecutionAuthorizationAuthority();
    const resourceVolume =
      configuration.sandbox.apiUrl === undefined
        ? undefined
        : new CubeTenantResourceVolume({
            apiUrl: configuration.sandbox.apiUrl,
            apiKey: configuration.sandbox.apiKey ?? null,
            driver: configuration.sandbox.resourceVolumeDriver,
            requestTimeoutMs: 5_000,
          });
    const resourceFilesystemMaterializer = new ManagedResourceFilesystemSnapshotMaterializer({
      resources: resourceFilesystem,
      history: resourceFilesystem,
      blobs,
      skills: skillFilesystem,
      skillContents,
    });
    const upstreamSandboxes = createConfiguredSandboxRouter(
      configuration,
      resourceVolume,
      resourceFilesystemMaterializer,
      new PgSandboxConfigurationResolver(
        pool,
        new ModelProviderCredentialCipher(configuration.model.credentialEncryptionKey),
      ),
    );
    const sandboxes = new PgBackedSandboxSessionRegistry(pool, upstreamSandboxes);
    const threadSandboxes = new PgThreadSandboxSessionLifecycle(
      pool,
      upstreamSandboxes,
      {
        pausedRetentionSeconds: configuration.threadSandbox.pausedRetentionSeconds,
        transitionWaitMs: configuration.threadSandbox.lifecycleTimeoutMs,
      },
      threadContinuityMetrics,
    );
    const workspacePolicy = Object.freeze({
      maxEntries: 1_024,
      maxFiles: 1_000,
      maxTotalBytes: 8 * 1024 * 1024,
      maxSingleFileBytes: 8 * 1024 * 1024,
      maxChunkBytes: 256 * 1024,
      maxPathUtf8Bytes: 4_096,
      historicalManifest: Object.freeze({
        maxFiles: 1_000,
        maxTotalBytes: 8 * 1024 * 1024,
        maxSingleFileBytes: 8 * 1024 * 1024,
        maxPathUtf8Bytes: 4_096,
      }),
    });
    const workspaceManifest = new PgWorkspaceManifestRepository(pool, workspacePolicy);
    const workspaceRuntime = new ManifestWorkspaceRuntime({
      journal: workspaceManifest,
      revisions: workspaceManifest,
      stableBlobs: new PgWorkspaceStableBlobAccess(pool, blobs),
      candidateBlobs: new DurableWorkspaceCandidateBlobWriter(
        blobRepository,
        blobs,
        workspacePolicy.maxSingleFileBytes,
      ),
      candidates: new PgWorkspaceCandidateHandoff(pool, workspacePolicy),
      openSandboxWorkspace: async (input) =>
        upstreamSandboxes.connectWorkspace(
          upstreamSandboxes.workspaceCapability({
            scope: input.executionScope,
            session: input.session,
          }),
          {
            maxEntries: workspacePolicy.maxEntries,
            maxFileBytes: workspacePolicy.maxSingleFileBytes,
            maxTotalBytes: workspacePolicy.maxTotalBytes,
            maxPathUtf8Bytes: workspacePolicy.maxPathUtf8Bytes,
            maxCommandOutputBytes: Math.ceil((workspacePolicy.maxSingleFileBytes * 4) / 3) + 1_024,
            readChunkBytes: workspacePolicy.maxChunkBytes,
            maxSnapshots: 4,
            operationTimeoutMs: 30_000,
          },
          input.signal === undefined ? {} : { signal: input.signal },
        ),
      policy: workspacePolicy,
    });
    const resourceBlobWriter = new DurableResourceBlobWriter(
      blobRepository,
      blobs,
      workspacePolicy.maxSingleFileBytes,
      createS3StableBlobGarbageCollector(s3Config, blobRepository),
    );
    const deliverFileTools = new DeliverFileToolRouterFactory({
      source: new SandboxDeliverFileSource(
        async ({ binding, signal }) =>
          upstreamSandboxes.connectWorkspace(
            upstreamSandboxes.workspaceCapability({
              scope: binding.scope,
              session: binding.sandbox,
            }),
            {
              maxEntries: workspacePolicy.maxEntries,
              maxFileBytes: workspacePolicy.maxSingleFileBytes,
              maxTotalBytes: workspacePolicy.maxTotalBytes,
              maxPathUtf8Bytes: workspacePolicy.maxPathUtf8Bytes,
              maxCommandOutputBytes:
                Math.ceil((workspacePolicy.maxSingleFileBytes * 4) / 3) + 1_024,
              readChunkBytes: workspacePolicy.maxChunkBytes,
              maxSnapshots: 4,
              operationTimeoutMs: 30_000,
            },
            signal === undefined ? {} : { signal },
          ),
        workspacePolicy.maxSingleFileBytes,
      ),
      publications: new SimpleArtifactDeliveryService(
        new PgSimpleDeliveredFileRepository(pool),
        resourceBlobWriter,
      ),
      authorizationVerifier: artifactAuthorization.verifier,
    });
    const scheduledTasks = new PgScheduledTaskRepository(pool);
    const scheduledTaskConsumer = new PgScheduledTaskDueConsumer(pool, {
      historyFilesystemEnabled: configuration.historyFilesystemEnabled,
      historyDirectoryTimeZone: configuration.historyDirectoryTimeZone,
    });
    const deploymentSessions = new PiWorkerSessionFactory(
      model,
      modelRuntime,
      durableObservation.createRecorder,
      artifactAuthorization.issuer,
      durableObservation.prepare,
      modelWireTraces,
      deliverFileTools,
      configuration.threadContext.shadowReadEnabled
        ? async (input, compatibility) => {
            const compatibilityDigest = digestCanonical(compatibility);
            const throughSequence = input.contextThroughSequence ?? 0;
            const readHistory = async (
              mode: "shadow" | "read",
              sample: "primary" | "comparison" | "active",
            ) => {
              const startedAt = Date.now();
              const result = await threadContextHistory.readActiveHistory({
                scope: input.scope,
                attemptId: input.attemptId,
                throughSequence,
                compatibilityDigest,
                mode,
              });
              await threadContinuityMetrics
                .record({
                  tenantId: input.scope.tenantId,
                  threadId: input.scope.threadId,
                  runId: input.scope.runId,
                  observationId: `${input.attemptId}:context-rebuild:${sample}:${throughSequence}`,
                  metricName: "context_rebuild_latency_ms",
                  value: Math.max(0, Date.now() - startedAt),
                  unit: "milliseconds",
                  outcome: result.outcome,
                })
                .catch(() => undefined);
              return result;
            };
            const recordDigestMismatch = async (sample: "shadow" | "active") => {
              await threadContinuityMetrics
                .record({
                  tenantId: input.scope.tenantId,
                  threadId: input.scope.threadId,
                  runId: input.scope.runId,
                  observationId: `${input.attemptId}:context-digest-mismatch:${sample}:${throughSequence}`,
                  metricName: "context_recovery_digest_mismatch_total",
                  value: 1,
                  unit: "count",
                  reason: sample,
                })
                .catch(() => undefined);
            };
            const shadow = await readHistory("shadow", "primary");
            if (shadow.outcome !== "ready") {
              // Tenant/new-Thread 灰度未选中的 Thread 保持旧每 Run Session 读路径。
              if (shadow.outcome === "unsupported") return undefined;
              if (configuration.threadContext.readEnabled) {
                throw new Error(`THREAD_CONTEXT_${shadow.outcome.toUpperCase()}`);
              }
              return undefined;
            }
            const comparison = await readHistory("shadow", "comparison");
            if (
              comparison.outcome !== "ready" ||
              comparison.history.digest !== shadow.history.digest
            ) {
              await recordDigestMismatch("shadow");
              if (configuration.threadContext.readEnabled) {
                throw new Error("THREAD_CONTEXT_SHADOW_DIGEST_MISMATCH");
              }
              return undefined;
            }
            if (!configuration.threadContext.readEnabled) return undefined;
            const active = await readHistory("read", "active");
            if (active.outcome !== "ready" || active.history.digest !== comparison.history.digest) {
              await recordDigestMismatch("active");
              throw new Error("THREAD_CONTEXT_SHADOW_DIGEST_MISMATCH");
            }
            return active.history;
          }
        : undefined,
      configuration.threadContext.compaction.enabled
        ? async (input, compatibility, history, availableHistoryTokens, additionalVisibleTokens) =>
            await runtimeCompaction.prepare({
              fence: input.fence,
              attemptId: input.attemptId,
              compatibilityDigest: digestCanonical(compatibility),
              history,
              availableHistoryTokens,
              additionalVisibleTokens,
            })
        : undefined,
      new BlobPromptImageLoader(resourceFilesystem, blobs),
      skillRuntime,
      modelContext,
      internalTrajectoryDiagnostics,
      async (input) => {
        const result = await scheduledTasks.mutateFromRun(input);
        if (result.outcome === "applied" || result.outcome === "replayed") return result.task;
        const code =
          result.outcome === "not_found"
            ? "AUTOMATION_NOT_FOUND"
            : result.outcome === "not_authorized"
              ? "AUTOMATION_NOT_AUTHORIZED"
              : result.outcome === "invalid_state"
                ? "AUTOMATION_INVALID_STATE"
                : "AUTOMATION_KEY_CONFLICT";
        throw new Error(code);
      },
      threadContinuityMetrics,
    );
    const runtimeConfigurations = new PgRuntimeControlConfigurationRepository(
      pool,
      new ModelProviderCredentialCipher(configuration.model.credentialEncryptionKey),
      configuration.model.apiKey,
    );
    const titleConsumer = new ThreadTitleGenerationConsumer(
      new PgThreadTitleGenerationStore(pool),
      undefined,
      `${configuration.worker.workerId}-titles`,
      60_000,
      3,
      5_000,
      async () => {
        const titleModel = await runtimeConfigurations.resolveTitleModelConfiguration();
        return titleModel == null
          ? titleModel
          : new OpenAiCompatibleThreadTitleGenerator(titleModel);
      },
    );
    const sessions = new RuntimeConfiguredSessionFactory(
      runtimeConfigurations,
      new PgRunCompactionSettingsRepository(pool),
      configuration.threadContext.compaction,
      configuration.model.maxOutputTokens,
      async (snapshot, compactionSettings, tools) => {
        if (snapshot?.model === undefined && configuration.model.apiKey === "")
          throw new Error("MODEL_CONFIGURATION_REQUIRED");
        const configuredProvider = snapshot?.model?.configuration;
        const dynamicModel =
          snapshot?.model === undefined || snapshot.modelApiKey === undefined
            ? { model, modelRuntime }
            : await createOpenAiCompatibleProvider({
                displayName: snapshot.model.configuration.displayName,
                baseUrl: snapshot.model.configuration.baseUrl,
                apiKey: snapshot.modelApiKey,
                defaultModelId: snapshot.model.configuration.defaultModelId,
                models: snapshot.model.configuration.models,
              });
        const dynamicModelContext =
          snapshot?.model === undefined
            ? modelContext
            : await createOpenAiCompatibleModelContextCapability(
                dynamicModel.modelRuntime,
                dynamicModel.model,
              );
        const dynamicCompaction = new RuntimeCompactionCoordinator(
          {
            ...configuration.threadContext.compaction,
            ...compactionSettings,
          },
          dynamicModel.model,
          dynamicModel.modelRuntime,
          dynamicModelContext,
          new PgThreadContextCompactionRepository(pool, blobs),
          undefined,
          threadContinuityMetrics,
        );
        return deploymentSessions.withModel({
          ...tools,
          model: dynamicModel.model,
          modelRuntime: dynamicModel.modelRuntime,
          modelContext: dynamicModelContext,
          modelWireTraces: configuration.model.wireTraceEnabled
            ? createModelWireTraceSession(
                configuredProvider?.baseUrl ?? configuration.model.baseUrl,
              )
            : undefined,
          prepareRuntimeCompaction:
            configuration.threadContext.compaction.enabled &&
            (snapshot?.runtimeSettings?.configuration.compactionEnabled ?? true)
              ? async (
                  input,
                  compatibility,
                  history,
                  availableHistoryTokens,
                  additionalVisibleTokens,
                ) =>
                  await dynamicCompaction.prepare({
                    fence: input.fence,
                    attemptId: input.attemptId,
                    compatibilityDigest: digestCanonical(compatibility),
                    history,
                    availableHistoryTokens,
                    additionalVisibleTokens,
                  })
              : undefined,
        });
      },
    );
    const shutdown = new ProcessShutdown();
    const deploymentMemoryProvider = configuration.memory.enabled
      ? new Mem0PlatformMemoryProvider(configuration.memory)
      : undefined;
    const memoryProvider = new RuntimeConfiguredMemoryProvider(
      runtimeConfigurations,
      configuration.memoryDeploymentSecrets,
      deploymentMemoryProvider,
      new ModelProviderCredentialCipher(
        configuration.model.credentialEncryptionKey,
      ).memoryScopeHmacKey(),
    );
    const memoryConsumer = new MemoryIngestionConsumer(
      new PgMemoryIngestionStore(pool, blobs),
      memoryProvider,
      `${configuration.worker.workerId}-memory`,
      30_000,
      5,
      1_000,
      2_000,
    );
    const runCancellationReader = new PgRunCancellationReader(pool);
    const worker = new RunWorker(
      {
        persistence: new PgExecutionPersistence(pool, {
          threadContextWriteEnabled: configuration.threadContext.writeEnabled,
          threadInputRoutingV2Enabled: configuration.threadContext.inputRoutingEnabled,
          threadSandboxSessionReuseEnabled: configuration.threadSandbox.reuseEnabled,
          threadSandboxHandoffLeaseMs: configuration.worker.runLeaseMs,
          historyFilesystemEnabled: configuration.historyFilesystemEnabled,
          historyDirectoryTimeZone: configuration.historyDirectoryTimeZone,
          // 没有 active memory 的 Run 会被 resolver 明确完成，避免配置切换形成悬挂 outbox。
          memoryIngestionEnabled: true,
        }),
        revisions: workspaceRuntime,
        sandboxes,
        orphanSandboxes: sandboxes,
        sessions,
        personalizations: new PgPersonalizationSettingsRepository(pool),
        cancellation: new DatabaseRunCancellation(
          runCancellationReader.isCancelled.bind(runCancellationReader),
          configuration.worker.pollIntervalMs,
        ),
        shutdownSignal: shutdown.signal,
        clock: new SystemWorkerClock(),
        metrics: new PgRecoveryMetrics(pool),
        continuityMetrics: threadContinuityMetrics,
        ...(runEventDiagnostics === undefined ? {} : { runEventDiagnostics }),
        ...(startupTimingDiagnostics === undefined ? {} : { startupTimingDiagnostics }),
        ...(phaseTimingDiagnostics === undefined ? {} : { phaseTimingDiagnostics }),
        ...(configuration.threadContext.writeEnabled ? { threadContextBodies } : {}),
        ...(configuration.threadSandbox.reuseEnabled ? { threadSandboxes } : {}),
        ...(configuration.subagents.enabled
          ? { agentControl: new PgAgentControlRepository(pool) }
          : {}),
        memoryRetriever: memoryProvider,
      },
      {
        workerId: configuration.worker.workerId,
        leaseDurationMs: configuration.worker.runLeaseMs,
        heartbeatMs: Math.floor(configuration.worker.runLeaseMs / 3),
        runTimeoutMs: configuration.worker.runTimeoutMs,
        threadContextWriteEnabled: configuration.threadContext.writeEnabled,
        threadInputRoutingV2Enabled: configuration.threadContext.inputRoutingEnabled,
        threadSandboxSessionReuseEnabled: configuration.threadSandbox.reuseEnabled,
        historyFilesystemEnabled: configuration.historyFilesystemEnabled,
        subagentsEnabled: configuration.subagents.enabled,
      },
    );
    const tenantAssignments = new PgWorkerTenantAssignments({
      runtime: pool,
      coordinator: coordinatorPool,
    });
    const dispatchWakeListener = new PgWorkerDispatchWakeListener(
      coordinatorPool,
      configuration.worker.pollIntervalMs,
    );
    // 兼容固定 Tenant 部署的启动维护，同时所有新 dispatch 都会在同一事务动态唤醒其 Tenant。
    await tenantAssignments.wake(configuration.worker.tenantId);
    const loop = new AgentWorkerPollingLoop(
      tenantAssignments,
      new PgRunDispatchOutbox(pool),
      worker,
      {
        workerId: configuration.worker.workerId,
        pollIntervalMs: configuration.worker.pollIntervalMs,
        tenantAssignmentLeaseMs: configuration.worker.dispatchLeaseMs,
        dispatchLeaseMs: configuration.worker.dispatchLeaseMs,
        concurrencySettings: {
          workerMaxConcurrentRuns: configuration.worker.maxConcurrentRuns,
          userMaxConcurrentRunsPerTenant: configuration.worker.userMaxConcurrentRunsPerTenant,
        },
        resolveConcurrencySettings: () => runtimeConfigurations.resolveActiveRuntimeSettings(),
        canClaim: async () =>
          (await upstreamSandboxes.isConfigured()) &&
          ((await runtimeConfigurations.resolveActiveModelConfiguration()) !== undefined ||
            configuration.model.apiKey !== ""),
        maintenance: (tenantId) =>
          performWorkerMaintenance({
            resourceBlobBatchLimit: 16,
            recoverResourceBlobs: () =>
              resourceBlobWriter.recoverPending({
                tenantId,
                limit: 16,
                orphanGraceSeconds: 300,
              }),
            drainMemory: () => memoryConsumer.drainTenant(tenantId),
            drainTitles: () => titleConsumer.drainTenant(tenantId),
            drainScheduledTasks: () => scheduledTaskConsumer.drainTenant(tenantId),
          }),
      },
    );
    const probes = Object.freeze({
      postgres: () => probePostgres(pool, configuration.databaseRuntimeRole),
      workerCoordinatorPostgres: () =>
        probePostgres(coordinatorPool, configuration.databaseWorkerCoordinatorRole),
      objectStorage: () => probeS3BlobStore(s3Config),
      sandbox: () => upstreamSandboxes.probe(),
      model: async () => {
        const active = await runtimeConfigurations.resolveActiveModelConfiguration();
        if (active === undefined && configuration.model.apiKey === "")
          throw new Error("MODEL_CONFIGURATION_REQUIRED");
      },
    });
    // 模型与沙箱是否已配置只影响领取资格；安装期间保留进程和动态配置读取。
    await startWorkerLoopAfterDependencyProbes(
      runtimeMode,
      { ...probes, model: async () => undefined, sandbox: async () => undefined },
      () => {
        loop.start();
        dispatchWakeListener.start(() => loop.wake());
      },
    );
    return Object.freeze({
      stopAccepting: async () => {
        loop.stopAccepting();
        shutdown.request();
        await dispatchWakeListener.close();
        await loop.drain();
        await titleConsumer.close();
      },
      resources: Object.freeze([
        Object.freeze({ name: "postgres", close: () => pool.end() }),
        Object.freeze({ name: "worker-coordinator-postgres", close: () => coordinatorPool.end() }),
      ]),
      readiness: Object.freeze([
        Object.freeze({ name: "postgres", probe: probes.postgres }),
        Object.freeze({
          name: "worker-coordinator-postgres",
          probe: probes.workerCoordinatorPostgres,
        }),
        Object.freeze({ name: "object-storage", probe: probes.objectStorage }),
        Object.freeze({ name: "sandbox", probe: probes.sandbox }),
        Object.freeze({ name: "model-runtime", probe: probes.model }),
      ]),
    });
  } catch (error) {
    await Promise.all([
      pool.end().catch(() => undefined),
      coordinatorPool.end().catch(() => undefined),
    ]);
    throw error;
  }
}

function createConfiguredSandboxRouter(
  configuration: WorkerProcessConfiguration,
  resourceVolume?: TenantResourceVolumePort,
  resourceFilesystemMaterializer?: ManagedResourceFilesystemSnapshotMaterializer,
  managedResolver?: PgSandboxConfigurationResolver,
): SandboxSessionRegistryRouter {
  const registries = [];
  if (configuration.sandbox.enabledProviderKeys.includes("cube")) {
    if (!configuration.sandbox.apiUrl || !configuration.sandbox.templateId)
      throw new Error("SANDBOX_CONFIGURATION_REQUIRED");
    registries.push(
      new CubeSandboxSessionRegistry(
        {
          apiUrl: configuration.sandbox.apiUrl,
          apiKey: configuration.sandbox.apiKey ?? null,
          ...(configuration.sandbox.proxyNodeIp === undefined
            ? {}
            : { proxyNodeIp: configuration.sandbox.proxyNodeIp }),
          ...(configuration.sandbox.proxyPort === undefined
            ? {}
            : { proxyPort: configuration.sandbox.proxyPort }),
          ...(configuration.sandbox.proxyScheme === undefined
            ? {}
            : { proxyScheme: configuration.sandbox.proxyScheme }),
          defaultOperationTimeoutMs: 5_000,
        },
        configuration.sandbox.templateId,
        configuration.threadSandbox.sessionTtlSeconds,
        configuration.threadSandbox.lifecycleTimeoutMs,
        resourceVolume,
      ),
    );
  }
  if (configuration.sandbox.enabledProviderKeys.includes("e2b")) {
    const e2b = configuration.sandbox.e2b;
    if (e2b === undefined) throw new TypeError("E2B Provider 配置缺失");
    registries.push(
      new E2BSandboxSessionRegistry(
        {
          apiKey: e2b.apiKey,
          ...(e2b.domain === undefined ? {} : { domain: e2b.domain }),
        },
        e2b.templateId,
        e2b.sessionTtlSeconds,
        configuration.threadSandbox.lifecycleTimeoutMs,
        resourceFilesystemMaterializer,
      ),
    );
  }
  if (configuration.sandbox.enabledProviderKeys.includes("tencent-ags")) {
    const tencentAgs = configuration.sandbox.tencentAgs;
    if (tencentAgs === undefined) throw new TypeError("腾讯云 AGS Provider 配置缺失");
    registries.push(
      new TencentAgsSandboxSessionRegistry(
        {
          apiKey: tencentAgs.apiKey,
          domain: tencentAgs.domain,
        },
        tencentAgs.templateId,
        tencentAgs.sessionTtlSeconds,
        configuration.threadSandbox.lifecycleTimeoutMs,
        resourceFilesystemMaterializer,
      ),
    );
  }
  return new SandboxSessionRegistryRouter(
    configuration.sandbox.defaultProviderKey,
    registries,
    managedResolver === undefined
      ? undefined
      : {
          resolver: managedResolver,
          createRegistry: (profile) =>
            createManagedSandboxRegistry(
              profile,
              configuration.sandbox.resourceVolumeDriver,
              resourceFilesystemMaterializer,
            ),
        },
  );
}

/**
 * 开发预检只能读取依赖就绪状态；绝不能复用 assembler，因为后者会启动 polling loop，可能领取
 * 尚在队列中的真实 Run。这里不构造 RunWorker、Dispatch Outbox 或 Sandbox create 调用。
 */
export async function probeDevelopmentWorkerDependencies(
  configuration: WorkerProcessConfiguration,
): Promise<void> {
  if (
    configuration.runtimeEnvironment !== "development" ||
    configuration.development === undefined ||
    configuration.development.userATenantId !== configuration.worker.tenantId
  ) {
    throw new Error("DEVELOPMENT_WORKER_ASSEMBLY_FORBIDDEN");
  }
  const pool = createPostgresPool({
    connectionString: configuration.databaseUrl,
    ...(configuration.databaseSsl === undefined ? {} : { ssl: configuration.databaseSsl }),
    schema: configuration.databaseSchema,
    expectedRuntimeRole: configuration.databaseRuntimeRole,
    applicationName: "hoox-agent-worker-preflight",
  });
  const coordinatorPool = createPostgresPool({
    connectionString: configuration.databaseWorkerCoordinatorUrl,
    ...(configuration.databaseWorkerCoordinatorSsl === undefined
      ? {}
      : { ssl: configuration.databaseWorkerCoordinatorSsl }),
    schema: configuration.databaseSchema,
    expectedRuntimeRole: configuration.databaseWorkerCoordinatorRole,
    applicationName: "hoox-agent-worker-coordinator-preflight",
    maxConnections: 1,
  });
  try {
    const s3Config = {
      bucket: configuration.objectStorage.bucket,
      endpoint: configuration.objectStorage.endpoint,
      region: configuration.objectStorage.region,
      accessKeyId: configuration.objectStorage.accessKeyId,
      secretAccessKey: configuration.objectStorage.secretAccessKey,
      forcePathStyle: configuration.objectStorage.forcePathStyle,
      prefix: RUNTIME_BLOB_OBJECT_PREFIX,
      maxPresignTtlSeconds: WORKER_ARTIFACT_DOWNLOAD_TTL_SECONDS,
      // Readiness 必须使用与真实 Worker 相同的绝对读取边界，避免预检成功、装配失败。
      maxBlobSizeBytes: WORKER_MAX_BLOB_SIZE_BYTES,
    } as const;
    const sandbox = createConfiguredSandboxRouter(
      configuration,
      configuration.sandbox.apiUrl === undefined
        ? undefined
        : new CubeTenantResourceVolume({
            apiUrl: configuration.sandbox.apiUrl,
            apiKey: configuration.sandbox.apiKey ?? null,
            driver: configuration.sandbox.resourceVolumeDriver,
            requestTimeoutMs: 5_000,
          }),
      undefined,
      new PgSandboxConfigurationResolver(
        pool,
        new ModelProviderCredentialCipher(configuration.model.credentialEncryptionKey),
      ),
    );
    await Promise.all([
      probePostgres(pool, configuration.databaseRuntimeRole),
      probePostgres(coordinatorPool, configuration.databaseWorkerCoordinatorRole),
      probeS3BlobStore(s3Config),
      (async () => {
        if (await sandbox.isConfigured()) await sandbox.probeExecution();
      })(),
      (async () => {
        const configurations = new PgRuntimeControlConfigurationRepository(
          pool,
          new ModelProviderCredentialCipher(configuration.model.credentialEncryptionKey),
          configuration.model.apiKey,
        );
        const model = await resolveRuntimeModelProbeConfiguration(
          configuration.model,
          configurations,
        );
        if (model.apiKey !== "") await probeOpenAiCompatibleModel(model, "development");
      })(),
    ]);
  } finally {
    await Promise.all([
      pool.end().catch(() => undefined),
      coordinatorPool.end().catch(() => undefined),
    ]);
  }
}

export async function probeOpenAiCompatibleModel(
  model: RuntimeModelProbeConfiguration,
  _mode: "development" | "production",
): Promise<void> {
  const endpoint = new URL(
    "chat/completions",
    model.baseUrl.endsWith("/") ? model.baseUrl : `${model.baseUrl}/`,
  );
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${model.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: model.modelId,
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: Math.min(model.maxOutputTokens, 32),
      stream: false,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("模型 provider readiness 失败");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("模型 provider 响应无效");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 64 * 1024) throw new Error("模型 provider 响应超限");
      chunks.push(part.value);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { choices?: unknown[] };
    if (!Array.isArray(payload.choices) || payload.choices.length === 0)
      throw new Error("模型 provider 响应无效");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

const developmentIdentityEnvironmentKeys = Object.freeze([
  "DEV_AUTH_ENABLED",
  "DEV_AUTH_USER_A_ID",
  "DEV_AUTH_USER_A_TENANT_ID",
  "DEV_AUTH_USER_B_ID",
  "DEV_AUTH_USER_B_TENANT_ID",
] as const);

function assertProductionHasNoDevelopmentIdentity(
  source: Readonly<Record<string, string | undefined>>,
): void {
  const configured = developmentIdentityEnvironmentKeys.filter((key) => source[key] !== undefined);
  if (configured.length > 0) {
    throw new EnvironmentConfigurationError(
      configured.map((key) => ({ code: "FORBIDDEN_IN_PRODUCTION" as const, key })),
    );
  }
}

/** 凭据会随请求头发送，生产网络边界不能把模型/S3 密钥降为明文传输。 */
function assertProductionWorkerTransport(input: {
  readonly modelBaseUrl: string | undefined;
  readonly objectStorageEndpoint: string;
  readonly sandboxApiUrl: string | undefined;
}): void {
  const endpoints: Array<readonly [string, string | undefined]> = [
    ["MODEL_BASE_URL", input.modelBaseUrl],
    ["S3_ENDPOINT", input.objectStorageEndpoint],
    ["CUBESANDBOX_API_URL", input.sandboxApiUrl],
  ];
  for (const [key, value] of endpoints) {
    if (value === undefined) continue;
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      throw new TypeError(`${key} 在 production 必须为无凭据的 HTTPS URL`);
    }
  }
}

export async function startWorkerProcess(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly assembler?: ServiceAssemblyFactory<WorkerProcessConfiguration>;
  readonly signalSource?: ProcessSignalSource;
  readonly onShutdownFailure?: (error: Error) => void;
}): Promise<RunningServiceProcess> {
  const configuration = parseWorkerProcessEnvironment(input.environment);
  if (configuration.runtimeEnvironment === "production") {
    if (input.assembler !== undefined) {
      // 外部调用方无法把测试 Fake 塞进 production；真实依赖图仅由本模块私有 assembler 取得。
      throw new Error("PRODUCTION_ASSEMBLY_UNAVAILABLE:agent-worker");
    }
    return startServiceProcess({
      serviceName: "agent-worker",
      configuration,
      shutdownTimeoutMilliseconds: configuration.shutdownTimeoutMilliseconds,
      assembler: productionWorkerAssembler,
      ...(input.signalSource === undefined ? {} : { signalSource: input.signalSource }),
      ...(input.onShutdownFailure === undefined
        ? {}
        : { onShutdownFailure: input.onShutdownFailure }),
    });
  }
  const assembler =
    input.assembler ??
    (configuration.runtimeEnvironment === "development" ? developmentWorkerAssembler : undefined);
  return startServiceProcess({
    serviceName: "agent-worker",
    configuration,
    shutdownTimeoutMilliseconds: configuration.shutdownTimeoutMilliseconds,
    ...(assembler === undefined ? {} : { assembler }),
    ...(input.signalSource === undefined ? {} : { signalSource: input.signalSource }),
    ...(input.onShutdownFailure === undefined
      ? {}
      : { onShutdownFailure: input.onShutdownFailure }),
  });
}

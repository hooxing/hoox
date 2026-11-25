import { tenantId } from "@hoox/domain";
import {
  ModelProviderCredentialCipher,
  PgSandboxConfigurationResolver,
  PgRuntimeControlConfigurationRepository,
} from "@hoox/persistence/admin";
import {
  createS3BlobStore,
  parseS3ConditionalWrite,
  type S3ConditionalWrite,
  createS3StableBlobGarbageCollector,
  PgBlobLifecycleRepository,
  RUNTIME_BLOB_OBJECT_PREFIX,
} from "@hoox/persistence/blob";
import {
  PgSandboxCleanupConsumerStore,
  PgThreadSandboxLifecycleConsumerStore,
} from "@hoox/persistence/maintenance";
import {
  createPostgresPool,
  PgWebhookOutboxStore,
  probePostgres,
  WebhookSecretCipher,
} from "@hoox/persistence/postgres";
import { PgRunTrajectoryStore } from "@hoox/persistence/trajectory";
import { DurableTraceBlobPersistenceAdapter } from "@hoox/persistence/blob";
import { WebhookDispatcher } from "./webhook-dispatcher.js";
import { runRunTrajectoryRetentionPass } from "./run-trajectory-retention.js";
import { PgThreadContinuityMetrics, PgThreadTitleGenerationStore } from "@hoox/persistence/thread";
import {
  assertProductionInheritedEnvironment,
  booleanEnvironmentField,
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
import {
  CubeSandboxGateway,
  E2BSandboxGateway,
  type RuntimeSandboxGateway,
  resolveCubeProxyRouting,
  type SandboxProviderKey,
  SandboxProviderRegistry,
  TencentAgsSandboxGateway,
} from "@hoox/sandbox";
import {
  OpenAiCompatibleThreadTitleGenerator,
  ThreadTitleGenerationConsumer,
  ThreadTitleGenerationPollingLoop,
} from "@hoox/thread-title";
import { ManagedSandboxGatewayResolver } from "./managed-sandbox-gateway.js";
import {
  SandboxCleanupConsumer,
  SandboxCleanupPollingLoop,
  SandboxCleanupRouterResolver,
} from "./sandbox-cleanup-consumer.js";
import {
  ThreadSandboxLifecycleConsumer,
  ThreadSandboxLifecyclePollingLoop,
  ThreadSandboxLifecycleRouterResolver,
} from "./thread-sandbox-lifecycle-consumer.js";

const schedulerEnvironmentSchema = Object.freeze({
  DATABASE_URL: urlEnvironmentField({
    secret: true,
    protocols: ["postgres:", "postgresql:"],
    allowCredentials: true,
    maxLength: 8_192,
  }),
  DATABASE_SCHEMA: stringEnvironmentField({ maxLength: 63 }),
  DATABASE_RUNTIME_ROLE: stringEnvironmentField({ maxLength: 63 }),
  DATABASE_TRAJECTORY_DIRECTORY_URL: urlEnvironmentField({
    secret: true,
    protocols: ["postgres:", "postgresql:"],
    allowCredentials: true,
    maxLength: 8_192,
  }),
  DATABASE_TRAJECTORY_DIRECTORY_ROLE: stringEnvironmentField({ maxLength: 63 }),
  S3_ENDPOINT: urlEnvironmentField(),
  S3_BUCKET: stringEnvironmentField({ maxLength: 255 }),
  S3_REGION: stringEnvironmentField({ maxLength: 128 }),
  S3_ACCESS_KEY_ID: stringEnvironmentField({ secret: true, maxLength: 1_024 }),
  S3_SECRET_ACCESS_KEY: stringEnvironmentField({ secret: true, maxLength: 4_096 }),
  S3_FORCE_PATH_STYLE: booleanEnvironmentField(),
  S3_CONDITIONAL_WRITE: {
    ...stringEnvironmentField({ requiredIn: [] }),
    parse: parseS3ConditionalWrite,
  },
  RUN_TRAJECTORY_RETENTION_DAYS: integerEnvironmentField({
    requiredIn: [],
    minimum: 1,
    maximum: 365,
  }),
  WEBHOOK_SECRET_ENCRYPTION_KEY: stringEnvironmentField({
    secret: true,
    maxLength: 8192,
    requiredIn: ["production"],
  }),
  WEBHOOK_DISPATCHER_DATABASE_URL: urlEnvironmentField({
    secret: true,
    protocols: ["postgres:", "postgresql:"],
    allowCredentials: true,
    maxLength: 8192,
    requiredIn: ["production"],
  }),
  DATABASE_WEBHOOK_DISPATCHER_ROLE: stringEnvironmentField({
    maxLength: 63,
    requiredIn: ["production"],
  }),
  MODEL_CREDENTIAL_ENCRYPTION_KEY: stringEnvironmentField({
    secret: true,
    maxLength: 8192,
    requiredIn: [],
  }),
  SANDBOX_DEFAULT_PROVIDER: stringEnvironmentField({ maxLength: 16, requiredIn: [] }),
  SANDBOX_ENABLED_PROVIDERS: stringEnvironmentField({ maxLength: 64, requiredIn: [] }),
  E2B_API_KEY: stringEnvironmentField({ secret: true, maxLength: 8_192, requiredIn: [] }),
  E2B_DOMAIN: stringEnvironmentField({ maxLength: 255, requiredIn: [] }),
  TENCENT_AGS_API_KEY: stringEnvironmentField({ secret: true, maxLength: 8_192, requiredIn: [] }),
  TENCENT_AGS_DOMAIN: stringEnvironmentField({ maxLength: 255, requiredIn: [] }),
  CUBESANDBOX_API_URL: urlEnvironmentField({ requiredIn: [] }),
  CUBESANDBOX_API_KEY: stringEnvironmentField({ secret: true, maxLength: 8_192, requiredIn: [] }),
  CUBESANDBOX_PROXY_NODE_IP: stringEnvironmentField({ maxLength: 255, requiredIn: [] }),
  CUBESANDBOX_PROXY_PORT: integerEnvironmentField({ minimum: 1, maximum: 65_535, requiredIn: [] }),
  CUBESANDBOX_PROXY_SCHEME: stringEnvironmentField({ maxLength: 5, requiredIn: [] }),
  SCHEDULER_TENANT_ID: stringEnvironmentField({ maxLength: 200 }),
  SCHEDULER_WORKER_ID: stringEnvironmentField({ maxLength: 200 }),
  CLEANUP_POLL_INTERVAL_MS: integerEnvironmentField({ minimum: 50, maximum: 600_000 }),
  CLEANUP_LEASE_MS: integerEnvironmentField({ minimum: 210_000, maximum: 600_000 }),
  HISTORY_TITLE_GENERATION_ENABLED: booleanEnvironmentField({ requiredIn: [] }),
  HISTORY_TITLE_MODEL_BASE_URL: urlEnvironmentField({ requiredIn: [] }),
  HISTORY_TITLE_MODEL_API_KEY: stringEnvironmentField({
    secret: true,
    maxLength: 8_192,
    requiredIn: [],
  }),
  HISTORY_TITLE_MODEL_ID: stringEnvironmentField({ maxLength: 512, requiredIn: [] }),
  HISTORY_TITLE_MODEL_TIMEOUT_MS: integerEnvironmentField({
    minimum: 1_000,
    maximum: 120_000,
    requiredIn: [],
  }),
  HISTORY_TITLE_INPUT_MAX_BYTES: integerEnvironmentField({
    minimum: 256,
    maximum: 32_768,
    requiredIn: [],
  }),
  HISTORY_TITLE_MAX_OUTPUT_TOKENS: integerEnvironmentField({
    minimum: 32,
    maximum: 512,
    requiredIn: [],
  }),
  HISTORY_TITLE_MAX_ATTEMPTS: integerEnvironmentField({ minimum: 1, maximum: 10, requiredIn: [] }),
  HISTORY_TITLE_RETRY_BASE_MS: integerEnvironmentField({
    minimum: 100,
    maximum: 600_000,
    requiredIn: [],
  }),
  HISTORY_TITLE_POLL_INTERVAL_MS: integerEnvironmentField({
    minimum: 50,
    maximum: 600_000,
    requiredIn: [],
  }),
  HISTORY_TITLE_CLAIM_LEASE_MS: integerEnvironmentField({
    minimum: 5_000,
    maximum: 600_000,
    requiredIn: [],
  }),
  THREAD_SANDBOX_RETENTION_SCHEDULER_ENABLED: booleanEnvironmentField({ requiredIn: [] }),
  THREAD_SANDBOX_LIFECYCLE_TIMEOUT_MS: integerEnvironmentField({
    minimum: 1,
    maximum: 600_000,
    requiredIn: [],
  }),
  THREAD_SANDBOX_PAUSED_RETENTION_SECONDS: integerEnvironmentField({
    minimum: 1,
    maximum: 31_536_000,
    requiredIn: [],
  }),
  PROCESS_SHUTDOWN_TIMEOUT_MS: integerEnvironmentField({ minimum: 1, maximum: 600_000 }),
});

export const schedulerProcessEnvironmentKeys = Object.freeze(
  Object.keys(schedulerEnvironmentSchema),
);

export interface SchedulerProcessConfiguration {
  readonly webhookDispatch?: Readonly<{
    databaseUrl: string;
    databaseSsl?: Readonly<{ readonly rejectUnauthorized: true }>;
    role: string;
    secretKey: string;
  }>;
  readonly credentialEncryptionKey?: string;
  readonly runtimeEnvironment: RuntimeEnvironment;
  readonly databaseUrl: string;
  readonly databaseSsl?: Readonly<{ readonly rejectUnauthorized: true }>;
  readonly databaseSchema: string;
  readonly databaseRuntimeRole: string;
  readonly trajectoryDirectoryUrl: string;
  readonly trajectoryDirectoryRole: string;
  readonly trajectoryDirectorySsl?: Readonly<{ readonly rejectUnauthorized: true }>;
  readonly objectStorage: Readonly<{
    endpoint: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
    conditionalWrite?: S3ConditionalWrite;
  }>;
  readonly trajectoryRetentionDays: number;
  readonly sandbox: Readonly<{
    defaultProviderKey: SandboxProviderKey;
    enabledProviderKeys: readonly SandboxProviderKey[];
    e2b?: Readonly<{ apiKey: string; domain?: string }>;
    tencentAgs?: Readonly<{ apiKey: string; domain: string }>;
    apiUrl?: string;
    apiKey?: string;
    proxyNodeIp?: string;
    proxyPort?: number;
    proxyScheme?: "http" | "https";
  }>;
  readonly cleanup: Readonly<{
    tenantId: string;
    workerId: string;
    pollIntervalMs: number;
    leaseMs: number;
  }>;
  readonly titleGeneration?: Readonly<{
    baseUrl: string;
    apiKey: string;
    modelId: string;
    timeoutMs: number;
    inputMaximumBytes: number;
    maximumOutputTokens: number;
    maximumAttempts: number;
    retryBaseMs: number;
    pollIntervalMs: number;
    claimLeaseMs: number;
  }>;
  readonly threadSandbox: Readonly<{
    retentionSchedulerEnabled: boolean;
    lifecycleTimeoutMs: number;
    pausedRetentionSeconds: number;
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

export function selectSchedulerProcessEnvironment(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string | undefined>> {
  assertProductionInheritedEnvironment(source);
  if (source.RUNTIME_ENV === "production" && source.DATABASE_WORKER_COORDINATOR_URL) {
    throw new TypeError("Scheduler 禁止注入 Worker Coordinator 凭据");
  }
  return selectDeclaredEnvironment(source, schedulerProcessEnvironmentKeys);
}

export function parseSchedulerProcessEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): SchedulerProcessConfiguration {
  assertProductionInheritedEnvironment(source);
  const parsed = parseStrictEnvironment(source, schedulerEnvironmentSchema);
  const configuredDatabaseUrl = readRequiredEnvironmentValue(parsed, "DATABASE_URL");
  const productionDatabase =
    parsed.runtimeEnvironment === "production"
      ? parseProductionPostgresTransport(configuredDatabaseUrl)
      : undefined;
  const webhookUrl = parsed.values.WEBHOOK_DISPATCHER_DATABASE_URL;
  const webhookRole = parsed.values.DATABASE_WEBHOOK_DISPATCHER_ROLE;
  const webhookKey = parsed.values.WEBHOOK_SECRET_ENCRYPTION_KEY;
  if (
    [webhookUrl, webhookRole, webhookKey].some((value) => value !== undefined) &&
    [webhookUrl, webhookRole, webhookKey].some((value) => value === undefined)
  )
    throw new TypeError("Webhook Dispatcher 数据库角色、连接与加密根必须同时配置");
  if (webhookUrl !== undefined && webhookRole !== undefined) {
    const parsedWebhookUrl = new URL(webhookUrl);
    if (decodeURIComponent(parsedWebhookUrl.username) !== webhookRole)
      throw new TypeError("Webhook Dispatcher 连接用户名必须与数据库角色一致");
  }
  if (webhookKey !== undefined && Buffer.byteLength(webhookKey, "utf8") < 32)
    throw new TypeError("WEBHOOK_SECRET_ENCRYPTION_KEY 至少需要 32 字节");
  const webhookDatabase =
    webhookUrl === undefined
      ? undefined
      : parsed.runtimeEnvironment === "production"
        ? parseProductionPostgresTransport(webhookUrl)
        : undefined;
  const configuredTenantId = readRequiredEnvironmentValue(parsed, "SCHEDULER_TENANT_ID");
  // Scheduler 仅接受领域 Tenant ID；避免把任意数据库文本带入 RLS 上下文。
  tenantId(configuredTenantId);
  const configuredWorkerId = readRequiredEnvironmentValue(parsed, "SCHEDULER_WORKER_ID");
  if (Buffer.byteLength(configuredWorkerId, "utf8") > 200) {
    throw new TypeError("SCHEDULER_WORKER_ID UTF-8 字节长度不能超过 200");
  }
  const configuredRuntimeRole = readRequiredEnvironmentValue(parsed, "DATABASE_RUNTIME_ROLE");
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(configuredRuntimeRole)) {
    throw new TypeError("DATABASE_RUNTIME_ROLE 格式无效");
  }
  const trajectoryDirectoryRole = readRequiredEnvironmentValue(
    parsed,
    "DATABASE_TRAJECTORY_DIRECTORY_ROLE",
  );
  const trajectoryDirectoryUrl = readRequiredEnvironmentValue(
    parsed,
    "DATABASE_TRAJECTORY_DIRECTORY_URL",
  );
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(trajectoryDirectoryRole)) {
    throw new TypeError("DATABASE_TRAJECTORY_DIRECTORY_ROLE 格式无效");
  }
  if (
    trajectoryDirectoryRole === configuredRuntimeRole ||
    trajectoryDirectoryRole === webhookRole
  ) {
    throw new TypeError("轨迹目录角色必须与 Runtime、Webhook Dispatcher 角色不同");
  }
  if (decodeURIComponent(new URL(trajectoryDirectoryUrl).username) !== trajectoryDirectoryRole) {
    throw new TypeError("轨迹目录连接用户名必须与数据库角色一致");
  }
  const productionDirectoryDatabase =
    parsed.runtimeEnvironment === "production"
      ? parseProductionPostgresTransport(trajectoryDirectoryUrl)
      : undefined;
  const s3Endpoint = readRequiredEnvironmentValue(parsed, "S3_ENDPOINT");
  if (parsed.runtimeEnvironment === "production") {
    assertProductionHttpsEndpoint(s3Endpoint, "S3_ENDPOINT");
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
        ...(parsed.values.E2B_DOMAIN === undefined ? {} : { domain: parsed.values.E2B_DOMAIN }),
      })
    : undefined;
  const tencentAgs = enabledProviderKeys.includes("tencent-ags")
    ? Object.freeze({
        apiKey: requireOptionalEnvironment(
          parsed.values.TENCENT_AGS_API_KEY,
          "TENCENT_AGS_API_KEY",
        ),
        domain: requireOptionalEnvironment(parsed.values.TENCENT_AGS_DOMAIN, "TENCENT_AGS_DOMAIN"),
      })
    : undefined;
  const configuredProxyScheme = parsed.values.CUBESANDBOX_PROXY_SCHEME;
  if (
    configuredProxyScheme !== undefined &&
    configuredProxyScheme !== "http" &&
    configuredProxyScheme !== "https"
  ) {
    throw new TypeError("CUBESANDBOX_PROXY_SCHEME 只能是 http 或 https");
  }
  const sandboxApiUrl = parsed.values.CUBESANDBOX_API_URL;
  if (enabledProviderKeys.includes("cube"))
    readRequiredEnvironmentValue(parsed, "CUBESANDBOX_API_URL");
  if (parsed.runtimeEnvironment === "production" && sandboxApiUrl !== undefined) {
    assertProductionHttpsEndpoint(sandboxApiUrl, "CUBESANDBOX_API_URL");
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
          ...(configuredProxyScheme === undefined ? {} : { proxyScheme: configuredProxyScheme }),
        });
  if (
    parsed.runtimeEnvironment === "production" &&
    sandboxApiUrl !== undefined &&
    proxyRouting.proxyScheme !== "https"
  ) {
    throw new TypeError("CUBESANDBOX_PROXY_SCHEME 在 production 必须为 https");
  }
  const titleGenerationEnabled = parsed.values.HISTORY_TITLE_GENERATION_ENABLED ?? false;
  let titleGeneration: SchedulerProcessConfiguration["titleGeneration"];
  const titleModelFields = [
    parsed.values.HISTORY_TITLE_MODEL_BASE_URL,
    parsed.values.HISTORY_TITLE_MODEL_API_KEY,
    parsed.values.HISTORY_TITLE_MODEL_ID,
  ];
  if (titleGenerationEnabled && titleModelFields.some((value) => value !== undefined)) {
    const baseUrl = readRequiredEnvironmentValue(parsed, "HISTORY_TITLE_MODEL_BASE_URL");
    if (parsed.runtimeEnvironment === "production") {
      assertProductionHttpsEndpoint(baseUrl, "HISTORY_TITLE_MODEL_BASE_URL");
    }
    const timeoutMs = parsed.values.HISTORY_TITLE_MODEL_TIMEOUT_MS ?? 20_000;
    const claimLeaseMs = parsed.values.HISTORY_TITLE_CLAIM_LEASE_MS ?? 60_000;
    if (claimLeaseMs < timeoutMs + 5_000) {
      throw new TypeError("HISTORY_TITLE_CLAIM_LEASE_MS 必须覆盖模型超时与状态写回余量");
    }
    titleGeneration = Object.freeze({
      baseUrl,
      apiKey: readRequiredEnvironmentValue(parsed, "HISTORY_TITLE_MODEL_API_KEY"),
      modelId: readRequiredEnvironmentValue(parsed, "HISTORY_TITLE_MODEL_ID"),
      timeoutMs,
      inputMaximumBytes: parsed.values.HISTORY_TITLE_INPUT_MAX_BYTES ?? 4_096,
      maximumOutputTokens: parsed.values.HISTORY_TITLE_MAX_OUTPUT_TOKENS ?? 128,
      maximumAttempts: parsed.values.HISTORY_TITLE_MAX_ATTEMPTS ?? 3,
      retryBaseMs: parsed.values.HISTORY_TITLE_RETRY_BASE_MS ?? 5_000,
      pollIntervalMs: parsed.values.HISTORY_TITLE_POLL_INTERVAL_MS ?? 1_000,
      claimLeaseMs,
    });
  }
  return Object.freeze({
    runtimeEnvironment: parsed.runtimeEnvironment,
    ...(webhookUrl === undefined || webhookRole === undefined || webhookKey === undefined
      ? {}
      : {
          webhookDispatch: Object.freeze({
            databaseUrl: webhookDatabase?.connectionString ?? webhookUrl,
            ...(webhookDatabase === undefined ? {} : { databaseSsl: webhookDatabase.ssl }),
            role: webhookRole,
            secretKey: webhookKey,
          }),
        }),
    ...(parsed.values.MODEL_CREDENTIAL_ENCRYPTION_KEY === undefined
      ? {}
      : { credentialEncryptionKey: parsed.values.MODEL_CREDENTIAL_ENCRYPTION_KEY }),
    databaseUrl: productionDatabase?.connectionString ?? configuredDatabaseUrl,
    ...(productionDatabase === undefined ? {} : { databaseSsl: productionDatabase.ssl }),
    databaseSchema: readRequiredEnvironmentValue(parsed, "DATABASE_SCHEMA"),
    databaseRuntimeRole: configuredRuntimeRole,
    trajectoryDirectoryUrl: productionDirectoryDatabase?.connectionString ?? trajectoryDirectoryUrl,
    trajectoryDirectoryRole,
    ...(productionDirectoryDatabase === undefined
      ? {}
      : { trajectoryDirectorySsl: productionDirectoryDatabase.ssl }),
    objectStorage: Object.freeze({
      endpoint: s3Endpoint,
      bucket: readRequiredEnvironmentValue(parsed, "S3_BUCKET"),
      region: readRequiredEnvironmentValue(parsed, "S3_REGION"),
      accessKeyId: readRequiredEnvironmentValue(parsed, "S3_ACCESS_KEY_ID"),
      secretAccessKey: readRequiredEnvironmentValue(parsed, "S3_SECRET_ACCESS_KEY"),
      forcePathStyle: readRequiredEnvironmentValue(parsed, "S3_FORCE_PATH_STYLE"),
      ...(parsed.values.S3_CONDITIONAL_WRITE === undefined
        ? {}
        : { conditionalWrite: parsed.values.S3_CONDITIONAL_WRITE }),
    }),
    trajectoryRetentionDays: parsed.values.RUN_TRAJECTORY_RETENTION_DAYS ?? 30,
    sandbox: Object.freeze({
      defaultProviderKey,
      enabledProviderKeys,
      ...(e2b === undefined ? {} : { e2b }),
      ...(tencentAgs === undefined ? {} : { tencentAgs }),
      ...(sandboxApiUrl === undefined ? {} : { apiUrl: sandboxApiUrl }),
      ...(parsed.values.CUBESANDBOX_API_KEY === undefined
        ? {}
        : { apiKey: parsed.values.CUBESANDBOX_API_KEY }),
      ...proxyRouting,
    }),
    cleanup: Object.freeze({
      tenantId: configuredTenantId,
      workerId: configuredWorkerId,
      pollIntervalMs: readRequiredEnvironmentValue(parsed, "CLEANUP_POLL_INTERVAL_MS"),
      leaseMs: readRequiredEnvironmentValue(parsed, "CLEANUP_LEASE_MS"),
    }),
    ...(titleGeneration === undefined ? {} : { titleGeneration }),
    threadSandbox: Object.freeze({
      retentionSchedulerEnabled: parsed.values.THREAD_SANDBOX_RETENTION_SCHEDULER_ENABLED ?? true,
      lifecycleTimeoutMs: parsed.values.THREAD_SANDBOX_LIFECYCLE_TIMEOUT_MS ?? 90_000,
      pausedRetentionSeconds: parsed.values.THREAD_SANDBOX_PAUSED_RETENTION_SECONDS ?? 86_400,
    }),
    shutdownTimeoutMilliseconds: readRequiredEnvironmentValue(
      parsed,
      "PROCESS_SHUTDOWN_TIMEOUT_MS",
    ),
  });
}

function assertProductionHttpsEndpoint(value: string, key: string): void {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "") {
    throw new TypeError(`${key} 在 production 必须为无凭据的 HTTPS URL`);
  }
}

/** 生产装配显式创建真实依赖；不会降级到内存 Fake 或跨租户扫描。 */
/** 不导出：生产依赖组合只能由本模块的 startSchedulerProcess 调用，外部无法替换或复用。 */
const productionSchedulerAssembler: ServiceAssemblyFactory<SchedulerProcessConfiguration> = {
  async assemble(configuration) {
    if (
      configuration.runtimeEnvironment === "production" &&
      (configuration.databaseSsl === undefined ||
        configuration.trajectoryDirectorySsl === undefined)
    ) {
      throw new Error("PRODUCTION_SCHEDULER_ASSEMBLY_FORBIDDEN");
    }
    const pool = createPostgresPool({
      connectionString: configuration.databaseUrl,
      ...(configuration.databaseSsl === undefined ? {} : { ssl: configuration.databaseSsl }),
      schema: configuration.databaseSchema,
      expectedRuntimeRole: configuration.databaseRuntimeRole,
      applicationName: "hoox-scheduler-cleanup",
    });
    const directoryPool = createPostgresPool({
      connectionString: configuration.trajectoryDirectoryUrl,
      ...(configuration.trajectoryDirectorySsl === undefined
        ? {}
        : { ssl: configuration.trajectoryDirectorySsl }),
      schema: configuration.databaseSchema,
      expectedRuntimeRole: configuration.trajectoryDirectoryRole,
      applicationName: "hoox-scheduler-trajectory-retention-directory",
      maxConnections: 2,
    });
    const webhookPool =
      configuration.webhookDispatch === undefined
        ? undefined
        : createPostgresPool({
            connectionString: configuration.webhookDispatch.databaseUrl,
            ...(configuration.webhookDispatch.databaseSsl === undefined
              ? {}
              : { ssl: configuration.webhookDispatch.databaseSsl }),
            schema: configuration.databaseSchema,
            expectedRuntimeRole: configuration.webhookDispatch.role,
            applicationName: "hoox-scheduler-webhook-dispatcher",
          });
    let webhookTimer: ReturnType<typeof setInterval> | undefined;
    let trajectoryTimer: ReturnType<typeof setInterval> | undefined;
    let trajectoryCleanupInFlight: Promise<number> | undefined;
    let webhookDispatcher: WebhookDispatcher | undefined;
    try {
      await probePostgres(directoryPool, configuration.trajectoryDirectoryRole);
      const blobRepository = new PgBlobLifecycleRepository(pool, {
        objectPrefix: RUNTIME_BLOB_OBJECT_PREFIX,
      });
      const s3Config = {
        ...configuration.objectStorage,
        prefix: RUNTIME_BLOB_OBJECT_PREFIX,
        maxPresignTtlSeconds: 600,
        maxBlobSizeBytes: 32 * 1024 * 1024,
      } as const;
      const blobs = createS3BlobStore(s3Config, blobRepository);
      const gc = createS3StableBlobGarbageCollector(s3Config, blobRepository);
      const trajectoryStore = new PgRunTrajectoryStore(
        pool,
        blobs,
        undefined,
        configuration.trajectoryRetentionDays,
        gc,
        new DurableTraceBlobPersistenceAdapter(blobRepository, blobs),
      );
      const runTrajectoryCleanup = async () => {
        if (trajectoryCleanupInFlight !== undefined) return trajectoryCleanupInFlight;
        trajectoryCleanupInFlight = runRunTrajectoryRetentionPass(
          directoryPool,
          trajectoryStore,
          () => console.error("运行轨迹保留清理失败"),
        ).finally(() => {
          trajectoryCleanupInFlight = undefined;
        });
        return trajectoryCleanupInFlight;
      };
      if (webhookPool !== undefined && configuration.webhookDispatch !== undefined) {
        await probePostgres(webhookPool, configuration.webhookDispatch.role);
        const dispatcher = new WebhookDispatcher({
          store: new PgWebhookOutboxStore(webhookPool),
          cipher: new WebhookSecretCipher(configuration.webhookDispatch.secretKey),
          owner: configuration.cleanup.workerId,
        });
        webhookDispatcher = dispatcher;
      }
      // 角色身份和 RLS 绕过属性必须在 cleanup loop 产生任何远端副作用前证明安全。
      await probePostgres(pool, configuration.databaseRuntimeRole);
      const gateways: RuntimeSandboxGateway[] = [];
      if (configuration.sandbox.enabledProviderKeys.includes("cube")) {
        if (!configuration.sandbox.apiUrl) throw new Error("SANDBOX_CONFIGURATION_REQUIRED");
        gateways.push(
          new CubeSandboxGateway({
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
            defaultOperationTimeoutMs: configuration.threadSandbox.lifecycleTimeoutMs,
          }),
        );
      }
      if (configuration.sandbox.enabledProviderKeys.includes("e2b")) {
        const e2b = configuration.sandbox.e2b;
        if (e2b === undefined) throw new TypeError("E2B Provider 配置缺失");
        gateways.push(
          new E2BSandboxGateway({
            apiKey: e2b.apiKey,
            ...(e2b.domain === undefined ? {} : { domain: e2b.domain }),
            defaultOperationTimeoutMs: configuration.threadSandbox.lifecycleTimeoutMs,
          }),
        );
      }
      if (configuration.sandbox.enabledProviderKeys.includes("tencent-ags")) {
        const tencentAgs = configuration.sandbox.tencentAgs;
        if (tencentAgs === undefined) throw new TypeError("腾讯云 AGS Provider 配置缺失");
        gateways.push(
          new TencentAgsSandboxGateway({
            apiKey: tencentAgs.apiKey,
            domain: tencentAgs.domain,
            defaultOperationTimeoutMs: configuration.threadSandbox.lifecycleTimeoutMs,
          }),
        );
      }
      const providers = new SandboxProviderRegistry(
        configuration.sandbox.defaultProviderKey,
        gateways,
      );
      const managed = new ManagedSandboxGatewayResolver(
        new PgSandboxConfigurationResolver(
          pool,
          configuration.credentialEncryptionKey === undefined
            ? undefined
            : new ModelProviderCredentialCipher(configuration.credentialEncryptionKey),
        ),
        providers,
        configuration.threadSandbox.lifecycleTimeoutMs,
      );
      if (await managed.isConfigured()) await managed.probe();
      void runTrajectoryCleanup().catch(() => console.error("运行轨迹保留清理协调失败"));
      trajectoryTimer = setInterval(
        () => {
          void runTrajectoryCleanup().catch(() => console.error("运行轨迹保留清理协调失败"));
        },
        24 * 60 * 60 * 1000,
      );
      trajectoryTimer.unref?.();
      if (webhookDispatcher !== undefined) {
        // 定时补满空闲槽位；单次投递受绝对截止时间约束，慢接收端只占用自己的槽位。
        webhookTimer = setInterval(() => {
          void webhookDispatcher?.pump();
        }, 500);
      }
      const consumer = new SandboxCleanupConsumer(
        new PgSandboxCleanupConsumerStore(pool),
        new SandboxCleanupRouterResolver(
          providers,
          configuration.threadSandbox.lifecycleTimeoutMs,
          managed,
        ),
        configuration.cleanup.workerId,
        configuration.cleanup.leaseMs,
      );
      const loop = new SandboxCleanupPollingLoop(
        consumer,
        configuration.cleanup.tenantId,
        configuration.cleanup.pollIntervalMs,
      );
      const threadSandboxLoop = new ThreadSandboxLifecyclePollingLoop(
        new ThreadSandboxLifecycleConsumer(
          new PgThreadSandboxLifecycleConsumerStore(
            pool,
            configuration.threadSandbox.pausedRetentionSeconds,
            configuration.threadSandbox.retentionSchedulerEnabled,
          ),
          new ThreadSandboxLifecycleRouterResolver(
            providers,
            configuration.threadSandbox.lifecycleTimeoutMs,
            managed,
          ),
          configuration.cleanup.workerId,
          configuration.cleanup.leaseMs,
          new PgThreadContinuityMetrics(pool),
        ),
        configuration.cleanup.tenantId,
        configuration.cleanup.pollIntervalMs,
      );
      const titleConfigurations =
        configuration.credentialEncryptionKey === undefined
          ? undefined
          : new PgRuntimeControlConfigurationRepository(
              pool,
              new ModelProviderCredentialCipher(configuration.credentialEncryptionKey),
            );
      const deploymentTitleGenerator =
        configuration.titleGeneration === undefined
          ? undefined
          : new OpenAiCompatibleThreadTitleGenerator(configuration.titleGeneration);
      const titleGenerationLoop = new ThreadTitleGenerationPollingLoop(
        new ThreadTitleGenerationConsumer(
          new PgThreadTitleGenerationStore(pool),
          deploymentTitleGenerator,
          `${configuration.cleanup.workerId}-titles`,
          Math.max(configuration.titleGeneration?.claimLeaseMs ?? 60_000, 25_000),
          configuration.titleGeneration?.maximumAttempts ?? 3,
          configuration.titleGeneration?.retryBaseMs ?? 5_000,
          async () => {
            const model = await titleConfigurations?.resolveTitleModelConfiguration();
            if (model === null) return null;
            if (model === undefined) return deploymentTitleGenerator;
            return new OpenAiCompatibleThreadTitleGenerator(model);
          },
        ),
        configuration.cleanup.tenantId,
        configuration.titleGeneration?.pollIntervalMs ?? 1_000,
      );
      loop.start();
      titleGenerationLoop?.start();
      threadSandboxLoop.start();
      const assembly = Object.freeze({
        stopAccepting: async () => {
          if (webhookTimer !== undefined) clearInterval(webhookTimer);
          if (trajectoryTimer !== undefined) clearInterval(trajectoryTimer);
          await webhookDispatcher?.close();
          await Promise.all([
            loop.close(),
            threadSandboxLoop.close(),
            titleGenerationLoop?.close(),
            trajectoryCleanupInFlight,
          ]);
        },
        // loop 必须先停止并等待在途远端调用，再关闭连接池。
        resources: Object.freeze([
          Object.freeze({ name: "postgres", close: () => pool.end() }),
          Object.freeze({
            name: "trajectory-directory-postgres",
            close: () => directoryPool.end(),
          }),
          ...(webhookPool === undefined
            ? []
            : [
                Object.freeze({
                  name: "webhook-dispatcher-postgres",
                  close: () => webhookPool.end(),
                }),
              ]),
        ]),
        readiness: Object.freeze([
          Object.freeze({
            name: "postgres",
            probe: () => probePostgres(pool, configuration.databaseRuntimeRole),
          }),
          Object.freeze({
            name: "trajectory-directory-postgres",
            probe: () => probePostgres(directoryPool, configuration.trajectoryDirectoryRole),
          }),
          ...(webhookPool === undefined
            ? []
            : [
                Object.freeze({
                  name: "webhook-dispatcher-postgres",
                  probe: () => probePostgres(webhookPool, configuration.webhookDispatch?.role),
                }),
              ]),
          Object.freeze({ name: "sandbox-providers", probe: () => managed.probe() }),
        ]),
      });
      return assembly;
    } catch (error) {
      if (webhookTimer !== undefined) clearInterval(webhookTimer);
      if (trajectoryTimer !== undefined) clearInterval(trajectoryTimer);
      await webhookDispatcher?.close();
      await pool.end().catch(() => undefined);
      await directoryPool.end().catch(() => undefined);
      await webhookPool?.end().catch(() => undefined);
      throw error;
    }
  },
};

export async function startSchedulerProcess(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly assembler?: ServiceAssemblyFactory<SchedulerProcessConfiguration>;
  readonly signalSource?: ProcessSignalSource;
  readonly onShutdownFailure?: (error: Error) => void;
}): Promise<RunningServiceProcess> {
  const configuration = parseSchedulerProcessEnvironment(input.environment);
  if (configuration.runtimeEnvironment === "production" && input.assembler !== undefined) {
    // 生产装配不接受注入；测试 Fake 只能在 development/test 使用。
    throw new Error("PRODUCTION_ASSEMBLY_UNAVAILABLE:scheduler");
  }
  const sharedInput = {
    configuration,
    shutdownTimeoutMilliseconds: configuration.shutdownTimeoutMilliseconds,
    ...(input.signalSource === undefined ? {} : { signalSource: input.signalSource }),
    ...(input.onShutdownFailure === undefined
      ? {}
      : { onShutdownFailure: input.onShutdownFailure }),
  } as const;
  return startServiceProcess({
    serviceName: "scheduler",
    ...sharedInput,
    assembler:
      configuration.runtimeEnvironment === "production"
        ? productionSchedulerAssembler
        : (input.assembler ?? productionSchedulerAssembler),
  });
}

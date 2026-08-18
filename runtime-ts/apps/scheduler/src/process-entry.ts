import { tenantId } from "@hoox/domain";
import {
  createPostgresPool,
  PgSandboxCleanupConsumerStore,
  PgThreadTitleGenerationStore,
  PgThreadContinuityMetrics,
  PgThreadSandboxLifecycleConsumerStore,
  probePostgres,
} from "@hoox/persistence";
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
  OpenAiCompatibleThreadTitleGenerator,
  ThreadTitleGenerationConsumer,
  ThreadTitleGenerationPollingLoop,
} from "@hoox/thread-title";
import {
  CubeSandboxGateway,
  E2BSandboxGateway,
  type RuntimeSandboxGateway,
  type SandboxProviderKey,
  SandboxProviderRegistry,
  resolveCubeProxyRouting,
} from "@hoox/sandbox";
import {
  SandboxCleanupConsumer,
  SandboxCleanupRouterResolver,
  SandboxCleanupPollingLoop,
} from "./sandbox-cleanup-consumer.js";
import {
  ThreadSandboxLifecycleConsumer,
  ThreadSandboxLifecycleRouterResolver,
  ThreadSandboxLifecyclePollingLoop,
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
  SANDBOX_DEFAULT_PROVIDER: stringEnvironmentField({ maxLength: 16, requiredIn: [] }),
  SANDBOX_ENABLED_PROVIDERS: stringEnvironmentField({ maxLength: 64, requiredIn: [] }),
  E2B_API_KEY: stringEnvironmentField({ secret: true, maxLength: 8_192, requiredIn: [] }),
  E2B_DOMAIN: stringEnvironmentField({ maxLength: 255, requiredIn: [] }),
  CUBESANDBOX_API_URL: urlEnvironmentField(),
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
  readonly runtimeEnvironment: RuntimeEnvironment;
  readonly databaseUrl: string;
  readonly databaseSsl?: Readonly<{ readonly rejectUnauthorized: true }>;
  readonly databaseSchema: string;
  readonly databaseRuntimeRole: string;
  readonly sandbox: Readonly<{
    defaultProviderKey: SandboxProviderKey;
    enabledProviderKeys: readonly SandboxProviderKey[];
    e2b?: Readonly<{ apiKey: string; domain?: string }>;
    apiUrl: string;
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
  if (value === "cube" || value === "e2b") return value;
  throw new TypeError("SANDBOX_DEFAULT_PROVIDER 只能是 cube 或 e2b");
}

function parseEnabledSandboxProviders(value: string): readonly SandboxProviderKey[] {
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
  const defaultProviderKey = parseSandboxProviderKey(
    parsed.values.SANDBOX_DEFAULT_PROVIDER ?? "cube",
  );
  const enabledProviderKeys = parseEnabledSandboxProviders(
    parsed.values.SANDBOX_ENABLED_PROVIDERS ?? "cube",
  );
  if (!enabledProviderKeys.includes(defaultProviderKey)) {
    throw new TypeError("SANDBOX_DEFAULT_PROVIDER 必须包含在 SANDBOX_ENABLED_PROVIDERS 中");
  }
  const e2b = enabledProviderKeys.includes("e2b")
    ? Object.freeze({
        apiKey: requireOptionalEnvironment(parsed.values.E2B_API_KEY, "E2B_API_KEY"),
        ...(parsed.values.E2B_DOMAIN === undefined ? {} : { domain: parsed.values.E2B_DOMAIN }),
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
  const sandboxApiUrl = readRequiredEnvironmentValue(parsed, "CUBESANDBOX_API_URL");
  if (parsed.runtimeEnvironment === "production") {
    assertProductionHttpsEndpoint(sandboxApiUrl, "CUBESANDBOX_API_URL");
  }
  const proxyRouting = resolveCubeProxyRouting({
    apiUrl: sandboxApiUrl,
    ...(parsed.values.CUBESANDBOX_PROXY_NODE_IP === undefined
      ? {}
      : { proxyNodeIp: parsed.values.CUBESANDBOX_PROXY_NODE_IP }),
    ...(parsed.values.CUBESANDBOX_PROXY_PORT === undefined
      ? {}
      : { proxyPort: parsed.values.CUBESANDBOX_PROXY_PORT }),
    ...(configuredProxyScheme === undefined ? {} : { proxyScheme: configuredProxyScheme }),
  });
  if (parsed.runtimeEnvironment === "production" && proxyRouting.proxyScheme !== "https") {
    throw new TypeError("CUBESANDBOX_PROXY_SCHEME 在 production 必须为 https");
  }
  const titleGenerationEnabled = parsed.values.HISTORY_TITLE_GENERATION_ENABLED ?? false;
  let titleGeneration: SchedulerProcessConfiguration["titleGeneration"];
  if (titleGenerationEnabled) {
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
    databaseUrl: productionDatabase?.connectionString ?? configuredDatabaseUrl,
    ...(productionDatabase === undefined ? {} : { databaseSsl: productionDatabase.ssl }),
    databaseSchema: readRequiredEnvironmentValue(parsed, "DATABASE_SCHEMA"),
    databaseRuntimeRole: configuredRuntimeRole,
    sandbox: Object.freeze({
      defaultProviderKey,
      enabledProviderKeys,
      ...(e2b === undefined ? {} : { e2b }),
      apiUrl: sandboxApiUrl,
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
      configuration.databaseSsl === undefined
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
    try {
      // 角色身份和 RLS 绕过属性必须在 cleanup loop 产生任何远端副作用前证明安全。
      await probePostgres(pool, configuration.databaseRuntimeRole);
      const gateways: RuntimeSandboxGateway[] = [];
      if (configuration.sandbox.enabledProviderKeys.includes("cube")) {
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
      const providers = new SandboxProviderRegistry(
        configuration.sandbox.defaultProviderKey,
        gateways,
      );
      await providers.probe();
      const consumer = new SandboxCleanupConsumer(
        new PgSandboxCleanupConsumerStore(pool),
        new SandboxCleanupRouterResolver(providers),
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
          ),
          configuration.cleanup.workerId,
          configuration.cleanup.leaseMs,
          new PgThreadContinuityMetrics(pool),
        ),
        configuration.cleanup.tenantId,
        configuration.cleanup.pollIntervalMs,
      );
      const titleGenerationLoop =
        configuration.titleGeneration === undefined
          ? undefined
          : new ThreadTitleGenerationPollingLoop(
              new ThreadTitleGenerationConsumer(
                new PgThreadTitleGenerationStore(pool),
                new OpenAiCompatibleThreadTitleGenerator({
                  baseUrl: configuration.titleGeneration.baseUrl,
                  apiKey: configuration.titleGeneration.apiKey,
                  modelId: configuration.titleGeneration.modelId,
                  timeoutMs: configuration.titleGeneration.timeoutMs,
                  inputMaximumBytes: configuration.titleGeneration.inputMaximumBytes,
                  maximumOutputTokens: configuration.titleGeneration.maximumOutputTokens,
                }),
                configuration.cleanup.workerId,
                configuration.titleGeneration.claimLeaseMs,
                configuration.titleGeneration.maximumAttempts,
                configuration.titleGeneration.retryBaseMs,
              ),
              configuration.cleanup.tenantId,
              configuration.titleGeneration.pollIntervalMs,
            );
      loop.start();
      titleGenerationLoop?.start();
      threadSandboxLoop.start();
      const assembly = Object.freeze({
        stopAccepting: async () => {
          await Promise.all([
            loop.close(),
            threadSandboxLoop.close(),
            titleGenerationLoop?.close(),
          ]);
        },
        // loop 必须先停止并等待在途远端调用，再关闭连接池。
        resources: Object.freeze([Object.freeze({ name: "postgres", close: () => pool.end() })]),
        readiness: Object.freeze([
          Object.freeze({
            name: "postgres",
            probe: () => probePostgres(pool, configuration.databaseRuntimeRole),
          }),
          Object.freeze({ name: "sandbox-providers", probe: () => providers.probe() }),
        ]),
      });
      return assembly;
    } catch (error) {
      await pool.end().catch(() => undefined);
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

import { tenantId } from "@cube-runtime/domain";
import {
  createPostgresPool,
  PgSandboxCleanupConsumerStore,
  probePostgres,
} from "@cube-runtime/persistence";
import {
  booleanEnvironmentField,
  createAuditedProductionAssembly,
  integerEnvironmentField,
  type ProcessSignalSource,
  parseStrictEnvironment,
  type RunningServiceProcess,
  type RuntimeEnvironment,
  readRequiredEnvironmentValue,
  type ServiceAssemblyFactory,
  selectDeclaredEnvironment,
  startServiceProcess,
  stringEnvironmentField,
  urlEnvironmentField,
} from "@cube-runtime/process-runtime";
import { CubeSandboxGateway, resolveCubeProxyRouting } from "@cube-runtime/sandbox";
import {
  CubeSandboxCleanupResolver,
  SandboxCleanupConsumer,
  SandboxCleanupPollingLoop,
} from "./sandbox-cleanup-consumer.js";

const schedulerEnvironmentSchema = Object.freeze({
  DATABASE_URL: urlEnvironmentField({
    secret: true,
    protocols: ["postgres:", "postgresql:"],
    allowCredentials: true,
    maxLength: 8_192,
  }),
  DATABASE_SCHEMA: stringEnvironmentField({ maxLength: 63 }),
  S3_ENDPOINT: urlEnvironmentField(),
  S3_BUCKET: stringEnvironmentField({ maxLength: 255 }),
  S3_REGION: stringEnvironmentField({ maxLength: 128 }),
  S3_ACCESS_KEY_ID: stringEnvironmentField({ secret: true, maxLength: 1_024 }),
  S3_SECRET_ACCESS_KEY: stringEnvironmentField({ secret: true, maxLength: 4_096 }),
  S3_FORCE_PATH_STYLE: booleanEnvironmentField(),
  CUBESANDBOX_API_URL: urlEnvironmentField(),
  CUBESANDBOX_API_KEY: stringEnvironmentField({ secret: true, maxLength: 8_192, requiredIn: [] }),
  CUBESANDBOX_PROXY_NODE_IP: stringEnvironmentField({ maxLength: 255, requiredIn: [] }),
  CUBESANDBOX_PROXY_PORT: integerEnvironmentField({ minimum: 1, maximum: 65_535, requiredIn: [] }),
  CUBESANDBOX_PROXY_SCHEME: stringEnvironmentField({ maxLength: 5, requiredIn: [] }),
  SCHEDULER_TENANT_ID: stringEnvironmentField({ maxLength: 200 }),
  SCHEDULER_WORKER_ID: stringEnvironmentField({ maxLength: 200 }),
  CLEANUP_POLL_INTERVAL_MS: integerEnvironmentField({ minimum: 50, maximum: 600_000 }),
  CLEANUP_LEASE_MS: integerEnvironmentField({ minimum: 210_000, maximum: 600_000 }),
  PROCESS_SHUTDOWN_TIMEOUT_MS: integerEnvironmentField({ minimum: 1, maximum: 600_000 }),
});

export const schedulerProcessEnvironmentKeys = Object.freeze(
  Object.keys(schedulerEnvironmentSchema),
);

export interface SchedulerProcessConfiguration {
  readonly runtimeEnvironment: RuntimeEnvironment;
  readonly databaseUrl: string;
  readonly databaseSchema: string;
  readonly objectStorage: Readonly<{
    endpoint: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  }>;
  readonly sandbox: Readonly<{
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
  readonly shutdownTimeoutMilliseconds: number;
}

export function selectSchedulerProcessEnvironment(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string | undefined>> {
  return selectDeclaredEnvironment(source, schedulerProcessEnvironmentKeys);
}

export function parseSchedulerProcessEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): SchedulerProcessConfiguration {
  const parsed = parseStrictEnvironment(source, schedulerEnvironmentSchema);
  const configuredTenantId = readRequiredEnvironmentValue(parsed, "SCHEDULER_TENANT_ID");
  // Scheduler 仅接受领域 Tenant ID；避免把任意数据库文本带入 RLS 上下文。
  tenantId(configuredTenantId);
  const configuredWorkerId = readRequiredEnvironmentValue(parsed, "SCHEDULER_WORKER_ID");
  if (Buffer.byteLength(configuredWorkerId, "utf8") > 200) {
    throw new TypeError("SCHEDULER_WORKER_ID UTF-8 字节长度不能超过 200");
  }
  const configuredProxyScheme = parsed.values.CUBESANDBOX_PROXY_SCHEME;
  if (
    configuredProxyScheme !== undefined &&
    configuredProxyScheme !== "http" &&
    configuredProxyScheme !== "https"
  ) {
    throw new TypeError("CUBESANDBOX_PROXY_SCHEME 只能是 http 或 https");
  }
  const sandboxApiUrl = readRequiredEnvironmentValue(parsed, "CUBESANDBOX_API_URL");
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
  return Object.freeze({
    runtimeEnvironment: parsed.runtimeEnvironment,
    databaseUrl: readRequiredEnvironmentValue(parsed, "DATABASE_URL"),
    databaseSchema: readRequiredEnvironmentValue(parsed, "DATABASE_SCHEMA"),
    objectStorage: Object.freeze({
      endpoint: readRequiredEnvironmentValue(parsed, "S3_ENDPOINT"),
      bucket: readRequiredEnvironmentValue(parsed, "S3_BUCKET"),
      region: readRequiredEnvironmentValue(parsed, "S3_REGION"),
      accessKeyId: readRequiredEnvironmentValue(parsed, "S3_ACCESS_KEY_ID"),
      secretAccessKey: readRequiredEnvironmentValue(parsed, "S3_SECRET_ACCESS_KEY"),
      forcePathStyle: readRequiredEnvironmentValue(parsed, "S3_FORCE_PATH_STYLE"),
    }),
    sandbox: Object.freeze({
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
    shutdownTimeoutMilliseconds: readRequiredEnvironmentValue(
      parsed,
      "PROCESS_SHUTDOWN_TIMEOUT_MS",
    ),
  });
}

/** 生产装配显式创建真实依赖；不会降级到内存 Fake 或跨租户扫描。 */
/** 不导出：生产依赖组合只能由本模块的 startSchedulerProcess 调用，外部无法替换或复用。 */
const productionSchedulerAssembler: ServiceAssemblyFactory<SchedulerProcessConfiguration> = {
  async assemble(configuration) {
    const pool = createPostgresPool({
      connectionString: configuration.databaseUrl,
      schema: configuration.databaseSchema,
      applicationName: "cube-runtime-scheduler-cleanup",
    });
    try {
      const gateway = new CubeSandboxGateway({
        apiUrl: configuration.sandbox.apiUrl,
        ...(configuration.sandbox.apiKey === undefined
          ? {}
          : { apiKey: configuration.sandbox.apiKey }),
        ...(configuration.sandbox.proxyNodeIp === undefined
          ? {}
          : { proxyNodeIp: configuration.sandbox.proxyNodeIp }),
        ...(configuration.sandbox.proxyPort === undefined
          ? {}
          : { proxyPort: configuration.sandbox.proxyPort }),
        ...(configuration.sandbox.proxyScheme === undefined
          ? {}
          : { proxyScheme: configuration.sandbox.proxyScheme }),
      });
      const consumer = new SandboxCleanupConsumer(
        new PgSandboxCleanupConsumerStore(pool),
        new CubeSandboxCleanupResolver(gateway),
        configuration.cleanup.workerId,
        configuration.cleanup.leaseMs,
      );
      const loop = new SandboxCleanupPollingLoop(
        consumer,
        configuration.cleanup.tenantId,
        configuration.cleanup.pollIntervalMs,
      );
      loop.start();
      const assembly = Object.freeze({
        stopAccepting: () => loop.close(),
        // loop 必须先停止并等待在途远端调用，再关闭连接池。
        resources: Object.freeze([Object.freeze({ name: "postgres", close: () => pool.end() })]),
        readiness: Object.freeze([
          Object.freeze({ name: "postgres", probe: () => probePostgres(pool) }),
        ]),
      });
      return assembly;
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  },
};

// 封闭在 Scheduler 模块内，外部 startSchedulerProcess 调用方不能以测试 assembler 置换它。
const auditedProductionSchedulerAssembly = createAuditedProductionAssembly(
  productionSchedulerAssembler,
);

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
  return startServiceProcess({
    serviceName: "scheduler",
    configuration,
    shutdownTimeoutMilliseconds: configuration.shutdownTimeoutMilliseconds,
    ...(configuration.runtimeEnvironment === "production"
      ? { auditedProductionAssembly: auditedProductionSchedulerAssembly }
      : { assembler: input.assembler ?? productionSchedulerAssembler }),
    ...(input.signalSource === undefined ? {} : { signalSource: input.signalSource }),
    ...(input.onShutdownFailure === undefined
      ? {}
      : { onShutdownFailure: input.onShutdownFailure }),
  });
}

import {
  booleanEnvironmentField,
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
import {
  createPostgresPool,
  PgSandboxCleanupConsumerStore,
  probePostgres,
} from "@cube-runtime/persistence";
import { CubeSandboxGateway } from "@cube-runtime/sandbox";
import {
  CubeSandboxCleanupResolver,
  SandboxCleanupConsumer,
  SandboxCleanupPollingLoop,
} from "./sandbox-cleanup-consumer.js";

/** 只由下方受审装配器登记；外部传入的任意 ServiceAssembly 都不能在生产环境冒充它。 */
const trustedProductionAssemblies = new WeakSet<object>();

function isTrustedProductionSchedulerAssembly(assembly: object): boolean {
  if (!trustedProductionAssemblies.has(assembly)) return false;
  const candidate = assembly as {
    readonly resources?: readonly { readonly name: string }[];
    readonly readiness?: readonly { readonly name: string }[];
  };
  return (
    candidate.resources?.length === 1 &&
    candidate.resources[0]?.name === "postgres" &&
    candidate.readiness?.length === 1 &&
    candidate.readiness[0]?.name === "postgres"
  );
}

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
      apiUrl: readRequiredEnvironmentValue(parsed, "CUBESANDBOX_API_URL"),
      ...(parsed.values.CUBESANDBOX_API_KEY === undefined
        ? {}
        : { apiKey: parsed.values.CUBESANDBOX_API_KEY }),
      ...(parsed.values.CUBESANDBOX_PROXY_NODE_IP === undefined
        ? {}
        : { proxyNodeIp: parsed.values.CUBESANDBOX_PROXY_NODE_IP }),
      ...(parsed.values.CUBESANDBOX_PROXY_PORT === undefined
        ? {}
        : { proxyPort: parsed.values.CUBESANDBOX_PROXY_PORT }),
      ...(parsed.values.CUBESANDBOX_PROXY_SCHEME === undefined
        ? {}
        : { proxyScheme: parsed.values.CUBESANDBOX_PROXY_SCHEME as "http" | "https" }),
    }),
    cleanup: Object.freeze({
      tenantId: readRequiredEnvironmentValue(parsed, "SCHEDULER_TENANT_ID"),
      workerId: readRequiredEnvironmentValue(parsed, "SCHEDULER_WORKER_ID"),
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
export const productionSchedulerAssembler: ServiceAssemblyFactory<SchedulerProcessConfiguration> = {
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
      const assembly = {
        stopAccepting: () => loop.close(),
        // loop 必须先停止并等待在途远端调用，再关闭连接池。
        resources: [{ name: "postgres", close: () => pool.end() }],
        readiness: [{ name: "postgres", probe: () => probePostgres(pool) }],
      };
      trustedProductionAssemblies.add(assembly);
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
  return startServiceProcess({
    serviceName: "scheduler",
    configuration,
    shutdownTimeoutMilliseconds: configuration.shutdownTimeoutMilliseconds,
    assembler: input.assembler ?? productionSchedulerAssembler,
    productionAssemblyVerifier: isTrustedProductionSchedulerAssembly,
    ...(input.signalSource === undefined ? {} : { signalSource: input.signalSource }),
    ...(input.onShutdownFailure === undefined
      ? {}
      : { onShutdownFailure: input.onShutdownFailure }),
  });
}

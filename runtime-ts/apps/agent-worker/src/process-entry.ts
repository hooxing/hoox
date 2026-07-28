import {
  createPostgresPool,
  createS3BlobStore,
  PgBackedSandboxSessionRegistry,
  PgBlobLifecycleRepository,
  PgExecutionPersistence,
  PgRecoveryMetrics,
  PgRunDispatchOutbox,
  PgRuntimeRolloutRepository,
  probePostgres,
  probeS3BlobStore,
} from "@cube-runtime/persistence";
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
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPgDurableObservationSession } from "./pg-observation-assembly.js";
import { PiWorkerSessionFactory } from "./pi-session-factory.js";
import {
  AgentWorkerPollingLoop,
  CubeSandboxSessionRegistry,
  DatabaseRunCancellation,
  FailClosedWorkspaceRevisionVerifier,
  NoDeclaredArtifactCompletionGate,
  ProcessShutdown,
  SystemWorkerClock,
} from "./production-worker-runtime.js";
import { RunWorker } from "./run-worker.js";

const workerEnvironmentSchema = Object.freeze({
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
  CUBESANDBOX_TEMPLATE_ID: stringEnvironmentField({ maxLength: 255 }),
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
  MODEL_BASE_URL: urlEnvironmentField(),
  MODEL_API_KEY: stringEnvironmentField({ secret: true, maxLength: 8_192 }),
  MODEL_ID: stringEnvironmentField({ maxLength: 255 }),
  MODEL_CONTEXT_WINDOW: integerEnvironmentField({ minimum: 1, maximum: 10_000_000 }),
  MODEL_MAX_OUTPUT_TOKENS: integerEnvironmentField({ minimum: 1, maximum: 10_000_000 }),
  AGENT_WORKER_TENANT_ID: stringEnvironmentField({ maxLength: 200 }),
  AGENT_WORKER_ID: stringEnvironmentField({ maxLength: 200 }),
  AGENT_WORKER_POLL_INTERVAL_MS: integerEnvironmentField({ minimum: 10, maximum: 60_000 }),
  AGENT_WORKER_DISPATCH_LEASE_MS: integerEnvironmentField({ minimum: 1_000, maximum: 300_000 }),
  AGENT_WORKER_RUN_LEASE_MS: integerEnvironmentField({ minimum: 9_000, maximum: 300_000 }),
  // Worker 只会消费开发 API 的 dev-user-a 所属租户，避免本地 Web 看见“已创建但永不消费”的 Run。
  DEV_AUTH_ENABLED: booleanEnvironmentField({ requiredIn: ["development"] }),
  DEV_AUTH_USER_A_TENANT_ID: stringEnvironmentField({
    requiredIn: ["development"],
    maxLength: 128,
  }),
  PROCESS_SHUTDOWN_TIMEOUT_MS: integerEnvironmentField({ minimum: 1, maximum: 600_000 }),
});

export const workerProcessEnvironmentKeys = Object.freeze(Object.keys(workerEnvironmentSchema));

export interface WorkerProcessConfiguration {
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
    templateId: string;
    apiKey?: string;
    proxyNodeIp?: string;
    proxyPort?: number;
    proxyScheme?: "http" | "https";
  }>;
  readonly model: Readonly<{
    baseUrl: string;
    apiKey: string;
    modelId: string;
    contextWindow: number;
    maxOutputTokens: number;
  }>;
  readonly worker: Readonly<{
    tenantId: string;
    workerId: string;
    pollIntervalMs: number;
    dispatchLeaseMs: number;
    runLeaseMs: number;
  }>;
  readonly development?: Readonly<{
    readonly userATenantId: string;
  }>;
  readonly shutdownTimeoutMilliseconds: number;
}

export function selectWorkerProcessEnvironment(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string | undefined>> {
  return selectDeclaredEnvironment(source, workerProcessEnvironmentKeys);
}

export function parseWorkerProcessEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): WorkerProcessConfiguration {
  const parsed = parseStrictEnvironment(source, workerEnvironmentSchema);
  const proxyScheme = parsed.values.CUBESANDBOX_PROXY_SCHEME;
  if (proxyScheme !== undefined && proxyScheme !== "http" && proxyScheme !== "https") {
    throw new TypeError("CUBESANDBOX_PROXY_SCHEME 只能是 http 或 https");
  }
  if (parsed.runtimeEnvironment === "development") {
    if (readRequiredEnvironmentValue(parsed, "DEV_AUTH_ENABLED") !== true) {
      throw new TypeError("开发 Agent Worker 必须启用 DEV_AUTH_ENABLED");
    }
    if (
      readRequiredEnvironmentValue(parsed, "AGENT_WORKER_TENANT_ID") !==
      readRequiredEnvironmentValue(parsed, "DEV_AUTH_USER_A_TENANT_ID")
    ) {
      throw new TypeError("AGENT_WORKER_TENANT_ID 必须与 DEV_AUTH_USER_A_TENANT_ID 一致");
    }
  }
  const contextWindow = readRequiredEnvironmentValue(parsed, "MODEL_CONTEXT_WINDOW");
  const maxOutputTokens = readRequiredEnvironmentValue(parsed, "MODEL_MAX_OUTPUT_TOKENS");
  if (maxOutputTokens > contextWindow) {
    throw new TypeError("MODEL_MAX_OUTPUT_TOKENS 不能大于 MODEL_CONTEXT_WINDOW");
  }
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
      templateId: readRequiredEnvironmentValue(parsed, "CUBESANDBOX_TEMPLATE_ID"),
      ...(parsed.values.CUBESANDBOX_API_KEY === undefined
        ? {}
        : { apiKey: parsed.values.CUBESANDBOX_API_KEY }),
      ...(parsed.values.CUBESANDBOX_PROXY_NODE_IP === undefined
        ? {}
        : { proxyNodeIp: parsed.values.CUBESANDBOX_PROXY_NODE_IP }),
      ...(parsed.values.CUBESANDBOX_PROXY_PORT === undefined
        ? {}
        : { proxyPort: parsed.values.CUBESANDBOX_PROXY_PORT }),
      ...(proxyScheme === undefined ? {} : { proxyScheme }),
    }),
    model: Object.freeze({
      baseUrl: readRequiredEnvironmentValue(parsed, "MODEL_BASE_URL"),
      apiKey: readRequiredEnvironmentValue(parsed, "MODEL_API_KEY"),
      modelId: readRequiredEnvironmentValue(parsed, "MODEL_ID"),
      contextWindow,
      maxOutputTokens,
    }),
    worker: Object.freeze({
      tenantId: readRequiredEnvironmentValue(parsed, "AGENT_WORKER_TENANT_ID"),
      workerId: readRequiredEnvironmentValue(parsed, "AGENT_WORKER_ID"),
      pollIntervalMs: readRequiredEnvironmentValue(parsed, "AGENT_WORKER_POLL_INTERVAL_MS"),
      dispatchLeaseMs: readRequiredEnvironmentValue(parsed, "AGENT_WORKER_DISPATCH_LEASE_MS"),
      runLeaseMs: readRequiredEnvironmentValue(parsed, "AGENT_WORKER_RUN_LEASE_MS"),
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
    const pool = createPostgresPool({
      connectionString: configuration.databaseUrl,
      schema: configuration.databaseSchema,
      applicationName: "cube-runtime-agent-worker",
    });
    try {
      const blobRepository = new PgBlobLifecycleRepository(pool, {
        objectPrefix: "agent-worker",
      });
      const s3Config = {
        bucket: configuration.objectStorage.bucket,
        endpoint: configuration.objectStorage.endpoint,
        region: configuration.objectStorage.region,
        accessKeyId: configuration.objectStorage.accessKeyId,
        secretAccessKey: configuration.objectStorage.secretAccessKey,
        forcePathStyle: configuration.objectStorage.forcePathStyle,
        prefix: "agent-worker",
        maxPresignTtlSeconds: 60,
        maxBlobSizeBytes: 8 * 1024 * 1024,
      } as const;
      const blobs = createS3BlobStore(s3Config, blobRepository);
      const rolloutRepository = new PgRuntimeRolloutRepository(pool);
      const durableObservation = createPgDurableObservationSession({
        blobRepository,
        blobs,
        rolloutRepository,
        policy: { maxModelObservationBytes: 4 * 1024 },
      });
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
      });
      const providerId = "runtime-openai-compatible";
      modelRuntime.registerProvider(providerId, {
        name: "Runtime OpenAI-compatible Provider",
        baseUrl: configuration.model.baseUrl,
        apiKey: configuration.model.apiKey,
        api: "openai-responses",
        models: [
          {
            id: configuration.model.modelId,
            name: configuration.model.modelId,
            api: "openai-responses",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: configuration.model.contextWindow,
            maxTokens: configuration.model.maxOutputTokens,
          },
        ],
      });
      const model = modelRuntime.getModel(providerId, configuration.model.modelId);
      if (model === undefined) throw new Error("生产模型配置无法解析");
      const sessions = new PiWorkerSessionFactory(
        model,
        modelRuntime,
        durableObservation.createRecorder,
        undefined,
        undefined,
        durableObservation.prepare,
      );
      const upstreamSandboxes = new CubeSandboxSessionRegistry(
        {
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
          defaultOperationTimeoutMs: 5_000,
        },
        configuration.sandbox.templateId,
      );
      const sandboxes = new PgBackedSandboxSessionRegistry(pool, upstreamSandboxes);
      const shutdown = new ProcessShutdown();
      const worker = new RunWorker(
        {
          persistence: new PgExecutionPersistence(pool),
          revisions: new FailClosedWorkspaceRevisionVerifier(),
          sandboxes,
          orphanSandboxes: sandboxes,
          sessions,
          cancellation: new DatabaseRunCancellation(),
          shutdownSignal: shutdown.signal,
          artifacts: new NoDeclaredArtifactCompletionGate(),
          clock: new SystemWorkerClock(),
          metrics: new PgRecoveryMetrics(pool),
        },
        {
          workerId: configuration.worker.workerId,
          leaseDurationMs: configuration.worker.runLeaseMs,
          heartbeatMs: Math.floor(configuration.worker.runLeaseMs / 3),
        },
      );
      const loop = new AgentWorkerPollingLoop(new PgRunDispatchOutbox(pool), worker, {
        tenantId: configuration.worker.tenantId,
        workerId: configuration.worker.workerId,
        pollIntervalMs: configuration.worker.pollIntervalMs,
        dispatchLeaseMs: configuration.worker.dispatchLeaseMs,
      });
      const probes = Object.freeze({
        postgres: () => probePostgres(pool),
        objectStorage: () => probeS3BlobStore(s3Config),
        sandbox: () => upstreamSandboxes.probe(),
        model: () => probeOpenAiCompatibleModel(configuration.model, "development"),
      });
      await Promise.all([
        probes.postgres(),
        probes.objectStorage(),
        probes.sandbox(),
        probes.model(),
      ]);
      loop.start();
      return Object.freeze({
        stopAccepting: async () => {
          loop.stopAccepting();
          shutdown.request();
          await loop.drain();
        },
        resources: Object.freeze([Object.freeze({ name: "postgres", close: () => pool.end() })]),
        readiness: Object.freeze([
          Object.freeze({ name: "postgres", probe: probes.postgres }),
          Object.freeze({ name: "object-storage", probe: probes.objectStorage }),
          Object.freeze({ name: "sandbox", probe: probes.sandbox }),
          Object.freeze({ name: "model-runtime", probe: probes.model }),
        ]),
      });
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  },
};

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
    schema: configuration.databaseSchema,
    applicationName: "cube-runtime-agent-worker-preflight",
  });
  try {
    const s3Config = {
      bucket: configuration.objectStorage.bucket,
      endpoint: configuration.objectStorage.endpoint,
      region: configuration.objectStorage.region,
      accessKeyId: configuration.objectStorage.accessKeyId,
      secretAccessKey: configuration.objectStorage.secretAccessKey,
      forcePathStyle: configuration.objectStorage.forcePathStyle,
      prefix: "agent-worker",
      maxPresignTtlSeconds: 60,
      maxBlobSizeBytes: 8 * 1024 * 1024,
    } as const;
    const sandbox = new CubeSandboxSessionRegistry(
      {
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
        defaultOperationTimeoutMs: 5_000,
      },
      configuration.sandbox.templateId,
    );
    await Promise.all([
      probePostgres(pool),
      probeS3BlobStore(s3Config),
      sandbox.probe(),
      probeOpenAiCompatibleModel(configuration.model, "development"),
    ]);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function probeOpenAiCompatibleModel(
  model: WorkerProcessConfiguration["model"],
  mode: "development" | "production",
): Promise<void> {
  const endpoint = new URL(
    "models",
    model.baseUrl.endsWith("/") ? model.baseUrl : `${model.baseUrl}/`,
  );
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${model.apiKey}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("模型 provider readiness 失败");
  const body = (await response.json()) as unknown;
  if (
    typeof body !== "object" ||
    body === null ||
    !("data" in body) ||
    !Array.isArray(body.data) ||
    !body.data.some((entry) => modelMetadataMatches(entry, model, mode))
  ) {
    throw new Error("模型 provider 元数据与配置不一致");
  }
}

function modelMetadataMatches(
  entry: unknown,
  model: WorkerProcessConfiguration["model"],
  mode: "development" | "production",
): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const record = entry as Record<string, unknown>;
  if (record.id !== model.modelId) return false;
  // 开发 Provider 的 /models 常见只返回 id；模型预算仍由严格环境配置提供给 Pi。
  if (mode === "development") return true;
  return (
    (record.context_window === model.contextWindow ||
      record.contextWindow === model.contextWindow) &&
    (record.max_output_tokens === model.maxOutputTokens ||
      record.maxOutputTokens === model.maxOutputTokens ||
      record.max_tokens === model.maxOutputTokens)
  );
}

export async function startWorkerProcess(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly assembler?: ServiceAssemblyFactory<WorkerProcessConfiguration>;
  readonly signalSource?: ProcessSignalSource;
  readonly onShutdownFailure?: (error: Error) => void;
}): Promise<RunningServiceProcess> {
  const configuration = parseWorkerProcessEnvironment(input.environment);
  if (configuration.runtimeEnvironment === "production") {
    throw new Error("PRODUCTION_ASSEMBLY_UNAVAILABLE:agent-worker");
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

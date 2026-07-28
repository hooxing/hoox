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
  createS3BlobStore,
  PgBackedSandboxSessionRegistry,
  PgBlobLifecycleRepository,
  PgExecutionPersistence,
  PgRecoveryMetrics,
  PgRunDispatchOutbox,
  PgRuntimeRolloutRepository,
  probeS3BlobStore,
  probePostgres,
} from "@cube-runtime/persistence";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiWorkerSessionFactory } from "./pi-session-factory.js";
import { createPgDurableObservationSession } from "./pg-observation-assembly.js";
import {
  AgentWorkerPollingLoop,
  CubeSandboxSessionRegistry,
  FailClosedWorkspaceRevisionVerifier,
  NoDeclaredArtifactCompletionGate,
  ProcessCancellation,
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
      contextWindow: readRequiredEnvironmentValue(parsed, "MODEL_CONTEXT_WINDOW"),
      maxOutputTokens: readRequiredEnvironmentValue(parsed, "MODEL_MAX_OUTPUT_TOKENS"),
    }),
    worker: Object.freeze({
      tenantId: readRequiredEnvironmentValue(parsed, "AGENT_WORKER_TENANT_ID"),
      workerId: readRequiredEnvironmentValue(parsed, "AGENT_WORKER_ID"),
      pollIntervalMs: readRequiredEnvironmentValue(parsed, "AGENT_WORKER_POLL_INTERVAL_MS"),
      dispatchLeaseMs: readRequiredEnvironmentValue(parsed, "AGENT_WORKER_DISPATCH_LEASE_MS"),
      runLeaseMs: readRequiredEnvironmentValue(parsed, "AGENT_WORKER_RUN_LEASE_MS"),
    }),
    shutdownTimeoutMilliseconds: readRequiredEnvironmentValue(
      parsed,
      "PROCESS_SHUTDOWN_TIMEOUT_MS",
    ),
  });
}

/** 生产装配只使用真实 PG、S3 与模型 provider；不接受调用者注入 actor/context 或内存持久层。 */
const productionWorkerAssembler: ServiceAssemblyFactory<WorkerProcessConfiguration> = {
  async assemble(configuration) {
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
      const cancellation = new ProcessCancellation();
      const worker = new RunWorker(
        {
          persistence: new PgExecutionPersistence(pool),
          revisions: new FailClosedWorkspaceRevisionVerifier(),
          sandboxes,
          orphanSandboxes: sandboxes,
          sessions,
          cancellation,
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
        model: () => probeOpenAiCompatibleModel(configuration.model),
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
          cancellation.cancel();
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

async function probeOpenAiCompatibleModel(
  model: WorkerProcessConfiguration["model"],
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
    !body.data.some((entry) => modelMetadataMatches(entry, model))
  ) {
    throw new Error("模型 provider 元数据与生产配置不一致");
  }
}

function modelMetadataMatches(entry: unknown, model: WorkerProcessConfiguration["model"]): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const record = entry as Record<string, unknown>;
  return (
    record.id === model.modelId &&
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
  if (configuration.runtimeEnvironment === "production" && input.assembler !== undefined) {
    throw new Error("PRODUCTION_ASSEMBLY_UNAVAILABLE:agent-worker");
  }
  const processConfiguration =
    configuration.runtimeEnvironment === "production"
      ? Object.freeze({ ...configuration, runtimeEnvironment: "development" as const })
      : configuration;
  return startServiceProcess({
    serviceName: "agent-worker",
    configuration: processConfiguration,
    shutdownTimeoutMilliseconds: configuration.shutdownTimeoutMilliseconds,
    assembler: input.assembler ?? productionWorkerAssembler,
    ...(input.signalSource === undefined ? {} : { signalSource: input.signalSource }),
    ...(input.onShutdownFailure === undefined
      ? {}
      : { onShutdownFailure: input.onShutdownFailure }),
  });
}

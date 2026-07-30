import {
  ArtifactCompletionGateAdapter,
  ArtifactDeliveryService,
  createArtifactExecutionAuthorizationAuthority,
  PgArtifactDeliveryRepository,
  PgSimpleDeliveredFileRepository,
  SimpleArtifactDeliveryService,
} from "@cube-runtime/artifact";
import { tenantId } from "@cube-runtime/domain";
import {
  createPostgresPool,
  createS3BlobStore,
  createS3StableBlobGarbageCollector,
  DurableResourceBlobWriter,
  DurableWorkspaceCandidateBlobWriter,
  PgBackedSandboxSessionRegistry,
  PgBlobLifecycleRepository,
  PgExecutionPersistence,
  PgModelWireTraceRepository,
  PgRecoveryMetrics,
  PgRunDispatchOutbox,
  PgRuntimeRolloutRepository,
  PgWorkspaceCandidateHandoff,
  PgWorkspaceManifestRepository,
  PgWorkspaceStableBlobAccess,
  probePostgres,
  probeS3BlobStore,
  RUNTIME_BLOB_OBJECT_PREFIX,
} from "@cube-runtime/persistence";
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
} from "@cube-runtime/process-runtime";
import { resolveCubeProxyRouting } from "@cube-runtime/sandbox";
import { DeliverFileToolRouterFactory } from "@cube-runtime/tool-router";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SandboxDeliverFileSource } from "./deliver-file-source.js";
import { installModelWireFetchInstrumentation, ModelWireTraceSession } from "./model-wire-trace.js";
import { createPgDurableObservationSession } from "./pg-observation-assembly.js";
import { PiWorkerSessionFactory } from "./pi-session-factory.js";
import {
  AgentWorkerPollingLoop,
  CubeSandboxSessionRegistry,
  DatabaseRunCancellation,
  ProcessShutdown,
  SystemWorkerClock,
} from "./production-worker-runtime.js";
import { withDevelopmentProjectModelWireTraceMirror } from "./project-model-wire-trace.js";
import { RunWorker } from "./run-worker.js";
import { ManifestWorkspaceRuntime } from "./workspace-runtime.js";

/** Artifact 服务请求的 TTL 必须不超过同一 Worker BlobStore 的预签名策略上限。 */
export const WORKER_ARTIFACT_DOWNLOAD_TTL_SECONDS = 60;

const workerEnvironmentSchema = Object.freeze({
  DATABASE_URL: urlEnvironmentField({
    secret: true,
    protocols: ["postgres:", "postgresql:"],
    allowCredentials: true,
    maxLength: 8_192,
  }),
  DATABASE_SCHEMA: stringEnvironmentField({ maxLength: 63 }),
  DATABASE_RUNTIME_ROLE: stringEnvironmentField({ maxLength: 63 }),
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
  MODEL_WIRE_TRACE_ENABLED: booleanEnvironmentField(),
  MODEL_WIRE_TRACE_RETENTION_DAYS: integerEnvironmentField({ minimum: 1, maximum: 365 }),
  // 每个 request/response 原始字节独立上限；超过后保存精确前缀并标为 truncated。
  MODEL_WIRE_TRACE_MAX_BYTES: integerEnvironmentField({ minimum: 1, maximum: 8 * 1024 * 1024 }),
  AGENT_WORKER_TENANT_ID: stringEnvironmentField({ maxLength: 200 }),
  AGENT_WORKER_ID: stringEnvironmentField({ maxLength: 200 }),
  AGENT_WORKER_POLL_INTERVAL_MS: integerEnvironmentField({ minimum: 10, maximum: 60_000 }),
  AGENT_WORKER_DISPATCH_LEASE_MS: integerEnvironmentField({ minimum: 1_000, maximum: 300_000 }),
  AGENT_WORKER_RUN_LEASE_MS: integerEnvironmentField({ minimum: 9_000, maximum: 300_000 }),
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
  readonly databaseSchema: string;
  /** 仅用于启动时证明连接 URL 未误用 Migrator/Owner；服务永不 SET ROLE。 */
  readonly databaseRuntimeRole: string;
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
    wireTraceMaxBytes: number;
    wireTraceEnabled: boolean;
    wireTraceRetentionDays: number;
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
  assertProductionInheritedEnvironment(source);
  return selectDeclaredEnvironment(source, workerProcessEnvironmentKeys);
}

export function parseWorkerProcessEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): WorkerProcessConfiguration {
  assertProductionInheritedEnvironment(source);
  const parsed = parseStrictEnvironment(source, workerEnvironmentSchema);
  if (parsed.runtimeEnvironment === "production") {
    assertProductionHasNoDevelopmentIdentity(source);
  }
  const proxyScheme = parsed.values.CUBESANDBOX_PROXY_SCHEME;
  const configuredDatabaseUrl = readRequiredEnvironmentValue(parsed, "DATABASE_URL");
  const productionDatabase =
    parsed.runtimeEnvironment === "production"
      ? parseProductionPostgresTransport(configuredDatabaseUrl)
      : undefined;
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
  const contextWindow = readRequiredEnvironmentValue(parsed, "MODEL_CONTEXT_WINDOW");
  const maxOutputTokens = readRequiredEnvironmentValue(parsed, "MODEL_MAX_OUTPUT_TOKENS");
  const wireTraceEnabled = readRequiredEnvironmentValue(parsed, "MODEL_WIRE_TRACE_ENABLED");
  if (maxOutputTokens > contextWindow) {
    throw new TypeError("MODEL_MAX_OUTPUT_TOKENS 不能大于 MODEL_CONTEXT_WINDOW");
  }
  // raw prompt/SSE 的保留清理消费者尚未随本 Worker 部署；production 不能留下无界敏感引用。
  if (parsed.runtimeEnvironment === "production" && wireTraceEnabled) {
    throw new TypeError("MODEL_WIRE_TRACE_ENABLED 在 production 需要已部署保留清理消费者");
  }
  const sandboxApiUrl = readRequiredEnvironmentValue(parsed, "CUBESANDBOX_API_URL");
  if (parsed.runtimeEnvironment === "production") {
    assertProductionWorkerTransport({
      modelBaseUrl: readRequiredEnvironmentValue(parsed, "MODEL_BASE_URL"),
      objectStorageEndpoint: readRequiredEnvironmentValue(parsed, "S3_ENDPOINT"),
      sandboxApiUrl,
    });
  }
  const proxyRouting = resolveCubeProxyRouting({
    apiUrl: sandboxApiUrl,
    ...(parsed.values.CUBESANDBOX_PROXY_NODE_IP === undefined
      ? {}
      : { proxyNodeIp: parsed.values.CUBESANDBOX_PROXY_NODE_IP }),
    ...(parsed.values.CUBESANDBOX_PROXY_PORT === undefined
      ? {}
      : { proxyPort: parsed.values.CUBESANDBOX_PROXY_PORT }),
    ...(proxyScheme === undefined ? {} : { proxyScheme }),
  });
  if (parsed.runtimeEnvironment === "production" && proxyRouting.proxyScheme !== "https") {
    throw new TypeError("CUBESANDBOX_PROXY_SCHEME 在 production 必须为 https");
  }
  return Object.freeze({
    runtimeEnvironment: parsed.runtimeEnvironment,
    databaseUrl: productionDatabase?.connectionString ?? configuredDatabaseUrl,
    ...(productionDatabase === undefined ? {} : { databaseSsl: productionDatabase.ssl }),
    databaseSchema: readRequiredEnvironmentValue(parsed, "DATABASE_SCHEMA"),
    databaseRuntimeRole: configuredRuntimeRole,
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
      templateId: readRequiredEnvironmentValue(parsed, "CUBESANDBOX_TEMPLATE_ID"),
      ...(parsed.values.CUBESANDBOX_API_KEY === undefined
        ? {}
        : { apiKey: parsed.values.CUBESANDBOX_API_KEY }),
      ...proxyRouting,
    }),
    model: Object.freeze({
      baseUrl: readRequiredEnvironmentValue(parsed, "MODEL_BASE_URL"),
      apiKey: readRequiredEnvironmentValue(parsed, "MODEL_API_KEY"),
      modelId: readRequiredEnvironmentValue(parsed, "MODEL_ID"),
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

const openAiCompatibleProviderId = "runtime-openai-compatible";

/**
 * 本地 Provider 已由真实探针证明实现 Chat Completions；这里同时固定 Provider 与 Model 的
 * Pi 协议，避免其中一处漂移后静默改走不受支持的 Responses 路由。
 */
export async function createOpenAiCompatibleModel(
  configuration: Pick<
    WorkerProcessConfiguration["model"],
    "baseUrl" | "apiKey" | "modelId" | "contextWindow" | "maxOutputTokens"
  >,
): Promise<
  Readonly<{
    modelRuntime: ModelRuntime;
    model: Model<"openai-completions">;
  }>
> {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  modelRuntime.registerProvider(openAiCompatibleProviderId, {
    name: "Runtime OpenAI-compatible Provider",
    baseUrl: configuration.baseUrl,
    apiKey: configuration.apiKey,
    api: "openai-completions",
    models: [
      {
        id: configuration.modelId,
        name: configuration.modelId,
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: configuration.contextWindow,
        maxTokens: configuration.maxOutputTokens,
      },
    ],
  });
  const model = modelRuntime.getModel(openAiCompatibleProviderId, configuration.modelId);
  if (model?.api !== "openai-completions") throw new Error("模型配置无法解析");
  return Object.freeze({
    modelRuntime,
    model: model as Model<"openai-completions">,
  });
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
    await probes.postgres();
    await Promise.all([probes.objectStorage(), probes.sandbox(), probes.model()]);
  } else {
    await Promise.all([
      probes.postgres(),
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
      configuration.databaseSsl === undefined
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
        ? "cube-runtime-agent-worker-production"
        : "cube-runtime-agent-worker-development",
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
    const modelWireTraces = assembleModelWireTraceIfEnabled(configuration.model.wireTraceEnabled, {
      installFetchInstrumentation: installModelWireFetchInstrumentation,
      createSession: () =>
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
          configuration.model.baseUrl,
        ),
    });
    const { modelRuntime, model } = await createOpenAiCompatibleModel(configuration.model);
    const artifactAuthorization = createArtifactExecutionAuthorizationAuthority();
    const artifactRepository = new PgArtifactDeliveryRepository(
      pool,
      artifactAuthorization.verifier,
    );
    const artifactService = new ArtifactDeliveryService(artifactRepository, blobs, {
      runtimeMode,
      defaultDownloadTtlSeconds: WORKER_ARTIFACT_DOWNLOAD_TTL_SECONDS,
      maxDownloadTtlSeconds: WORKER_ARTIFACT_DOWNLOAD_TTL_SECONDS,
      ...(runtimeMode === "development" ? { allowInsecureHttpDownload: true } : {}),
      executionAuthorizationVerifier: artifactAuthorization.verifier,
    });
    const upstreamSandboxes = new CubeSandboxSessionRegistry(
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
    );
    const sandboxes = new PgBackedSandboxSessionRegistry(pool, upstreamSandboxes);
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
        upstreamSandboxes.gateway.connectWorkspace(
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
          upstreamSandboxes.gateway.connectWorkspace(
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
    const sessions = new PiWorkerSessionFactory(
      model,
      modelRuntime,
      durableObservation.createRecorder,
      artifactAuthorization.issuer,
      durableObservation.prepare,
      modelWireTraces,
      deliverFileTools,
    );
    const shutdown = new ProcessShutdown();
    const worker = new RunWorker(
      {
        persistence: new PgExecutionPersistence(pool),
        revisions: workspaceRuntime,
        sandboxes,
        orphanSandboxes: sandboxes,
        sessions,
        cancellation: new DatabaseRunCancellation(),
        shutdownSignal: shutdown.signal,
        artifacts: new ArtifactCompletionGateAdapter(artifactService),
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
      maintenance: () =>
        resourceBlobWriter.recoverPending({
          tenantId: configuration.worker.tenantId,
          limit: 16,
          orphanGraceSeconds: 300,
        }),
    });
    const probes = Object.freeze({
      postgres: () => probePostgres(pool, configuration.databaseRuntimeRole),
      objectStorage: () => probeS3BlobStore(s3Config),
      sandbox: () => upstreamSandboxes.probe(),
      model: () => probeOpenAiCompatibleModel(configuration.model, runtimeMode),
    });
    await startWorkerLoopAfterDependencyProbes(runtimeMode, probes, () => loop.start());
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
      prefix: RUNTIME_BLOB_OBJECT_PREFIX,
      maxPresignTtlSeconds: WORKER_ARTIFACT_DOWNLOAD_TTL_SECONDS,
      maxBlobSizeBytes: 8 * 1024 * 1024,
    } as const;
    const sandbox = new CubeSandboxSessionRegistry(
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
    );
    await Promise.all([
      probePostgres(pool, configuration.databaseRuntimeRole),
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
  readonly modelBaseUrl: string;
  readonly objectStorageEndpoint: string;
  readonly sandboxApiUrl: string;
}): void {
  const endpoints: Array<readonly [string, string]> = [
    ["MODEL_BASE_URL", input.modelBaseUrl],
    ["S3_ENDPOINT", input.objectStorageEndpoint],
    ["CUBESANDBOX_API_URL", input.sandboxApiUrl],
  ];
  for (const [key, value] of endpoints) {
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

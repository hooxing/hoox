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
  PgBlobLifecycleRepository,
  PgRuntimeRolloutRepository,
  probePostgres,
} from "@cube-runtime/persistence";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiWorkerSessionFactory } from "./pi-session-factory.js";
import { createPgDurableObservationSession } from "./pg-observation-assembly.js";

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
  MODEL_BASE_URL: urlEnvironmentField(),
  MODEL_API_KEY: stringEnvironmentField({ secret: true, maxLength: 8_192 }),
  MODEL_ID: stringEnvironmentField({ maxLength: 255 }),
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
  readonly sandbox: Readonly<{ apiUrl: string; templateId: string }>;
  readonly model: Readonly<{ baseUrl: string; apiKey: string; modelId: string }>;
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
    }),
    model: Object.freeze({
      baseUrl: readRequiredEnvironmentValue(parsed, "MODEL_BASE_URL"),
      apiKey: readRequiredEnvironmentValue(parsed, "MODEL_API_KEY"),
      modelId: readRequiredEnvironmentValue(parsed, "MODEL_ID"),
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
      const blobs = createS3BlobStore(
        {
          bucket: configuration.objectStorage.bucket,
          endpoint: configuration.objectStorage.endpoint,
          region: configuration.objectStorage.region,
          accessKeyId: configuration.objectStorage.accessKeyId,
          secretAccessKey: configuration.objectStorage.secretAccessKey,
          forcePathStyle: configuration.objectStorage.forcePathStyle,
          prefix: "agent-worker",
          maxPresignTtlSeconds: 60,
          maxBlobSizeBytes: 8 * 1024 * 1024,
        },
        blobRepository,
      );
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
            contextWindow: 128_000,
            maxTokens: 16_384,
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
      await probePostgres(pool);
      return Object.freeze({
        stopAccepting: async () => undefined,
        resources: Object.freeze([Object.freeze({ name: "postgres", close: () => pool.end() })]),
        readiness: Object.freeze([
          Object.freeze({ name: "postgres", probe: () => probePostgres(pool) }),
          Object.freeze({
            name: "model-runtime",
            probe: async () => {
              // 闭包持有完整生产 Session 装配，且只验证本地已注册模型，不在 readiness 发模型请求。
              if (
                !(sessions instanceof PiWorkerSessionFactory) ||
                modelRuntime.getModel(providerId, model.id) === undefined
              ) {
                throw new Error("模型 Session 装配不可用");
              }
            },
          }),
        ]),
      });
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  },
};

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

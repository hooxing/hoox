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

export async function startWorkerProcess(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly assembler?: ServiceAssemblyFactory<WorkerProcessConfiguration>;
  readonly signalSource?: ProcessSignalSource;
  readonly onShutdownFailure?: (error: Error) => void;
}): Promise<RunningServiceProcess> {
  const configuration = parseWorkerProcessEnvironment(input.environment);
  return startServiceProcess({
    serviceName: "agent-worker",
    configuration,
    shutdownTimeoutMilliseconds: configuration.shutdownTimeoutMilliseconds,
    ...(input.assembler === undefined ? {} : { assembler: input.assembler }),
    ...(input.signalSource === undefined ? {} : { signalSource: input.signalSource }),
    ...(input.onShutdownFailure === undefined
      ? {}
      : { onShutdownFailure: input.onShutdownFailure }),
  });
}

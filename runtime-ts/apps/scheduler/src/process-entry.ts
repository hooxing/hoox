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
    shutdownTimeoutMilliseconds: readRequiredEnvironmentValue(
      parsed,
      "PROCESS_SHUTDOWN_TIMEOUT_MS",
    ),
  });
}

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
    ...(input.assembler === undefined ? {} : { assembler: input.assembler }),
    ...(input.signalSource === undefined ? {} : { signalSource: input.signalSource }),
    ...(input.onShutdownFailure === undefined
      ? {}
      : { onShutdownFailure: input.onShutdownFailure }),
  });
}

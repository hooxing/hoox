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
import { developmentApiAssembler } from "./development-assembly.js";
import {
  type ApiDevelopmentPrincipal,
  assertDevelopmentPrincipalsIsolated,
  normalizeDevelopmentLoopbackHost,
} from "./development-boundary.js";

const optionalEnvironments = [] as const;
const apiEnvironmentSchema = Object.freeze({
  DATABASE_URL: urlEnvironmentField({
    secret: true,
    protocols: ["postgres:", "postgresql:"],
    allowCredentials: true,
    maxLength: 8_192,
  }),
  DATABASE_SCHEMA: stringEnvironmentField({ maxLength: 63 }),
  THREAD_CURSOR_ACTIVE_KID: stringEnvironmentField({ maxLength: 128 }),
  THREAD_CURSOR_SIGNING_KEYS: stringEnvironmentField({ secret: true, maxLength: 16_384 }),
  DEV_AUTH_ENABLED: booleanEnvironmentField(),
  DEV_AUTH_USER_A_ID: stringEnvironmentField({ requiredIn: optionalEnvironments, maxLength: 128 }),
  DEV_AUTH_USER_A_TENANT_ID: stringEnvironmentField({
    requiredIn: optionalEnvironments,
    maxLength: 128,
  }),
  DEV_AUTH_USER_B_ID: stringEnvironmentField({ requiredIn: optionalEnvironments, maxLength: 128 }),
  DEV_AUTH_USER_B_TENANT_ID: stringEnvironmentField({
    requiredIn: optionalEnvironments,
    maxLength: 128,
  }),
  PROCESS_SHUTDOWN_TIMEOUT_MS: integerEnvironmentField({ minimum: 1, maximum: 600_000 }),
  API_LISTEN_HOST: stringEnvironmentField({ requiredIn: optionalEnvironments, maxLength: 253 }),
  API_LISTEN_PORT: integerEnvironmentField({
    requiredIn: optionalEnvironments,
    minimum: 1,
    maximum: 65_535,
  }),
  S3_ENDPOINT: urlEnvironmentField(),
  S3_PUBLIC_ENDPOINT: urlEnvironmentField(),
  S3_BUCKET: stringEnvironmentField({ maxLength: 255 }),
  S3_REGION: stringEnvironmentField({ maxLength: 128 }),
  S3_ACCESS_KEY_ID: stringEnvironmentField({ secret: true, maxLength: 1_024 }),
  S3_SECRET_ACCESS_KEY: stringEnvironmentField({ secret: true, maxLength: 4_096 }),
  S3_FORCE_PATH_STYLE: booleanEnvironmentField(),
});

export const apiProcessEnvironmentKeys = Object.freeze(Object.keys(apiEnvironmentSchema));

export type { ApiDevelopmentPrincipal } from "./development-boundary.js";

export interface ApiProcessConfiguration {
  readonly runtimeEnvironment: RuntimeEnvironment;
  readonly databaseUrl: string;
  readonly databaseSchema: string;
  readonly cursorActiveKeyId: string;
  readonly cursorSigningKeys: string;
  readonly developmentPrincipals?: readonly [ApiDevelopmentPrincipal, ApiDevelopmentPrincipal];
  readonly shutdownTimeoutMilliseconds: number;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly objectStorage: Readonly<{
    readonly endpoint: string;
    readonly publicEndpoint: string;
    readonly bucket: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly forcePathStyle: boolean;
  }>;
}

export function selectApiProcessEnvironment(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string | undefined>> {
  return selectDeclaredEnvironment(source, apiProcessEnvironmentKeys);
}

export function parseApiProcessEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): ApiProcessConfiguration {
  const parsed = parseStrictEnvironment(source, apiEnvironmentSchema);
  const developmentAuthEnabled = readRequiredEnvironmentValue(parsed, "DEV_AUTH_ENABLED");
  // 开发身份只有明确开启时才进入配置对象；生产环境由共享解析器直接拒绝。
  const developmentPrincipals = developmentAuthEnabled
    ? Object.freeze([
        Object.freeze({
          userId: readRequiredEnvironmentValue(parsed, "DEV_AUTH_USER_A_ID"),
          tenantId: readRequiredEnvironmentValue(parsed, "DEV_AUTH_USER_A_TENANT_ID"),
        }),
        Object.freeze({
          userId: readRequiredEnvironmentValue(parsed, "DEV_AUTH_USER_B_ID"),
          tenantId: readRequiredEnvironmentValue(parsed, "DEV_AUTH_USER_B_TENANT_ID"),
        }),
      ] as const)
    : undefined;
  const configuredListenHost = parsed.values.API_LISTEN_HOST ?? "127.0.0.1";
  const listenHost =
    developmentPrincipals === undefined
      ? configuredListenHost
      : normalizeDevelopmentLoopbackHost(configuredListenHost);
  if (developmentPrincipals !== undefined) {
    assertDevelopmentPrincipalsIsolated(developmentPrincipals);
  }
  return Object.freeze({
    runtimeEnvironment: parsed.runtimeEnvironment,
    databaseUrl: readRequiredEnvironmentValue(parsed, "DATABASE_URL"),
    databaseSchema: readRequiredEnvironmentValue(parsed, "DATABASE_SCHEMA"),
    cursorActiveKeyId: readRequiredEnvironmentValue(parsed, "THREAD_CURSOR_ACTIVE_KID"),
    cursorSigningKeys: readRequiredEnvironmentValue(parsed, "THREAD_CURSOR_SIGNING_KEYS"),
    ...(developmentPrincipals === undefined ? {} : { developmentPrincipals }),
    shutdownTimeoutMilliseconds: readRequiredEnvironmentValue(
      parsed,
      "PROCESS_SHUTDOWN_TIMEOUT_MS",
    ),
    listenHost,
    listenPort: parsed.values.API_LISTEN_PORT ?? 3001,
    objectStorage: Object.freeze({
      endpoint: readRequiredEnvironmentValue(parsed, "S3_ENDPOINT"),
      publicEndpoint: readRequiredEnvironmentValue(parsed, "S3_PUBLIC_ENDPOINT"),
      bucket: readRequiredEnvironmentValue(parsed, "S3_BUCKET"),
      region: readRequiredEnvironmentValue(parsed, "S3_REGION"),
      accessKeyId: readRequiredEnvironmentValue(parsed, "S3_ACCESS_KEY_ID"),
      secretAccessKey: readRequiredEnvironmentValue(parsed, "S3_SECRET_ACCESS_KEY"),
      forcePathStyle: readRequiredEnvironmentValue(parsed, "S3_FORCE_PATH_STYLE"),
    }),
  });
}

export async function startApiProcess(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly assembler?: ServiceAssemblyFactory<ApiProcessConfiguration>;
  readonly signalSource?: ProcessSignalSource;
  readonly onShutdownFailure?: (error: Error) => void;
}): Promise<RunningServiceProcess> {
  const configuration = parseApiProcessEnvironment(input.environment);
  const assembler =
    input.assembler ??
    (configuration.runtimeEnvironment === "development" &&
    configuration.developmentPrincipals !== undefined
      ? developmentApiAssembler
      : undefined);
  return startServiceProcess({
    serviceName: "api",
    configuration,
    shutdownTimeoutMilliseconds: configuration.shutdownTimeoutMilliseconds,
    ...(assembler === undefined ? {} : { assembler }),
    ...(input.signalSource === undefined ? {} : { signalSource: input.signalSource }),
    ...(input.onShutdownFailure === undefined
      ? {}
      : { onShutdownFailure: input.onShutdownFailure }),
  });
}

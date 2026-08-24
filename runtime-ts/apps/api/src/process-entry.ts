import {
  assertProductionInheritedEnvironment,
  booleanEnvironmentField,
  EnvironmentConfigurationError,
  integerEnvironmentField,
  type ProcessSignalSource,
  parseStrictEnvironment,
  parseProductionPostgresTransport,
  type RunningServiceProcess,
  type RuntimeEnvironment,
  readRequiredEnvironmentValue,
  type ServiceAssemblyFactory,
  selectDeclaredEnvironment,
  startServiceProcess,
  stringEnvironmentField,
  urlEnvironmentField,
} from "@hoox/process-runtime";
import { developmentApiAssembler } from "./development-assembly.js";
import {
  type ApiDevelopmentPrincipal,
  assertDevelopmentPrincipalsIsolated,
  assertDevelopmentPublicObjectStorageEndpoint,
  DEVELOPMENT_API_DEFAULT_PORT,
  normalizeDevelopmentLoopbackHost,
} from "./development-boundary.js";
import {
  parseProductionJwtSigningKeys,
  type ProductionJwtVerificationKey,
} from "./production-auth.js";
import { startProductionApiProcess } from "./production-assembly.js";
import {
  parseProductionApiTransport,
  type ProductionApiTransport,
} from "./production-transport.js";

const optionalEnvironments = [] as const;
const developmentAndTestEnvironments = ["development", "test"] as const;
const productionEnvironment = ["production"] as const;
const apiEnvironmentSchema = Object.freeze({
  DATABASE_URL: urlEnvironmentField({
    secret: true,
    protocols: ["postgres:", "postgresql:"],
    allowCredentials: true,
    maxLength: 8_192,
  }),
  DATABASE_SCHEMA: stringEnvironmentField({ maxLength: 63 }),
  BETTER_AUTH_SECRET: stringEnvironmentField({ secret: true, maxLength: 4096 }),
  BETTER_AUTH_TRUSTED_ORIGINS: stringEnvironmentField({
    requiredIn: optionalEnvironments,
    maxLength: 8192,
  }),
  DATABASE_RUNTIME_ROLE: stringEnvironmentField({
    requiredIn: productionEnvironment,
    maxLength: 63,
  }),
  DATABASE_TEAM_COORDINATOR_URL: urlEnvironmentField({
    secret: true,
    protocols: ["postgres:", "postgresql:"],
    allowCredentials: true,
    maxLength: 8_192,
  }),
  DATABASE_TEAM_COORDINATOR_ROLE: stringEnvironmentField({
    requiredIn: productionEnvironment,
    maxLength: 63,
  }),
  THREAD_CURSOR_ACTIVE_KID: stringEnvironmentField({ maxLength: 128 }),
  THREAD_CURSOR_SIGNING_KEYS: stringEnvironmentField({ secret: true, maxLength: 16_384 }),
  THREAD_SERIAL_QUEUE_V2_ENABLED: booleanEnvironmentField({ requiredIn: optionalEnvironments }),
  THREAD_CONTEXT_V2_WRITE_ENABLED: booleanEnvironmentField({ requiredIn: optionalEnvironments }),
  THREAD_CONTEXT_V2_SHADOW_READ_ENABLED: booleanEnvironmentField({
    requiredIn: optionalEnvironments,
  }),
  THREAD_CONTEXT_V2_READ_ENABLED: booleanEnvironmentField({ requiredIn: optionalEnvironments }),
  THREAD_INPUT_ROUTING_V2_ENABLED: booleanEnvironmentField({ requiredIn: optionalEnvironments }),
  API_JWT_ISSUER: stringEnvironmentField({ requiredIn: productionEnvironment, maxLength: 512 }),
  API_JWT_AUDIENCE: stringEnvironmentField({ requiredIn: productionEnvironment, maxLength: 512 }),
  API_JWT_SIGNING_KEYS: stringEnvironmentField({
    requiredIn: productionEnvironment,
    secret: true,
    maxLength: 8_192,
  }),
  API_JWT_CLOCK_SKEW_SECONDS: integerEnvironmentField({
    requiredIn: productionEnvironment,
    minimum: 1,
    maximum: 300,
  }),
  API_JWT_MAX_LIFETIME_SECONDS: integerEnvironmentField({
    requiredIn: productionEnvironment,
    minimum: 60,
    maximum: 86_400,
  }),
  // production 中即使 false 也不能出现，显式检查位于 parseApiProcessEnvironment。
  DEV_AUTH_ENABLED: booleanEnvironmentField({ requiredIn: developmentAndTestEnvironments }),
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
  API_LISTEN_HOST: stringEnvironmentField({ requiredIn: productionEnvironment, maxLength: 253 }),
  API_LISTEN_PORT: integerEnvironmentField({
    requiredIn: productionEnvironment,
    minimum: 1,
    maximum: 65_535,
  }),
  API_PUBLIC_ORIGIN: urlEnvironmentField({ requiredIn: productionEnvironment }),
  API_TLS_MODE: stringEnvironmentField({ requiredIn: productionEnvironment, maxLength: 6 }),
  API_TLS_CERT_PATH: stringEnvironmentField({ requiredIn: optionalEnvironments, maxLength: 4_096 }),
  API_TLS_KEY_PATH: stringEnvironmentField({
    requiredIn: optionalEnvironments,
    secret: true,
    maxLength: 4_096,
  }),
  API_TRUSTED_PROXY_CIDRS: stringEnvironmentField({
    requiredIn: optionalEnvironments,
    maxLength: 4_096,
  }),
  S3_ENDPOINT: urlEnvironmentField(),
  S3_PUBLIC_ENDPOINT: urlEnvironmentField(),
  S3_BUCKET: stringEnvironmentField({ maxLength: 255 }),
  S3_REGION: stringEnvironmentField({ maxLength: 128 }),
  S3_ACCESS_KEY_ID: stringEnvironmentField({ secret: true, maxLength: 1_024 }),
  S3_SECRET_ACCESS_KEY: stringEnvironmentField({ secret: true, maxLength: 4_096 }),
  S3_FORCE_PATH_STYLE: booleanEnvironmentField(),
  RESOURCE_FILESYSTEM_SIGNING_KEY: stringEnvironmentField({ secret: true, maxLength: 256 }),
  HISTORY_FILESYSTEM_ENABLED: booleanEnvironmentField({ requiredIn: optionalEnvironments }),
  HISTORY_TITLE_GENERATION_ENABLED: booleanEnvironmentField({ requiredIn: optionalEnvironments }),
  HISTORY_DIRECTORY_TIME_ZONE: stringEnvironmentField({
    requiredIn: optionalEnvironments,
    maxLength: 128,
  }),
  // 仅供本地 Cubelet 访问开发 API 的 ResourceFS HTTPS 边界，production 显式拒绝。
  RESOURCEFS_PROXY_ENABLED: booleanEnvironmentField({ requiredIn: optionalEnvironments }),
  RESOURCEFS_PROXY_LISTEN_HOST: stringEnvironmentField({
    requiredIn: optionalEnvironments,
    maxLength: 253,
  }),
  RESOURCEFS_PROXY_LISTEN_PORT: integerEnvironmentField({
    requiredIn: optionalEnvironments,
    minimum: 1,
    maximum: 65_535,
  }),
  RESOURCEFS_PROXY_TLS_KEY_PATH: stringEnvironmentField({
    requiredIn: optionalEnvironments,
    secret: true,
    maxLength: 4_096,
  }),
  RESOURCEFS_PROXY_TLS_CERT_PATH: stringEnvironmentField({
    requiredIn: optionalEnvironments,
    maxLength: 4_096,
  }),
});

export const apiProcessEnvironmentKeys = Object.freeze(Object.keys(apiEnvironmentSchema));

export type { ApiDevelopmentPrincipal } from "./development-boundary.js";

export interface ApiProcessConfiguration {
  readonly runtimeEnvironment: RuntimeEnvironment;
  readonly databaseUrl: string;
  readonly databaseSsl?: Readonly<{ readonly rejectUnauthorized: true }>;
  readonly databaseTeamCoordinatorUrl: string;
  readonly databaseTeamCoordinatorSsl?: Readonly<{ readonly rejectUnauthorized: true }>;
  readonly databaseSchema: string;
  readonly databaseRuntimeRole?: string;
  readonly databaseTeamCoordinatorRole?: string;
  readonly cursorActiveKeyId: string;
  readonly identityAuth: Readonly<{
    readonly secret: string;
    readonly baseURL: string;
    readonly trustedOrigins: readonly string[];
  }>;
  readonly cursorSigningKeys: string;
  readonly serialQueueV2Enabled: boolean;
  readonly threadContextV2ReadEnabled: boolean;
  readonly threadInputRoutingV2Enabled: boolean;
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
  readonly resourceFilesystemSigningKey: string;
  readonly historyFilesystemEnabled: boolean;
  readonly historyTitleGenerationEnabled: boolean;
  readonly historyDirectoryTimeZone: string;
  readonly developmentResourceFilesystemProxy?: Readonly<{
    readonly listenHost: string;
    readonly listenPort: number;
    readonly upstream: string;
    readonly privateKeyPath: string;
    readonly certificatePath: string;
  }>;
  readonly production?: Readonly<{
    readonly publicOrigin: string;
    readonly jwt: Readonly<{
      readonly issuer: string;
      readonly audience: string;
      readonly keys: readonly ProductionJwtVerificationKey[];
      readonly clockSkewSeconds: number;
      readonly maxTokenLifetimeSeconds: number;
    }>;
    readonly transport: ProductionApiTransport;
  }>;
}

export function selectApiProcessEnvironment(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string | undefined>> {
  assertProductionInheritedEnvironment(source);
  return selectDeclaredEnvironment(source, apiProcessEnvironmentKeys);
}

export function parseApiProcessEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): ApiProcessConfiguration {
  assertProductionInheritedEnvironment(source);
  const parsed = parseStrictEnvironment(source, apiEnvironmentSchema);
  if (parsed.runtimeEnvironment === "production") {
    assertProductionHasNoDevelopmentIdentity(source);
    assertProductionHasNoDevelopmentResourceFilesystemProxy(source);
  }
  const developmentAuthEnabled =
    parsed.runtimeEnvironment === "production"
      ? false
      : readRequiredEnvironmentValue(parsed, "DEV_AUTH_ENABLED");
  const configuredDatabaseUrl = readRequiredEnvironmentValue(parsed, "DATABASE_URL");
  const configuredTeamCoordinatorUrl = readRequiredEnvironmentValue(
    parsed,
    "DATABASE_TEAM_COORDINATOR_URL",
  );
  const productionDatabase =
    parsed.runtimeEnvironment === "production"
      ? parseProductionPostgresTransport(configuredDatabaseUrl)
      : undefined;
  const productionTeamCoordinatorDatabase =
    parsed.runtimeEnvironment === "production"
      ? parseProductionPostgresTransport(configuredTeamCoordinatorUrl)
      : undefined;
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
  const databaseRuntimeRole = parsed.values.DATABASE_RUNTIME_ROLE;
  if (databaseRuntimeRole !== undefined && !/^[a-z_][a-z0-9_]{0,62}$/u.test(databaseRuntimeRole)) {
    throw new TypeError("DATABASE_RUNTIME_ROLE 格式无效");
  }
  const databaseTeamCoordinatorRole = parsed.values.DATABASE_TEAM_COORDINATOR_ROLE;
  if (
    databaseTeamCoordinatorRole !== undefined &&
    !/^[a-z_][a-z0-9_]{0,62}$/u.test(databaseTeamCoordinatorRole)
  ) {
    throw new TypeError("DATABASE_TEAM_COORDINATOR_ROLE 格式无效");
  }
  if (databaseRuntimeRole !== undefined && databaseTeamCoordinatorRole === databaseRuntimeRole) {
    throw new TypeError("DATABASE_TEAM_COORDINATOR_ROLE 必须与 DATABASE_RUNTIME_ROLE 不同");
  }
  const listenPort = parsed.values.API_LISTEN_PORT ?? DEVELOPMENT_API_DEFAULT_PORT;
  const developmentResourceFilesystemProxy = createDevelopmentResourceFilesystemProxy({
    runtimeEnvironment: parsed.runtimeEnvironment,
    enabled: parsed.values.RESOURCEFS_PROXY_ENABLED ?? false,
    listenHost: parsed.values.RESOURCEFS_PROXY_LISTEN_HOST,
    listenPort: parsed.values.RESOURCEFS_PROXY_LISTEN_PORT,
    privateKeyPath: parsed.values.RESOURCEFS_PROXY_TLS_KEY_PATH,
    certificatePath: parsed.values.RESOURCEFS_PROXY_TLS_CERT_PATH,
    apiListenHost: listenHost,
    apiListenPort: listenPort,
  });
  const objectStorage = Object.freeze({
    endpoint: readRequiredEnvironmentValue(parsed, "S3_ENDPOINT"),
    publicEndpoint: readRequiredEnvironmentValue(parsed, "S3_PUBLIC_ENDPOINT"),
    bucket: readRequiredEnvironmentValue(parsed, "S3_BUCKET"),
    region: readRequiredEnvironmentValue(parsed, "S3_REGION"),
    accessKeyId: readRequiredEnvironmentValue(parsed, "S3_ACCESS_KEY_ID"),
    secretAccessKey: readRequiredEnvironmentValue(parsed, "S3_SECRET_ACCESS_KEY"),
    forcePathStyle: readRequiredEnvironmentValue(parsed, "S3_FORCE_PATH_STYLE"),
  });
  if (developmentPrincipals !== undefined) {
    assertDevelopmentPublicObjectStorageEndpoint(
      objectStorage.publicEndpoint,
      listenHost,
      listenPort,
    );
  }
  const production =
    parsed.runtimeEnvironment === "production"
      ? createProductionConfiguration({
          listenHost,
          tlsMode: readRequiredEnvironmentValue(parsed, "API_TLS_MODE"),
          ...(parsed.values.API_TLS_CERT_PATH === undefined
            ? {}
            : { certificatePath: parsed.values.API_TLS_CERT_PATH }),
          ...(parsed.values.API_TLS_KEY_PATH === undefined
            ? {}
            : { privateKeyPath: parsed.values.API_TLS_KEY_PATH }),
          ...(parsed.values.API_TRUSTED_PROXY_CIDRS === undefined
            ? {}
            : { trustedProxyCidrs: parsed.values.API_TRUSTED_PROXY_CIDRS }),
          issuer: readRequiredEnvironmentValue(parsed, "API_JWT_ISSUER"),
          audience: readRequiredEnvironmentValue(parsed, "API_JWT_AUDIENCE"),
          signingKeys: readRequiredEnvironmentValue(parsed, "API_JWT_SIGNING_KEYS"),
          clockSkewSeconds: readRequiredEnvironmentValue(parsed, "API_JWT_CLOCK_SKEW_SECONDS"),
          maxTokenLifetimeSeconds: readRequiredEnvironmentValue(
            parsed,
            "API_JWT_MAX_LIFETIME_SECONDS",
          ),
          publicOrigin: readRequiredEnvironmentValue(parsed, "API_PUBLIC_ORIGIN"),
          objectStorageEndpoint: objectStorage.endpoint,
          objectStoragePublicEndpoint: objectStorage.publicEndpoint,
        })
      : undefined;
  const serialQueueV2Enabled = parsed.values.THREAD_SERIAL_QUEUE_V2_ENABLED ?? true;
  const contextWriteEnabled = parsed.values.THREAD_CONTEXT_V2_WRITE_ENABLED ?? true;
  const contextShadowEnabled = parsed.values.THREAD_CONTEXT_V2_SHADOW_READ_ENABLED ?? true;
  const contextReadEnabled = parsed.values.THREAD_CONTEXT_V2_READ_ENABLED ?? true;
  const inputRoutingEnabled = parsed.values.THREAD_INPUT_ROUTING_V2_ENABLED ?? true;
  if (contextWriteEnabled && !serialQueueV2Enabled) {
    throw new TypeError("THREAD_CONTEXT_V2_WRITE_ENABLED 依赖 Thread 串行队列");
  }
  if (contextShadowEnabled && !contextWriteEnabled) {
    throw new TypeError("THREAD_CONTEXT_V2_SHADOW_READ_ENABLED 依赖 V2 write");
  }
  if (contextReadEnabled && !contextShadowEnabled) {
    throw new TypeError("THREAD_CONTEXT_V2_READ_ENABLED 依赖 shadow read");
  }
  if (inputRoutingEnabled && (!serialQueueV2Enabled || !contextReadEnabled)) {
    throw new TypeError("THREAD_INPUT_ROUTING_V2_ENABLED 依赖串行队列与 V2 Context read");
  }
  const historyFilesystemEnabled = parsed.values.HISTORY_FILESYSTEM_ENABLED ?? false;
  const historyTitleGenerationEnabled = parsed.values.HISTORY_TITLE_GENERATION_ENABLED ?? false;
  if (historyTitleGenerationEnabled && (!historyFilesystemEnabled || !inputRoutingEnabled)) {
    throw new TypeError("HISTORY_TITLE_GENERATION_ENABLED 依赖历史文件系统与 V2 输入路由");
  }

  const historyDirectoryTimeZone = parsed.values.HISTORY_DIRECTORY_TIME_ZONE ?? "Asia/Shanghai";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: historyDirectoryTimeZone }).format(new Date(0));
  } catch {
    throw new TypeError("HISTORY_DIRECTORY_TIME_ZONE 无效");
  }
  const betterAuthSecret = readRequiredEnvironmentValue(parsed, "BETTER_AUTH_SECRET");
  if (Buffer.byteLength(betterAuthSecret, "utf8") < 32) {
    throw new TypeError("INVALID:BETTER_AUTH_SECRET");
  }
  return Object.freeze({
    runtimeEnvironment: parsed.runtimeEnvironment,
    databaseUrl: productionDatabase?.connectionString ?? configuredDatabaseUrl,
    ...(productionDatabase === undefined ? {} : { databaseSsl: productionDatabase.ssl }),
    databaseTeamCoordinatorUrl:
      productionTeamCoordinatorDatabase?.connectionString ?? configuredTeamCoordinatorUrl,
    ...(productionTeamCoordinatorDatabase === undefined
      ? {}
      : { databaseTeamCoordinatorSsl: productionTeamCoordinatorDatabase.ssl }),
    databaseSchema: readRequiredEnvironmentValue(parsed, "DATABASE_SCHEMA"),
    ...(databaseRuntimeRole === undefined ? {} : { databaseRuntimeRole }),
    ...(databaseTeamCoordinatorRole === undefined ? {} : { databaseTeamCoordinatorRole }),
    identityAuth: Object.freeze({
      secret: betterAuthSecret,
      baseURL:
        production?.publicOrigin ??
        `http://${listenHost === "0.0.0.0" || listenHost === "::" ? "127.0.0.1" : listenHost}:${listenPort}`,
      trustedOrigins: Object.freeze(
        (parsed.values.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
          .map((value) => new URL(value).origin),
      ),
    }),
    cursorActiveKeyId: readRequiredEnvironmentValue(parsed, "THREAD_CURSOR_ACTIVE_KID"),
    cursorSigningKeys: readRequiredEnvironmentValue(parsed, "THREAD_CURSOR_SIGNING_KEYS"),
    serialQueueV2Enabled,
    threadContextV2ReadEnabled: contextReadEnabled,
    threadInputRoutingV2Enabled: inputRoutingEnabled,
    ...(developmentPrincipals === undefined ? {} : { developmentPrincipals }),
    shutdownTimeoutMilliseconds: readRequiredEnvironmentValue(
      parsed,
      "PROCESS_SHUTDOWN_TIMEOUT_MS",
    ),
    listenHost,
    listenPort,
    objectStorage,
    historyFilesystemEnabled,
    historyTitleGenerationEnabled,
    historyDirectoryTimeZone,
    resourceFilesystemSigningKey: readRequiredEnvironmentValue(
      parsed,
      "RESOURCE_FILESYSTEM_SIGNING_KEY",
    ),
    ...(developmentResourceFilesystemProxy === undefined
      ? {}
      : { developmentResourceFilesystemProxy }),
    ...(production === undefined ? {} : { production }),
  });
}

export async function startApiProcess(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly assembler?: ServiceAssemblyFactory<ApiProcessConfiguration>;
  readonly signalSource?: ProcessSignalSource;
  readonly onShutdownFailure?: (error: Error) => void;
}): Promise<RunningServiceProcess> {
  const configuration = parseApiProcessEnvironment(input.environment);
  if (configuration.runtimeEnvironment === "production") {
    if (input.assembler !== undefined) {
      // 生产入口固定选择真实依赖图；调用方传入 Fake 时不进入装配阶段。
      throw new Error("PRODUCTION_ASSEMBLY_UNAVAILABLE:api");
    }
    return startProductionApiProcess(configuration, {
      ...(input.signalSource === undefined ? {} : { signalSource: input.signalSource }),
      ...(input.onShutdownFailure === undefined
        ? {}
        : { onShutdownFailure: input.onShutdownFailure }),
    });
  }
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

const developmentIdentityEnvironmentKeys = Object.freeze([
  "DEV_AUTH_ENABLED",
  "DEV_AUTH_USER_A_ID",
  "DEV_AUTH_USER_A_TENANT_ID",
  "DEV_AUTH_USER_B_ID",
  "DEV_AUTH_USER_B_TENANT_ID",
] as const);

const developmentResourceFilesystemProxyEnvironmentKeys = Object.freeze([
  "RESOURCEFS_PROXY_ENABLED",
  "RESOURCEFS_PROXY_LISTEN_HOST",
  "RESOURCEFS_PROXY_LISTEN_PORT",
  "RESOURCEFS_PROXY_TLS_KEY_PATH",
  "RESOURCEFS_PROXY_TLS_CERT_PATH",
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

function assertProductionHasNoDevelopmentResourceFilesystemProxy(
  source: Readonly<Record<string, string | undefined>>,
): void {
  const configured = developmentResourceFilesystemProxyEnvironmentKeys.filter(
    (key) => source[key] !== undefined,
  );
  if (configured.length > 0) {
    throw new EnvironmentConfigurationError(
      configured.map((key) => ({ code: "FORBIDDEN_IN_PRODUCTION" as const, key })),
    );
  }
}

function createDevelopmentResourceFilesystemProxy(input: {
  readonly runtimeEnvironment: RuntimeEnvironment;
  readonly enabled: boolean;
  readonly listenHost: string | undefined;
  readonly listenPort: number | undefined;
  readonly privateKeyPath: string | undefined;
  readonly certificatePath: string | undefined;
  readonly apiListenHost: string;
  readonly apiListenPort: number;
}): ApiProcessConfiguration["developmentResourceFilesystemProxy"] {
  const configuredFields = [
    input.listenHost,
    input.listenPort,
    input.privateKeyPath,
    input.certificatePath,
  ];
  if (!input.enabled) {
    if (configuredFields.some((value) => value !== undefined)) {
      throw new TypeError("RESOURCEFS_PROXY_ENABLED=false 时不得配置 Sidecar 字段");
    }
    return undefined;
  }
  if (input.runtimeEnvironment !== "development") {
    throw new TypeError("ResourceFS Sidecar 只允许在 development 启用");
  }
  if (
    input.listenHost === undefined ||
    input.listenPort === undefined ||
    input.privateKeyPath === undefined ||
    input.certificatePath === undefined
  ) {
    throw new TypeError("ResourceFS Sidecar 配置不完整");
  }
  const upstreamHost = input.apiListenHost.includes(":")
    ? `[${input.apiListenHost}]`
    : input.apiListenHost;
  return Object.freeze({
    listenHost: input.listenHost,
    listenPort: input.listenPort,
    upstream: `http://${upstreamHost}:${input.apiListenPort}`,
    privateKeyPath: input.privateKeyPath,
    certificatePath: input.certificatePath,
  });
}

function createProductionConfiguration(input: {
  readonly listenHost: string;
  readonly tlsMode: string;
  readonly certificatePath?: string;
  readonly privateKeyPath?: string;
  readonly trustedProxyCidrs?: string;
  readonly issuer: string;
  readonly audience: string;
  readonly signingKeys: string;
  readonly clockSkewSeconds: number;
  readonly maxTokenLifetimeSeconds: number;
  readonly publicOrigin: string;
  readonly objectStorageEndpoint: string;
  readonly objectStoragePublicEndpoint: string;
}): NonNullable<ApiProcessConfiguration["production"]> {
  assertProductionObjectStorageTransport(input.objectStorageEndpoint, "S3_ENDPOINT");
  assertProductionObjectStorageTransport(input.objectStoragePublicEndpoint, "S3_PUBLIC_ENDPOINT");
  const publicOrigin = parseProductionPublicOrigin(input.publicOrigin, "API_PUBLIC_ORIGIN");
  const objectOrigin = parseProductionPublicOrigin(
    input.objectStoragePublicEndpoint,
    "S3_PUBLIC_ENDPOINT",
  );
  if (publicOrigin === objectOrigin) {
    throw new TypeError("S3_PUBLIC_ENDPOINT 必须与 API_PUBLIC_ORIGIN 使用独立 origin");
  }
  return Object.freeze({
    publicOrigin,
    jwt: Object.freeze({
      issuer: input.issuer,
      audience: input.audience,
      keys: parseProductionJwtSigningKeys(input.signingKeys),
      clockSkewSeconds: input.clockSkewSeconds,
      maxTokenLifetimeSeconds: input.maxTokenLifetimeSeconds,
    }),
    transport: parseProductionApiTransport({
      listenHost: input.listenHost,
      tlsMode: input.tlsMode,
      ...(input.certificatePath === undefined ? {} : { certificatePath: input.certificatePath }),
      ...(input.privateKeyPath === undefined ? {} : { privateKeyPath: input.privateKeyPath }),
      ...(input.trustedProxyCidrs === undefined
        ? {}
        : { trustedProxyCidrs: input.trustedProxyCidrs }),
    }),
  });
}

/** API 会向浏览器交付预签名 URL；生产对象存储入口不得回退到明文 HTTP。 */
function assertProductionObjectStorageTransport(value: string, key: string): void {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "") {
    throw new TypeError(`${key} 在 production 必须为无凭据的 HTTPS URL`);
  }
}

function parseProductionPublicOrigin(value: string, key: string): string {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new TypeError(`${key} 在 production 必须为无凭据 HTTPS origin`);
  }
  return endpoint.origin;
}

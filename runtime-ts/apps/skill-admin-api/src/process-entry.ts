import {
  normalizeDevelopmentLoopbackHost,
  type ProductionApiTransport,
  type ProductionJwtVerificationKey,
  parseProductionApiTransport,
  parseProductionJwtSigningKeys,
} from "@cube-runtime/api";
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
import {
  startDevelopmentSkillAdminApiProcess,
  startProductionSkillAdminApiProcess,
} from "./production-assembly.js";

const optionalEnvironments = [] as const;
const developmentAndTestEnvironments = ["development", "test"] as const;
const productionEnvironment = ["production"] as const;

const skillAdminApiEnvironmentSchema = Object.freeze({
  SKILL_PUBLISHER_DATABASE_URL: urlEnvironmentField({
    secret: true,
    protocols: ["postgres:", "postgresql:"],
    allowCredentials: true,
    maxLength: 8_192,
  }),
  DATABASE_SKILL_PUBLISHER_ROLE: stringEnvironmentField({
    requiredIn: productionEnvironment,
    maxLength: 63,
  }),
  DATABASE_SCHEMA: stringEnvironmentField({ maxLength: 63 }),
  SKILL_ADMIN_JWT_ISSUER: stringEnvironmentField({
    requiredIn: productionEnvironment,
    maxLength: 512,
  }),
  SKILL_ADMIN_JWT_AUDIENCE: stringEnvironmentField({
    requiredIn: productionEnvironment,
    maxLength: 512,
  }),
  SKILL_ADMIN_JWT_SIGNING_KEYS: stringEnvironmentField({
    requiredIn: productionEnvironment,
    secret: true,
    maxLength: 8_192,
  }),
  SKILL_ADMIN_JWT_CLOCK_SKEW_SECONDS: integerEnvironmentField({
    requiredIn: productionEnvironment,
    minimum: 1,
    maximum: 300,
  }),
  SKILL_ADMIN_JWT_MAX_LIFETIME_SECONDS: integerEnvironmentField({
    requiredIn: productionEnvironment,
    minimum: 60,
    maximum: 86_400,
  }),
  SKILL_ADMIN_LISTEN_HOST: stringEnvironmentField({
    requiredIn: productionEnvironment,
    maxLength: 253,
  }),
  SKILL_ADMIN_LISTEN_PORT: integerEnvironmentField({
    requiredIn: productionEnvironment,
    minimum: 1,
    maximum: 65_535,
  }),
  SKILL_ADMIN_TLS_MODE: stringEnvironmentField({
    requiredIn: productionEnvironment,
    maxLength: 6,
  }),
  SKILL_ADMIN_TLS_CERT_PATH: stringEnvironmentField({
    requiredIn: optionalEnvironments,
    maxLength: 4_096,
  }),
  SKILL_ADMIN_TLS_KEY_PATH: stringEnvironmentField({
    requiredIn: optionalEnvironments,
    secret: true,
    maxLength: 4_096,
  }),
  SKILL_ADMIN_TLS_TRUSTED_PROXY_CIDRS: stringEnvironmentField({
    requiredIn: optionalEnvironments,
    maxLength: 4_096,
  }),
  SKILL_PUBLISHER_S3_ENDPOINT: urlEnvironmentField(),
  SKILL_PUBLISHER_S3_BUCKET: stringEnvironmentField({ maxLength: 255 }),
  SKILL_PUBLISHER_S3_REGION: stringEnvironmentField({ maxLength: 128 }),
  SKILL_PUBLISHER_S3_ACCESS_KEY_ID: stringEnvironmentField({
    secret: true,
    maxLength: 1_024,
  }),
  SKILL_PUBLISHER_S3_SECRET_ACCESS_KEY: stringEnvironmentField({
    secret: true,
    maxLength: 4_096,
  }),
  SKILL_PUBLISHER_S3_FORCE_PATH_STYLE: booleanEnvironmentField(),
  DEV_SKILL_ADMIN_USER_ID: stringEnvironmentField({
    requiredIn: developmentAndTestEnvironments,
    maxLength: 128,
  }),
  DEV_SKILL_ADMIN_TOKEN: stringEnvironmentField({
    requiredIn: developmentAndTestEnvironments,
    secret: true,
    maxLength: 512,
  }),
  PROCESS_SHUTDOWN_TIMEOUT_MS: integerEnvironmentField({ minimum: 1, maximum: 600_000 }),
});

export const skillAdminApiProcessEnvironmentKeys = Object.freeze(
  Object.keys(skillAdminApiEnvironmentSchema),
);

export interface SkillAdminApiProcessConfiguration {
  readonly runtimeEnvironment: RuntimeEnvironment;
  readonly databaseUrl: string;
  readonly databaseSsl?: Readonly<{ readonly rejectUnauthorized: true }>;
  readonly databaseSchema: string;
  readonly databaseSkillPublisherRole?: string;
  readonly shutdownTimeoutMilliseconds: number;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly objectStorage: Readonly<{
    readonly endpoint: string;
    readonly bucket: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly forcePathStyle: boolean;
  }>;
  readonly developmentAuth?: Readonly<{
    readonly userId: string;
    readonly token: string;
  }>;
  readonly production?: Readonly<{
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

export function selectSkillAdminApiProcessEnvironment(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string | undefined>> {
  assertProductionInheritedEnvironment(source);
  return selectDeclaredEnvironment(source, skillAdminApiProcessEnvironmentKeys);
}

export function parseSkillAdminApiProcessEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): SkillAdminApiProcessConfiguration {
  assertProductionInheritedEnvironment(source);
  const parsed = parseStrictEnvironment(source, skillAdminApiEnvironmentSchema);
  if (parsed.runtimeEnvironment === "production") assertProductionHasNoDevelopmentAuth(source);

  const configuredDatabaseUrl = readRequiredEnvironmentValue(
    parsed,
    "SKILL_PUBLISHER_DATABASE_URL",
  );
  const productionDatabase =
    parsed.runtimeEnvironment === "production"
      ? parseProductionPostgresTransport(configuredDatabaseUrl)
      : undefined;
  const databaseSchema = readRequiredEnvironmentValue(parsed, "DATABASE_SCHEMA");
  assertPostgresIdentifier(databaseSchema, "DATABASE_SCHEMA");
  const databaseSkillPublisherRole = parsed.values.DATABASE_SKILL_PUBLISHER_ROLE;
  if (databaseSkillPublisherRole !== undefined) {
    assertPostgresIdentifier(databaseSkillPublisherRole, "DATABASE_SKILL_PUBLISHER_ROLE");
  }

  const listenPort = parsed.values.SKILL_ADMIN_LISTEN_PORT ?? 3_002;
  const listenHost =
    parsed.runtimeEnvironment === "production"
      ? readRequiredEnvironmentValue(parsed, "SKILL_ADMIN_LISTEN_HOST")
      : normalizeDevelopmentLoopbackHost(parsed.values.SKILL_ADMIN_LISTEN_HOST ?? "127.0.0.1");
  const objectStorage = Object.freeze({
    endpoint: readRequiredEnvironmentValue(parsed, "SKILL_PUBLISHER_S3_ENDPOINT"),
    bucket: readRequiredEnvironmentValue(parsed, "SKILL_PUBLISHER_S3_BUCKET"),
    region: readRequiredEnvironmentValue(parsed, "SKILL_PUBLISHER_S3_REGION"),
    accessKeyId: readRequiredEnvironmentValue(parsed, "SKILL_PUBLISHER_S3_ACCESS_KEY_ID"),
    secretAccessKey: readRequiredEnvironmentValue(parsed, "SKILL_PUBLISHER_S3_SECRET_ACCESS_KEY"),
    forcePathStyle: readRequiredEnvironmentValue(parsed, "SKILL_PUBLISHER_S3_FORCE_PATH_STYLE"),
  });
  if (parsed.runtimeEnvironment === "production") {
    assertProductionObjectStorageEndpoint(objectStorage.endpoint);
  }

  const developmentAuth =
    parsed.runtimeEnvironment === "production"
      ? undefined
      : Object.freeze({
          userId: readRequiredEnvironmentValue(parsed, "DEV_SKILL_ADMIN_USER_ID"),
          token: readRequiredEnvironmentValue(parsed, "DEV_SKILL_ADMIN_TOKEN"),
        });
  if (developmentAuth !== undefined && !identifierPattern.test(developmentAuth.userId)) {
    throw new TypeError("DEV_SKILL_ADMIN_USER_ID 格式无效");
  }
  const production =
    parsed.runtimeEnvironment === "production"
      ? createProductionConfiguration({
          listenHost,
          issuer: readRequiredEnvironmentValue(parsed, "SKILL_ADMIN_JWT_ISSUER"),
          audience: readRequiredEnvironmentValue(parsed, "SKILL_ADMIN_JWT_AUDIENCE"),
          signingKeys: readRequiredEnvironmentValue(parsed, "SKILL_ADMIN_JWT_SIGNING_KEYS"),
          clockSkewSeconds: readRequiredEnvironmentValue(
            parsed,
            "SKILL_ADMIN_JWT_CLOCK_SKEW_SECONDS",
          ),
          maxTokenLifetimeSeconds: readRequiredEnvironmentValue(
            parsed,
            "SKILL_ADMIN_JWT_MAX_LIFETIME_SECONDS",
          ),
          tlsMode: readRequiredEnvironmentValue(parsed, "SKILL_ADMIN_TLS_MODE"),
          ...(parsed.values.SKILL_ADMIN_TLS_CERT_PATH === undefined
            ? {}
            : { certificatePath: parsed.values.SKILL_ADMIN_TLS_CERT_PATH }),
          ...(parsed.values.SKILL_ADMIN_TLS_KEY_PATH === undefined
            ? {}
            : { privateKeyPath: parsed.values.SKILL_ADMIN_TLS_KEY_PATH }),
          ...(parsed.values.SKILL_ADMIN_TLS_TRUSTED_PROXY_CIDRS === undefined
            ? {}
            : { trustedProxyCidrs: parsed.values.SKILL_ADMIN_TLS_TRUSTED_PROXY_CIDRS }),
        })
      : undefined;

  return Object.freeze({
    runtimeEnvironment: parsed.runtimeEnvironment,
    databaseUrl: productionDatabase?.connectionString ?? configuredDatabaseUrl,
    ...(productionDatabase === undefined ? {} : { databaseSsl: productionDatabase.ssl }),
    databaseSchema,
    ...(databaseSkillPublisherRole === undefined ? {} : { databaseSkillPublisherRole }),
    shutdownTimeoutMilliseconds: readRequiredEnvironmentValue(
      parsed,
      "PROCESS_SHUTDOWN_TIMEOUT_MS",
    ),
    listenHost,
    listenPort,
    objectStorage,
    ...(developmentAuth === undefined ? {} : { developmentAuth }),
    ...(production === undefined ? {} : { production }),
  });
}

export async function startSkillAdminApiProcess(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly assembler?: ServiceAssemblyFactory<SkillAdminApiProcessConfiguration>;
  readonly signalSource?: ProcessSignalSource;
  readonly onShutdownFailure?: (error: Error) => void;
}): Promise<RunningServiceProcess> {
  const configuration = parseSkillAdminApiProcessEnvironment(input.environment);
  const options = {
    ...(input.signalSource === undefined ? {} : { signalSource: input.signalSource }),
    ...(input.onShutdownFailure === undefined
      ? {}
      : { onShutdownFailure: input.onShutdownFailure }),
  };
  if (configuration.runtimeEnvironment === "production") {
    if (input.assembler !== undefined) {
      // 生产入口只能进入模块内固定的 PG/S3/JWT 装配图，调用方 Fake 不得越过此边界。
      throw new Error("PRODUCTION_ASSEMBLY_UNAVAILABLE:skill-admin-api");
    }
    return startProductionSkillAdminApiProcess(configuration, options);
  }
  if (input.assembler === undefined) {
    return startDevelopmentSkillAdminApiProcess(configuration, options);
  }
  return startServiceProcess({
    serviceName: "skill-admin-api",
    configuration,
    shutdownTimeoutMilliseconds: configuration.shutdownTimeoutMilliseconds,
    assembler: input.assembler,
    ...options,
  });
}

const developmentAuthEnvironmentKeys = Object.freeze([
  "DEV_SKILL_ADMIN_USER_ID",
  "DEV_SKILL_ADMIN_TOKEN",
] as const);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const postgresIdentifierPattern = /^[a-z_][a-z0-9_]{0,62}$/u;

function assertProductionHasNoDevelopmentAuth(
  source: Readonly<Record<string, string | undefined>>,
): void {
  const configured = developmentAuthEnvironmentKeys.filter((key) => source[key] !== undefined);
  if (configured.length > 0) {
    throw new EnvironmentConfigurationError(
      configured.map((key) => ({ code: "FORBIDDEN_IN_PRODUCTION" as const, key })),
    );
  }
}

function assertPostgresIdentifier(value: string, key: string): void {
  if (!postgresIdentifierPattern.test(value)) throw new TypeError(`${key} 格式无效`);
}

function assertProductionObjectStorageEndpoint(value: string): void {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "") {
    throw new TypeError("SKILL_PUBLISHER_S3_ENDPOINT 在 production 必须为无凭据的 HTTPS URL");
  }
}

function createProductionConfiguration(input: {
  readonly listenHost: string;
  readonly issuer: string;
  readonly audience: string;
  readonly signingKeys: string;
  readonly clockSkewSeconds: number;
  readonly maxTokenLifetimeSeconds: number;
  readonly tlsMode: string;
  readonly certificatePath?: string;
  readonly privateKeyPath?: string;
  readonly trustedProxyCidrs?: string;
}): NonNullable<SkillAdminApiProcessConfiguration["production"]> {
  if (input.audience === "cube-runtime-api") {
    throw new TypeError("SKILL_ADMIN_JWT_AUDIENCE 必须与普通 API audience 隔离");
  }
  return Object.freeze({
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

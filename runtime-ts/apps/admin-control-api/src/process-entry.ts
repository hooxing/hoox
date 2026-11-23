import {
  parseProductionJwtSigningKeys,
  type ProductionJwtVerificationKey,
} from "@hoox/identity/auth";
import {
  assertProductionInheritedEnvironment,
  booleanEnvironmentField,
  EnvironmentConfigurationError,
  integerEnvironmentField,
  normalizeDevelopmentLoopbackHost,
  parseProductionApiTransport,
  parseProductionPostgresTransport,
  type ProductionApiTransport,
  parseStrictEnvironment,
  readRequiredEnvironmentValue,
  type ProcessSignalSource,
  type RunningServiceProcess,
  type RuntimeEnvironment,
  selectDeclaredEnvironment,
  type ServiceAssemblyFactory,
  startServiceProcess,
  stringEnvironmentField,
  urlEnvironmentField,
} from "@hoox/process-runtime";
import {
  startDevelopmentAdminControlApiProcess,
  startProductionAdminControlApiProcess,
} from "./production-assembly.js";

const optional = [] as const;
const production = ["production"] as const;

const environmentSchema = Object.freeze({
  EVALUATION_POLL_MS: integerEnvironmentField({
    requiredIn: optional,
    minimum: 50,
    maximum: 60000,
  }),
  EVALUATION_GLOBAL_CONCURRENCY: integerEnvironmentField({
    requiredIn: optional,
    minimum: 1,
    maximum: 1024,
  }),
  ADMIN_CONTROL_DATABASE_URL: urlEnvironmentField({
    secret: true,
    protocols: ["postgres:", "postgresql:"],
    allowCredentials: true,
    maxLength: 8_192,
  }),
  SKILL_PUBLISHER_DATABASE_URL: urlEnvironmentField({
    secret: true,
    protocols: ["postgres:", "postgresql:"],
    allowCredentials: true,
    maxLength: 8_192,
  }),
  DATABASE_ADMIN_CONTROL_ROLE: stringEnvironmentField({ requiredIn: production, maxLength: 63 }),
  DATABASE_SKILL_PUBLISHER_ROLE: stringEnvironmentField({
    requiredIn: production,
    maxLength: 63,
  }),
  DATABASE_SCHEMA: stringEnvironmentField({ maxLength: 63 }),
  ADMIN_CONTROL_IDENTITY_API_URL: urlEnvironmentField({ requiredIn: optional }),
  BETTER_AUTH_SECRET: stringEnvironmentField({ secret: true, maxLength: 4096 }),
  ADMIN_CONTROL_LISTEN_HOST: stringEnvironmentField({ requiredIn: production, maxLength: 253 }),
  ADMIN_CONTROL_LISTEN_PORT: integerEnvironmentField({
    requiredIn: production,
    minimum: 1,
    maximum: 65_535,
  }),
  ADMIN_CONTROL_JWT_ISSUER: stringEnvironmentField({ requiredIn: production, maxLength: 512 }),
  ADMIN_CONTROL_JWT_AUDIENCE: stringEnvironmentField({ requiredIn: production, maxLength: 512 }),
  ADMIN_CONTROL_JWT_SIGNING_KEYS: stringEnvironmentField({
    requiredIn: production,
    secret: true,
    maxLength: 8_192,
  }),
  ADMIN_CONTROL_JWT_CLOCK_SKEW_SECONDS: integerEnvironmentField({
    requiredIn: production,
    minimum: 1,
    maximum: 300,
  }),
  ADMIN_CONTROL_JWT_MAX_LIFETIME_SECONDS: integerEnvironmentField({
    requiredIn: production,
    minimum: 60,
    maximum: 86_400,
  }),
  ADMIN_CONTROL_TLS_MODE: stringEnvironmentField({ requiredIn: production, maxLength: 6 }),
  ADMIN_CONTROL_TLS_CERT_PATH: stringEnvironmentField({ requiredIn: optional, maxLength: 4_096 }),
  ADMIN_CONTROL_TLS_KEY_PATH: stringEnvironmentField({
    requiredIn: optional,
    secret: true,
    maxLength: 4_096,
  }),
  ADMIN_CONTROL_TLS_TRUSTED_PROXY_CIDRS: stringEnvironmentField({
    requiredIn: optional,
    maxLength: 4_096,
  }),
  SKILL_PUBLISHER_S3_ENDPOINT: urlEnvironmentField(),
  SKILL_PUBLISHER_S3_BUCKET: stringEnvironmentField({ maxLength: 255 }),
  SKILL_PUBLISHER_S3_REGION: stringEnvironmentField({ maxLength: 128 }),
  SKILL_PUBLISHER_S3_ACCESS_KEY_ID: stringEnvironmentField({ secret: true, maxLength: 1_024 }),
  SKILL_PUBLISHER_S3_SECRET_ACCESS_KEY: stringEnvironmentField({
    secret: true,
    maxLength: 4_096,
  }),
  SKILL_PUBLISHER_S3_FORCE_PATH_STYLE: booleanEnvironmentField(),
  S3_ENDPOINT: urlEnvironmentField(),
  S3_BUCKET: stringEnvironmentField({ maxLength: 255 }),
  S3_REGION: stringEnvironmentField({ maxLength: 128 }),
  S3_ACCESS_KEY_ID: stringEnvironmentField({ secret: true, maxLength: 1_024 }),
  S3_SECRET_ACCESS_KEY: stringEnvironmentField({ secret: true, maxLength: 4_096 }),
  S3_FORCE_PATH_STYLE: booleanEnvironmentField(),
  DEV_ADMIN_CONTROL_USER_ID: stringEnvironmentField({
    requiredIn: optional,
    maxLength: 128,
  }),
  DEV_ADMIN_CONTROL_TOKEN: stringEnvironmentField({
    requiredIn: optional,
    secret: true,
    maxLength: 512,
  }),
  EXTERNAL_TOOLS_ALLOW_PRIVATE_ADDRESSES: booleanEnvironmentField({ requiredIn: optional }),
  WEBHOOK_SECRET_ENCRYPTION_KEY: stringEnvironmentField({
    requiredIn: optional,
    secret: true,
    minLength: 32,
    maxLength: 8192,
  }),
  MODEL_API_KEY: stringEnvironmentField({ requiredIn: optional, secret: true, maxLength: 8_192 }),
  MODEL_CREDENTIAL_ENCRYPTION_KEY: stringEnvironmentField({
    requiredIn: production,
    secret: true,
    maxLength: 4_096,
  }),
  MEM0_API_KEY: stringEnvironmentField({ requiredIn: optional, secret: true, maxLength: 8_192 }),
  MEM0_SCOPE_HMAC_KEY: stringEnvironmentField({
    requiredIn: optional,
    secret: true,
    maxLength: 8_192,
  }),
  THREAD_CONTEXT_COMPACTION_ENABLED: booleanEnvironmentField({ requiredIn: optional }),
  THREAD_CONTEXT_COMPACTION_PATH: stringEnvironmentField({ requiredIn: optional, maxLength: 16 }),
  HISTORY_DIRECTORY_TIME_ZONE: stringEnvironmentField({ requiredIn: optional, maxLength: 100 }),
  PROCESS_SHUTDOWN_TIMEOUT_MS: integerEnvironmentField({ minimum: 1, maximum: 600_000 }),
});

export const adminControlApiProcessEnvironmentKeys = Object.freeze(Object.keys(environmentSchema));

export interface AdminControlApiProcessConfiguration {
  readonly runtimeEnvironment: RuntimeEnvironment;
  readonly externalToolsAllowPrivateAddresses: boolean;
  readonly databaseUrl: string;
  readonly databaseSsl?: Readonly<{ readonly rejectUnauthorized: true }>;
  readonly skillPublisherDatabaseUrl: string;
  readonly skillPublisherDatabaseSsl?: Readonly<{ readonly rejectUnauthorized: true }>;
  readonly databaseSchema: string;
  readonly betterAuthSecret: string;
  readonly evaluationPollMs?: number;
  readonly evaluationGlobalConcurrency?: number;
  readonly identityApiUrl?: string;
  readonly databaseAdminControlRole?: string;
  readonly databaseSkillPublisherRole?: string;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly shutdownTimeoutMilliseconds: number;
  readonly objectStorage: Readonly<{
    readonly endpoint: string;
    readonly bucket: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly forcePathStyle: boolean;
  }>;
  readonly trajectoryObjectStorage: Readonly<{
    readonly endpoint: string;
    readonly bucket: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly forcePathStyle: boolean;
  }>;
  readonly providerSecrets: Readonly<{
    readonly webhookSecretEncryptionKey?: string;
    readonly modelApiKey: string;
    readonly modelCredentialEncryptionKey: string;
    readonly memoryApiKey?: string;
  }>;
  readonly runtimeDeploymentSettings: Readonly<{
    readonly compactionEnabledConfigured: boolean;
    readonly compactionPathConfigured: boolean;
    readonly historyTimeZoneConfigured: boolean;
    readonly memoryScopeKeyConfigured: boolean;
  }>;
  readonly developmentAuth?: Readonly<{ readonly userId: string; readonly token: string }>;
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

export function selectAdminControlApiProcessEnvironment(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string | undefined>> {
  assertProductionInheritedEnvironment(source);
  return selectDeclaredEnvironment(source, adminControlApiProcessEnvironmentKeys);
}

export function parseAdminControlApiProcessEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): AdminControlApiProcessConfiguration {
  assertProductionInheritedEnvironment(source);
  const parsed = parseStrictEnvironment(source, environmentSchema);
  if (parsed.runtimeEnvironment === "production") assertNoDevelopmentAuth(source);
  const configuredDatabaseUrl = readRequiredEnvironmentValue(parsed, "ADMIN_CONTROL_DATABASE_URL");
  const productionDatabase =
    parsed.runtimeEnvironment === "production"
      ? parseProductionPostgresTransport(configuredDatabaseUrl)
      : undefined;
  const configuredSkillPublisherDatabaseUrl = readRequiredEnvironmentValue(
    parsed,
    "SKILL_PUBLISHER_DATABASE_URL",
  );
  const productionSkillPublisherDatabase =
    parsed.runtimeEnvironment === "production"
      ? parseProductionPostgresTransport(configuredSkillPublisherDatabaseUrl)
      : undefined;
  const databaseSchema = readRequiredEnvironmentValue(parsed, "DATABASE_SCHEMA");
  assertIdentifier(databaseSchema, "DATABASE_SCHEMA");
  const databaseAdminControlRole = parsed.values.DATABASE_ADMIN_CONTROL_ROLE;
  if (databaseAdminControlRole !== undefined) {
    assertIdentifier(databaseAdminControlRole, "DATABASE_ADMIN_CONTROL_ROLE");
  }
  const databaseSkillPublisherRole = parsed.values.DATABASE_SKILL_PUBLISHER_ROLE;
  if (databaseSkillPublisherRole !== undefined) {
    assertIdentifier(databaseSkillPublisherRole, "DATABASE_SKILL_PUBLISHER_ROLE");
  }
  const listenHost =
    parsed.runtimeEnvironment === "production"
      ? readRequiredEnvironmentValue(parsed, "ADMIN_CONTROL_LISTEN_HOST")
      : normalizeDevelopmentLoopbackHost(parsed.values.ADMIN_CONTROL_LISTEN_HOST ?? "127.0.0.1");
  const listenPort = parsed.values.ADMIN_CONTROL_LISTEN_PORT ?? 3_003;
  const objectStorage = Object.freeze({
    endpoint: readRequiredEnvironmentValue(parsed, "SKILL_PUBLISHER_S3_ENDPOINT"),
    bucket: readRequiredEnvironmentValue(parsed, "SKILL_PUBLISHER_S3_BUCKET"),
    region: readRequiredEnvironmentValue(parsed, "SKILL_PUBLISHER_S3_REGION"),
    accessKeyId: readRequiredEnvironmentValue(parsed, "SKILL_PUBLISHER_S3_ACCESS_KEY_ID"),
    secretAccessKey: readRequiredEnvironmentValue(parsed, "SKILL_PUBLISHER_S3_SECRET_ACCESS_KEY"),
    forcePathStyle: readRequiredEnvironmentValue(parsed, "SKILL_PUBLISHER_S3_FORCE_PATH_STYLE"),
  });
  const trajectoryObjectStorage = Object.freeze({
    endpoint: readRequiredEnvironmentValue(parsed, "S3_ENDPOINT"),
    bucket: readRequiredEnvironmentValue(parsed, "S3_BUCKET"),
    region: readRequiredEnvironmentValue(parsed, "S3_REGION"),
    accessKeyId: readRequiredEnvironmentValue(parsed, "S3_ACCESS_KEY_ID"),
    secretAccessKey: readRequiredEnvironmentValue(parsed, "S3_SECRET_ACCESS_KEY"),
    forcePathStyle: readRequiredEnvironmentValue(parsed, "S3_FORCE_PATH_STYLE"),
  });
  if (parsed.runtimeEnvironment === "production") {
    assertProductionObjectStorageEndpoint(objectStorage.endpoint);
    assertProductionObjectStorageEndpoint(trajectoryObjectStorage.endpoint);
  }
  const developmentAuth =
    parsed.runtimeEnvironment === "production" ||
    (parsed.values.DEV_ADMIN_CONTROL_USER_ID === undefined &&
      parsed.values.DEV_ADMIN_CONTROL_TOKEN === undefined)
      ? undefined
      : Object.freeze({
          userId: readRequiredEnvironmentValue(parsed, "DEV_ADMIN_CONTROL_USER_ID"),
          token: readRequiredEnvironmentValue(parsed, "DEV_ADMIN_CONTROL_TOKEN"),
        });
  if (developmentAuth !== undefined && !identifierPattern.test(developmentAuth.userId)) {
    throw new TypeError("DEV_ADMIN_CONTROL_USER_ID 格式无效");
  }
  const identityApiUrl = new URL(
    parsed.values.ADMIN_CONTROL_IDENTITY_API_URL ?? "http://127.0.0.1:3001",
  );
  if (
    identityApiUrl.protocol !== "https:" &&
    !(
      identityApiUrl.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(identityApiUrl.hostname)
    )
  )
    throw new TypeError("INVALID:ADMIN_CONTROL_IDENTITY_API_URL");
  const productionConfiguration =
    parsed.runtimeEnvironment === "production"
      ? createProductionConfiguration({
          listenHost,
          issuer: readRequiredEnvironmentValue(parsed, "ADMIN_CONTROL_JWT_ISSUER"),
          audience: readRequiredEnvironmentValue(parsed, "ADMIN_CONTROL_JWT_AUDIENCE"),
          signingKeys: readRequiredEnvironmentValue(parsed, "ADMIN_CONTROL_JWT_SIGNING_KEYS"),
          clockSkewSeconds: readRequiredEnvironmentValue(
            parsed,
            "ADMIN_CONTROL_JWT_CLOCK_SKEW_SECONDS",
          ),
          maxTokenLifetimeSeconds: readRequiredEnvironmentValue(
            parsed,
            "ADMIN_CONTROL_JWT_MAX_LIFETIME_SECONDS",
          ),
          tlsMode: readRequiredEnvironmentValue(parsed, "ADMIN_CONTROL_TLS_MODE"),
          ...(parsed.values.ADMIN_CONTROL_TLS_CERT_PATH === undefined
            ? {}
            : { certificatePath: parsed.values.ADMIN_CONTROL_TLS_CERT_PATH }),
          ...(parsed.values.ADMIN_CONTROL_TLS_KEY_PATH === undefined
            ? {}
            : { privateKeyPath: parsed.values.ADMIN_CONTROL_TLS_KEY_PATH }),
          ...(parsed.values.ADMIN_CONTROL_TLS_TRUSTED_PROXY_CIDRS === undefined
            ? {}
            : { trustedProxyCidrs: parsed.values.ADMIN_CONTROL_TLS_TRUSTED_PROXY_CIDRS }),
        })
      : undefined;
  const betterAuthSecret = readRequiredEnvironmentValue(parsed, "BETTER_AUTH_SECRET");
  if (Buffer.byteLength(betterAuthSecret, "utf8") < 32) {
    throw new TypeError("INVALID:BETTER_AUTH_SECRET");
  }
  return Object.freeze({
    runtimeEnvironment: parsed.runtimeEnvironment,
    externalToolsAllowPrivateAddresses:
      parsed.values.EXTERNAL_TOOLS_ALLOW_PRIVATE_ADDRESSES ?? false,
    databaseUrl: productionDatabase?.connectionString ?? configuredDatabaseUrl,
    ...(productionDatabase === undefined ? {} : { databaseSsl: productionDatabase.ssl }),
    skillPublisherDatabaseUrl:
      productionSkillPublisherDatabase?.connectionString ?? configuredSkillPublisherDatabaseUrl,
    ...(productionSkillPublisherDatabase === undefined
      ? {}
      : { skillPublisherDatabaseSsl: productionSkillPublisherDatabase.ssl }),
    databaseSchema,
    betterAuthSecret,
    evaluationPollMs: parsed.values.EVALUATION_POLL_MS ?? 1000,
    evaluationGlobalConcurrency: parsed.values.EVALUATION_GLOBAL_CONCURRENCY ?? 8,
    identityApiUrl: parsed.values.ADMIN_CONTROL_IDENTITY_API_URL ?? "http://127.0.0.1:3001",
    ...(databaseAdminControlRole === undefined ? {} : { databaseAdminControlRole }),
    ...(databaseSkillPublisherRole === undefined ? {} : { databaseSkillPublisherRole }),
    listenHost,
    listenPort,
    shutdownTimeoutMilliseconds: readRequiredEnvironmentValue(
      parsed,
      "PROCESS_SHUTDOWN_TIMEOUT_MS",
    ),
    objectStorage,
    trajectoryObjectStorage,
    providerSecrets: Object.freeze({
      ...(parsed.values.WEBHOOK_SECRET_ENCRYPTION_KEY === undefined
        ? {}
        : { webhookSecretEncryptionKey: parsed.values.WEBHOOK_SECRET_ENCRYPTION_KEY }),
      modelApiKey: parsed.values.MODEL_API_KEY ?? "",
      modelCredentialEncryptionKey:
        parsed.values.MODEL_CREDENTIAL_ENCRYPTION_KEY ??
        readRequiredEnvironmentValue(parsed, "MODEL_API_KEY"),
      ...(parsed.values.MEM0_API_KEY === undefined
        ? {}
        : { memoryApiKey: parsed.values.MEM0_API_KEY }),
    }),
    runtimeDeploymentSettings: Object.freeze({
      compactionEnabledConfigured: parsed.values.THREAD_CONTEXT_COMPACTION_ENABLED !== undefined,
      compactionPathConfigured: parsed.values.THREAD_CONTEXT_COMPACTION_PATH !== undefined,
      historyTimeZoneConfigured: parsed.values.HISTORY_DIRECTORY_TIME_ZONE !== undefined,
      memoryScopeKeyConfigured: parsed.values.MEM0_SCOPE_HMAC_KEY !== undefined,
    }),
    ...(developmentAuth === undefined ? {} : { developmentAuth }),
    ...(productionConfiguration === undefined ? {} : { production: productionConfiguration }),
  });
}

export async function startAdminControlApiProcess(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly assembler?: ServiceAssemblyFactory<AdminControlApiProcessConfiguration>;
  readonly signalSource?: ProcessSignalSource;
  readonly onShutdownFailure?: (error: Error) => void;
}): Promise<RunningServiceProcess> {
  const configuration = parseAdminControlApiProcessEnvironment(input.environment);
  const options = {
    ...(input.signalSource === undefined ? {} : { signalSource: input.signalSource }),
    ...(input.onShutdownFailure === undefined
      ? {}
      : { onShutdownFailure: input.onShutdownFailure }),
  };
  if (configuration.runtimeEnvironment === "production") {
    if (input.assembler !== undefined) {
      throw new Error("PRODUCTION_ASSEMBLY_UNAVAILABLE:admin-control-api");
    }
    return startProductionAdminControlApiProcess(configuration, options);
  }
  if (input.assembler === undefined)
    return startDevelopmentAdminControlApiProcess(configuration, options);
  return startServiceProcess({
    serviceName: "admin-control-api",
    configuration,
    shutdownTimeoutMilliseconds: configuration.shutdownTimeoutMilliseconds,
    assembler: input.assembler,
    ...options,
  });
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const postgresIdentifierPattern = /^[a-z_][a-z0-9_]{0,62}$/u;
const developmentKeys = ["DEV_ADMIN_CONTROL_USER_ID", "DEV_ADMIN_CONTROL_TOKEN"] as const;

function assertNoDevelopmentAuth(source: Readonly<Record<string, string | undefined>>): void {
  const configured = developmentKeys.filter((key) => source[key] !== undefined);
  if (configured.length > 0) {
    throw new EnvironmentConfigurationError(
      configured.map((key) => ({ code: "FORBIDDEN_IN_PRODUCTION" as const, key })),
    );
  }
}

function assertIdentifier(value: string, key: string): void {
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
}): NonNullable<AdminControlApiProcessConfiguration["production"]> {
  if (input.audience === "hoox-api" || input.audience === "hoox-skill-admin-api") {
    throw new TypeError("ADMIN_CONTROL_JWT_AUDIENCE 必须使用独立 audience");
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

import { evaluationCommandClient, startEvaluationLoop } from "./evaluation-loop.js";
import { createAdminSessionAuthResolver } from "./session-auth.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  AdminControlService,
  ExternalToolAdminService,
  type DeploymentSettingDescriptor,
  type MemoryProviderConfiguration,
  type ModelProviderConfiguration,
  type ProviderProbePort,
  RunExplorerService,
} from "@hoox/admin-control";
import { userId } from "@hoox/domain";
import { type AuthContextResolver, createProductionJwtAuthResolver } from "@hoox/identity/auth";
import {
  ModelProviderCredentialCipher,
  ExternalToolCredentialCipher,
  ExternalToolDraftCredentialCipher,
  PgExternalToolAdminRepository,
  PgAdminControlRepository,
  PgIntegrationAdminRepository,
  PgAdminRunExplorerRepository,
  PgAgentDefinitionRepository,
  PgEvaluationRepository,
  PgEvaluationDriver,
  PgIdentityConfigurationRepository,
  PgSandboxControlRepository,
  PgSkillPublicationAuthorization,
  PgSkillPublicationRepository,
  probeS3StableSkillPublisher,
  S3StableSkillPublisher,
} from "@hoox/persistence/admin";
import {
  createS3BlobStore,
  PgBlobLifecycleRepository,
  RUNTIME_BLOB_OBJECT_PREFIX,
} from "@hoox/persistence/blob";
import { PgRunTrajectoryStore } from "@hoox/persistence/trajectory";
import { createPostgresPool, probePostgres, WebhookSecretCipher } from "@hoox/persistence/postgres";
import {
  loadProductionTlsCredentials,
  type ProcessSignalSource,
  productionTrustProxy,
  type ServiceAssemblyFactory,
  startServiceProcess,
} from "@hoox/process-runtime";
import { probeConfiguredSandbox } from "@hoox/sandbox";
import { previewHttpToolDeclaration, probeMcpEndpoint } from "@hoox/tool-router";
import { SkillPublicationService } from "@hoox/skill";
import { type AdminControlApiAppOptions, createAdminControlApiApp } from "./app.js";
import { createIdentityAdminService } from "./identity-configuration.js";
import { createPiModelCatalog } from "./pi-model-catalog.js";
import type { AdminControlApiProcessConfiguration } from "./process-entry.js";

interface ProcessOptions {
  readonly signalSource?: ProcessSignalSource;
  readonly onShutdownFailure?: (error: Error) => void;
}

const productionAssembler: ServiceAssemblyFactory<AdminControlApiProcessConfiguration> = {
  async assemble(configuration) {
    if (
      configuration.runtimeEnvironment !== "production" ||
      configuration.production === undefined ||
      configuration.developmentAuth !== undefined ||
      configuration.databaseAdminControlRole === undefined ||
      configuration.databaseSkillPublisherRole === undefined ||
      configuration.databaseSsl === undefined ||
      configuration.skillPublisherDatabaseSsl === undefined
    ) {
      throw new Error("PRODUCTION_ADMIN_CONTROL_ASSEMBLY_FORBIDDEN");
    }
    const tls = await loadProductionTlsCredentials(configuration.production.transport);
    return assembleRealService(configuration, {
      auth: createAdminSessionAuthResolver(
        configuration.identityApiUrl ?? "http://127.0.0.1:3001",
        createProductionJwtAuthResolver(configuration.production.jwt),
      ),
      appOptions: {
        logger: true,
        trustProxy: productionTrustProxy(configuration.production.transport),
        ...(tls === undefined ? {} : { https: tls }),
      },
      expectedRole: configuration.databaseAdminControlRole,
      expectedPublisherRole: configuration.databaseSkillPublisherRole,
      applicationName: "hoox-admin-control-api-production",
    });
  },
};

const developmentAssembler: ServiceAssemblyFactory<AdminControlApiProcessConfiguration> = {
  async assemble(configuration) {
    if (
      configuration.runtimeEnvironment === "production" ||
      configuration.production !== undefined ||
      configuration.databaseSsl !== undefined
    ) {
      throw new Error("DEVELOPMENT_ADMIN_CONTROL_ASSEMBLY_FORBIDDEN");
    }
    return assembleRealService(configuration, {
      auth: createAdminSessionAuthResolver(
        configuration.identityApiUrl ?? "http://127.0.0.1:3001",
        configuration.developmentAuth === undefined ? undefined : developmentAuth(configuration),
      ),
      appOptions: { logger: false, trustProxy: false },
      ...(configuration.databaseAdminControlRole === undefined
        ? {}
        : { expectedRole: configuration.databaseAdminControlRole }),
      ...(configuration.databaseSkillPublisherRole === undefined
        ? {}
        : { expectedPublisherRole: configuration.databaseSkillPublisherRole }),
      applicationName: "hoox-admin-control-api-development",
    });
  },
};

async function assembleRealService(
  configuration: AdminControlApiProcessConfiguration,
  input: {
    readonly auth: AuthContextResolver;
    readonly appOptions: AdminControlApiAppOptions;
    readonly expectedRole?: string;
    readonly expectedPublisherRole?: string;
    readonly applicationName: string;
  },
) {
  const controlPool = createPostgresPool({
    connectionString: configuration.databaseUrl,
    ...(configuration.databaseSsl === undefined ? {} : { ssl: configuration.databaseSsl }),
    schema: configuration.databaseSchema,
    ...(input.expectedRole === undefined ? {} : { expectedRuntimeRole: input.expectedRole }),
    applicationName: input.applicationName,
  });
  const skillPublisherPool = createPostgresPool({
    connectionString: configuration.skillPublisherDatabaseUrl,
    ...(configuration.skillPublisherDatabaseSsl === undefined
      ? {}
      : { ssl: configuration.skillPublisherDatabaseSsl }),
    schema: configuration.databaseSchema,
    ...(input.expectedPublisherRole === undefined
      ? {}
      : { expectedRuntimeRole: input.expectedPublisherRole }),
    applicationName: `${input.applicationName}-skill-publisher`,
  });
  let publisher: S3StableSkillPublisher | undefined;
  let app: ReturnType<typeof createAdminControlApiApp> | undefined;
  try {
    publisher = new S3StableSkillPublisher({
      endpoint: configuration.objectStorage.endpoint,
      bucket: configuration.objectStorage.bucket,
      region: configuration.objectStorage.region,
      accessKeyId: configuration.objectStorage.accessKeyId,
      secretAccessKey: configuration.objectStorage.secretAccessKey,
      forcePathStyle: configuration.objectStorage.forcePathStyle,
    });
    const activePublisher = publisher;
    const repository = new PgAdminControlRepository(
      controlPool,
      new ModelProviderCredentialCipher(configuration.providerSecrets.modelCredentialEncryptionKey),
      configuration.providerSecrets.modelApiKey,
    );
    const trajectoryBlobs = createS3BlobStore(
      {
        ...configuration.trajectoryObjectStorage,
        prefix: RUNTIME_BLOB_OBJECT_PREFIX,
        maxBlobSizeBytes: 32 * 1024 * 1024,
      },
      new PgBlobLifecycleRepository(controlPool, { objectPrefix: RUNTIME_BLOB_OBJECT_PREFIX }),
    );
    const trajectoryStore = new PgRunTrajectoryStore(controlPool, trajectoryBlobs, undefined, 30);
    const controlPostgresProbe = () => probePostgres(controlPool, input.expectedRole);
    const skillPostgresProbe = () => probePostgres(skillPublisherPool, input.expectedPublisherRole);
    const objectStorageProbe = () => probeS3StableSkillPublisher(activePublisher);
    const sandboxRepository = new PgSandboxControlRepository(
      controlPool,
      new ModelProviderCredentialCipher(configuration.providerSecrets.modelCredentialEncryptionKey),
    );
    const explorer = new PgAdminRunExplorerRepository(controlPool);
    const publications = new SkillPublicationService(
      new PgSkillPublicationAuthorization(skillPublisherPool),
      new PgSkillPublicationRepository(skillPublisherPool, activePublisher),
    );
    const dependencies = {
      integrations: new PgIntegrationAdminRepository(
        controlPool,
        configuration.providerSecrets.webhookSecretEncryptionKey === undefined
          ? undefined
          : new WebhookSecretCipher(configuration.providerSecrets.webhookSecretEncryptionKey),
      ),
      sandbox: {
        overview: sandboxRepository.overview.bind(sandboxRepository),
        saveProfile: sandboxRepository.saveProfile.bind(sandboxRepository),
        publishRouting: sandboxRepository.publishRouting.bind(sandboxRepository),
        probeProfile: (
          userId: string,
          providerKey: Parameters<typeof sandboxRepository.probeProfile>[1],
          revision: number,
        ) =>
          sandboxRepository.probeProfile(userId, providerKey, revision, async (profile, apiKey) =>
            probeConfiguredSandbox({
              providerKey: profile.providerKey,
              endpoint: profile.endpoint,
              ...(profile.cubeProxy === undefined ? {} : { cubeProxy: profile.cubeProxy }),
              ...(apiKey === undefined ? {} : { apiKey }),
              ...profile.policy,
            }),
          ),
      },
      externalTools: new ExternalToolAdminService(
        new PgExternalToolAdminRepository(
          controlPool,
          new ExternalToolCredentialCipher(
            configuration.providerSecrets.modelCredentialEncryptionKey,
          ),
          new ExternalToolDraftCredentialCipher(
            configuration.providerSecrets.modelCredentialEncryptionKey,
          ),
        ),
        (input) => probeMcpEndpoint(input, configuration.externalToolsAllowPrivateAddresses),
        (input) => {
          const { credentialRef: _credentialRef, ...preview } = previewHttpToolDeclaration(input);
          return { ...preview, publishable: false };
        },
      ),
      agents: new PgAgentDefinitionRepository(controlPool),
      evaluations: new PgEvaluationRepository(controlPool),
      runs: new RunExplorerService(
        explorer,
        () => `run_content_${randomUUID().replaceAll("-", "")}`,
        trajectoryStore,
      ),
      auth: input.auth,
      identity: createIdentityAdminService({
        repository: new PgIdentityConfigurationRepository(controlPool),
        roles: repository,
        secret: configuration.betterAuthSecret,
      }),
      control: new AdminControlService(
        repository,
        repository,
        createProviderProbes(configuration),
        deploymentSettings(configuration),
        configuration.runtimeEnvironment,
      ),
      modelCatalog: createPiModelCatalog(),
      skills: {
        publications,
      },
      skillNamespaces: publications,
      readiness: {
        probe: async () => {
          await controlPostgresProbe();
          // 发布角色失效时不得继续携带对象存储凭据探测 MinIO/S3。
          await skillPostgresProbe();
          await objectStorageProbe();
        },
      },
    };
    app = createAdminControlApiApp(dependencies, input.appOptions);
    await dependencies.readiness.probe();
    await app.listen({ host: configuration.listenHost, port: configuration.listenPort });
    const listeningApp = app;
    const pollMs = configuration.evaluationPollMs ?? 1000;
    const stopLoop = startEvaluationLoop(
      new PgEvaluationDriver(
        controlPool,
        evaluationCommandClient(configuration.identityApiUrl ?? "http://127.0.0.1:3001"),
        (user, tenant, run) => explorer.evaluationEvidence(user, tenant, run),
        { pollMs, globalLimit: configuration.evaluationGlobalConcurrency ?? 8, leaseMs: 30000 },
      ),
      pollMs,
    );
    return Object.freeze({
      stopAccepting: async () => {
        await Promise.all([stopLoop(), listeningApp.close()]);
      },
      resources: Object.freeze([
        { name: "object-storage", close: async () => activePublisher.close() },
        { name: "skill-publisher-postgres", close: () => skillPublisherPool.end() },
        { name: "admin-control-postgres", close: () => controlPool.end() },
      ]),
      readiness: Object.freeze([
        { name: "admin-control-postgres", probe: controlPostgresProbe },
        { name: "skill-publisher-postgres", probe: skillPostgresProbe },
        { name: "object-storage", probe: objectStorageProbe },
      ]),
    });
  } catch (error) {
    if (app !== undefined) await app.close().catch(() => undefined);
    if (publisher !== undefined) {
      try {
        publisher.close();
      } catch {
        // S3 客户端关闭失败不能阻止两个 PG pool 的启动失败清理。
      }
    }
    await skillPublisherPool.end().catch(() => undefined);
    await controlPool.end().catch(() => undefined);
    throw error;
  }
}

export function createProviderProbes(
  configuration: AdminControlApiProcessConfiguration,
): ProviderProbePort {
  return Object.freeze({
    probeModel: async (model: ModelProviderConfiguration, apiKey: string) => {
      const base = new URL(model.baseUrl);
      const endpoint = new URL(
        "chat/completions",
        base.href.endsWith("/") ? base : `${base.href}/`,
      );
      const configuredModel = model.models.find(
        (candidate) => candidate.id === model.defaultModelId && candidate.enabled,
      );
      if (configuredModel === undefined) throw new Error("MODEL_CONFIGURATION_INVALID");
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: model.defaultModelId,
          messages: [{ role: "user", content: "Reply with OK." }],
          max_tokens: Math.min(configuredModel.maxTokens, 32),
          stream: false,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error("MODEL_PROVIDER_UNAVAILABLE");
      const payload = JSON.parse(await readBoundedText(response, 64 * 1024)) as unknown;
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("choices" in payload) ||
        !Array.isArray(payload.choices) ||
        !payload.choices.some((choice) => {
          if (typeof choice !== "object" || choice === null || !("message" in choice)) return false;
          const message = choice.message;
          if (typeof message !== "object" || message === null) return false;
          const content = "content" in message ? message.content : undefined;
          const reasoning = "reasoning_content" in message ? message.reasoning_content : undefined;
          return typeof content === "string" || typeof reasoning === "string";
        })
      ) {
        throw new Error("MODEL_RESPONSE_MISMATCH");
      }
    },
    probeMemory: async (memory: MemoryProviderConfiguration, managedApiKey?: string) => {
      const apiKey =
        memory.apiSecretRef === "managed:memory-api"
          ? managedApiKey
          : configuration.providerSecrets.memoryApiKey;
      if (apiKey === undefined) throw new Error("MEMORY_SECRET_UNAVAILABLE");
      const response = await fetch(new URL(memory.baseUrl), {
        method: "HEAD",
        headers: { authorization: `Token ${apiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(memory.requestTimeoutMs),
      });
      if (!response.ok) {
        throw new Error("MEMORY_PROVIDER_UNAVAILABLE");
      }
      await response.body?.cancel();
    },
  });
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error("PROVIDER_RESPONSE_TOO_LARGE");
    }
    chunks.push(item.value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(merged);
}

function deploymentSettings(
  configuration: AdminControlApiProcessConfiguration,
): readonly DeploymentSettingDescriptor[] {
  return Object.freeze([
    descriptor(
      "ADMIN_CONTROL_DATABASE_URL",
      "bootstrap",
      true,
      "后台控制面数据库连接，仅部署时修改",
    ),
    descriptor(
      "DATABASE_ADMIN_CONTROL_ROLE",
      "bootstrap",
      configuration.databaseAdminControlRole !== undefined,
      "后台控制面最小权限数据库角色",
    ),
    descriptor(
      "SKILL_PUBLISHER_DATABASE_URL",
      "bootstrap",
      true,
      "Skill 发布专用数据库连接，与控制面角色隔离",
    ),
    descriptor(
      "DATABASE_SKILL_PUBLISHER_ROLE",
      "bootstrap",
      configuration.databaseSkillPublisherRole !== undefined,
      "Skill 发布最小权限数据库角色",
    ),
    descriptor(
      "SKILL_PUBLISHER_S3_*",
      "secret",
      true,
      "Skill 发布对象存储凭据，只能通过部署系统轮换",
    ),
    descriptor(
      "ADMIN_CONTROL_JWT_SIGNING_KEYS",
      "secret",
      configuration.production !== undefined,
      "管理身份签名密钥，只能轮换部署",
    ),
    descriptor(
      "MODEL_CREDENTIAL_ENCRYPTION_KEY",
      "secret",
      true,
      "模型与记忆凭据的稳定平台主密钥，不能调用任何 Provider",
    ),
    descriptor("MODEL_API_KEY", "secret", true, "没有 active 模型配置时的兼容回退凭据"),
    descriptor(
      "MEM0_API_KEY",
      "secret",
      configuration.providerSecrets.memoryApiKey !== undefined,
      "记忆 Provider 兼容回退密钥，日常可在后台配置托管密钥",
    ),
    descriptor(
      "MEM0_SCOPE_HMAC_KEY",
      "secret",
      configuration.runtimeDeploymentSettings.memoryScopeKeyConfigured,
      "既有 Mem0 用户作用域密钥，迁移 API Key 后须保持稳定；新部署可由平台派生",
    ),
    descriptor(
      "THREAD_CONTEXT_COMPACTION_ENABLED",
      "restart_required",
      configuration.runtimeDeploymentSettings.compactionEnabledConfigured,
      "Runtime compaction 总开关；百分比和预算可在线保存，该开关需要重新部署",
    ),
    descriptor(
      "THREAD_CONTEXT_COMPACTION_PATH",
      "restart_required",
      configuration.runtimeDeploymentSettings.compactionPathConfigured,
      "Runtime compaction 执行路径，需要重新部署",
    ),
    descriptor(
      "HISTORY_DIRECTORY_TIME_ZONE",
      "restart_required",
      configuration.runtimeDeploymentSettings.historyTimeZoneConfigured,
      "历史目录和定时任务时区，需要重新部署",
    ),
  ]);
}

function descriptor(
  key: string,
  category: DeploymentSettingDescriptor["category"],
  configured: boolean,
  description: string,
): DeploymentSettingDescriptor {
  return Object.freeze({
    key,
    category,
    source: "environment",
    configured,
    mutable: false,
    description,
  });
}

function developmentAuth(configuration: AdminControlApiProcessConfiguration): AuthContextResolver {
  if (
    configuration.runtimeEnvironment === "production" ||
    configuration.developmentAuth === undefined
  ) {
    throw new Error("DEVELOPMENT_ADMIN_CONTROL_AUTH_FORBIDDEN");
  }
  const accepted = Buffer.from(`Bearer ${configuration.developmentAuth.token}`, "utf8");
  const principal = Object.freeze({ userId: userId(configuration.developmentAuth.userId) });
  return Object.freeze({
    resolve: async (request: { readonly authorization: string | undefined }) => {
      if (request.authorization === undefined) return undefined;
      const presented = Buffer.from(request.authorization, "utf8");
      return presented.byteLength === accepted.byteLength && timingSafeEqual(presented, accepted)
        ? principal
        : undefined;
    },
  });
}

export function startProductionAdminControlApiProcess(
  configuration: AdminControlApiProcessConfiguration,
  options: ProcessOptions = {},
) {
  return startServiceProcess({
    serviceName: "admin-control-api",
    configuration,
    shutdownTimeoutMilliseconds: configuration.shutdownTimeoutMilliseconds,
    assembler: productionAssembler,
    ...(options.signalSource === undefined ? {} : { signalSource: options.signalSource }),
    ...(options.onShutdownFailure === undefined
      ? {}
      : { onShutdownFailure: options.onShutdownFailure }),
  });
}

export function startDevelopmentAdminControlApiProcess(
  configuration: AdminControlApiProcessConfiguration,
  options: ProcessOptions = {},
) {
  return startServiceProcess({
    serviceName: "admin-control-api",
    configuration,
    shutdownTimeoutMilliseconds: configuration.shutdownTimeoutMilliseconds,
    assembler: developmentAssembler,
    ...(options.signalSource === undefined ? {} : { signalSource: options.signalSource }),
    ...(options.onShutdownFailure === undefined
      ? {}
      : { onShutdownFailure: options.onShutdownFailure }),
  });
}

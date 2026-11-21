import { WebhookSecretCipher } from "@hoox/persistence/postgres";
import { randomUUID } from "node:crypto";
import { isoTimestamp, runId, threadId, workspaceId } from "@hoox/domain";
import {
  type CreateS3BlobStoreConfig,
  createS3BlobStore,
  DurableResourceBlobWriter,
  probeS3BlobStore,
  RUNTIME_BLOB_OBJECT_PREFIX,
} from "@hoox/persistence/blob";
import { createApiPersistenceRuntime, PgInstallationRepository } from "@hoox/persistence/postgres";
import { BlobSkillContentStore, DurableResourceUploadBlobAdapter } from "@hoox/persistence/thread";
import { type ServiceAssemblyFactory, startServiceProcess } from "@hoox/process-runtime";
import {
  createResourceFilesystemCapabilityCodec,
  HistoryFileLibraryService,
  ResourceAttachmentResolver,
  ResourceUploadService,
} from "@hoox/resource";
import { SkillCenterService } from "@hoox/skill";
import { createApiApp } from "./app.js";
import { createApiCreateCapability } from "./capabilities.js";
import { createThreadCursorCodec, parseThreadCursorSigningKeys } from "./cursor.js";
import { createEmbeddedIdentityAuthService } from "./embedded-identity-auth.js";
import { createLocalAccountAuthService } from "./local-account-auth.js";
import type { AuthContextResolver } from "./ports.js";
import type { ApiProcessConfiguration } from "./process-entry.js";
import { createProductionJwtAuthResolver } from "@hoox/identity/auth";
import { loadProductionTlsCredentials, productionTrustProxy } from "@hoox/process-runtime";

const cursorTtlMilliseconds = 15 * 60_000;
const cursorMaximumTtlMilliseconds = 60 * 60_000;
// 生产 HTTP API 只交付已完整校验的小对象；该边界独立于开发 fixture，避免把 provider 流直接暴露给浏览器。
const productionApiMaxBlobSizeBytes = 16 * 1_024 * 1_024;
const productionApiMaxSkillBlobSizeBytes = 32 * 1_024 * 1_024;

/**
 * 真正的生产依赖图只在此模块构造：PostgreSQL、S3、HS256 JWT 与受限 TLS/proxy listener 缺一不可。
 * assembler 本体不进入应用公开入口；process-entry 的 production 分支固定选择该依赖图。
 */
const productionApiAssembler: ServiceAssemblyFactory<ApiProcessConfiguration> = {
  async assemble(configuration) {
    if (
      configuration.runtimeEnvironment !== "production" ||
      configuration.production === undefined ||
      configuration.developmentPrincipals !== undefined ||
      configuration.databaseRuntimeRole === undefined ||
      configuration.databaseTeamCoordinatorRole === undefined ||
      configuration.databaseSsl === undefined ||
      configuration.databaseTeamCoordinatorSsl === undefined
    ) {
      throw new Error("PRODUCTION_API_ASSEMBLY_FORBIDDEN");
    }
    const persistence = createApiPersistenceRuntime({
      connectionString: configuration.databaseUrl,
      ssl: configuration.databaseSsl,
      schema: configuration.databaseSchema,
      expectedRuntimeRole: configuration.databaseRuntimeRole,
      applicationName: "hoox-api-production",
      teamCoordinator: {
        connectionString: configuration.databaseTeamCoordinatorUrl,
        ssl: configuration.databaseTeamCoordinatorSsl,
        schema: configuration.databaseSchema,
        expectedRuntimeRole: configuration.databaseTeamCoordinatorRole,
        applicationName: "hoox-api-team-coordinator-production",
      },
      serialQueueV2Enabled: configuration.serialQueueV2Enabled,
      historyDirectoryTimeZone: configuration.historyDirectoryTimeZone,
      historyFilesystemEnabled: configuration.historyFilesystemEnabled,
      historyTitleGenerationEnabled: configuration.historyTitleGenerationEnabled,
      // PG 签发的 canonical physicalObjectKey 必须与 S3 客户端使用同一持久前缀。
      blobLifecycle: { objectPrefix: RUNTIME_BLOB_OBJECT_PREFIX },
    });
    let app: ReturnType<typeof createApiApp> | undefined;
    try {
      const clock = Object.freeze({ now: () => isoTimestamp(new Date().toISOString()) });
      const objectStorage: CreateS3BlobStoreConfig = Object.freeze({
        endpoint: configuration.objectStorage.endpoint,
        publicEndpoint: configuration.objectStorage.publicEndpoint,
        bucket: configuration.objectStorage.bucket,
        region: configuration.objectStorage.region,
        accessKeyId: configuration.objectStorage.accessKeyId,
        secretAccessKey: configuration.objectStorage.secretAccessKey,
        forcePathStyle: configuration.objectStorage.forcePathStyle,
        prefix: RUNTIME_BLOB_OBJECT_PREFIX,
        maxBlobSizeBytes: productionApiMaxBlobSizeBytes,
      });
      const probes = Object.freeze({
        postgres: () => persistence.probe(),
        objectStorage: () => probeS3BlobStore(objectStorage),
      });
      const transport = configuration.production.transport;
      const tls = await loadProductionTlsCredentials(transport);
      const cursorCodec = createThreadCursorCodec({
        activeKid: configuration.cursorActiveKeyId,
        keys: parseThreadCursorSigningKeys(configuration.cursorSigningKeys),
        clock,
        ttlMilliseconds: cursorTtlMilliseconds,
        maximumTtlMilliseconds: cursorMaximumTtlMilliseconds,
      });
      const blobs = createS3BlobStore(objectStorage, persistence.blobLifecycle);
      const skillBlobs = createS3BlobStore(
        { ...objectStorage, maxBlobSizeBytes: productionApiMaxSkillBlobSizeBytes },
        persistence.blobLifecycle,
      );
      const resourceFilesystemCapabilities = createResourceFilesystemCapabilityCodec({
        secret: configuration.resourceFilesystemSigningKey,
      });
      const resourceUploads = new ResourceUploadService(
        new DurableResourceUploadBlobAdapter(
          new DurableResourceBlobWriter(
            persistence.blobLifecycle,
            blobs,
            productionApiMaxBlobSizeBytes,
          ),
        ),
        persistence.resourceUploads,
        { maxBytes: productionApiMaxBlobSizeBytes, now: clock.now },
      );
      const localAccounts = createLocalAccountAuthService({
        repository: persistence.localAccounts,
        clock,
      });
      const jwtAuth = createProductionJwtAuthResolver(configuration.production.jwt);
      const embeddedIdentity = createEmbeddedIdentityAuthService({
        database: persistence.identityDatabase,
        configurations: persistence.identityConfigurations,
        localAccounts,
        baseURL: configuration.identityAuth.baseURL,
        secret: configuration.identityAuth.secret,
        trustedOrigins: configuration.identityAuth.trustedOrigins,
      });
      const auth: AuthContextResolver = Object.freeze({
        resolve: async (context: Parameters<AuthContextResolver["resolve"]>[0]) =>
          (await localAccounts.resolve(context)) ?? (await jwtAuth.resolve(context)),
      });
      app = createApiApp(
        {
          auth,
          localAccounts,
          installation: {
            repository: new PgInstallationRepository(persistence.identityDatabase),
            administratorAccounts: createLocalAccountAuthService({
              repository: persistence.localAccounts,
              clock,
              initialAdministrator: true,
            }),
            runtimeEnvironment: configuration.runtimeEnvironment,
            ...(configuration.installationSetupToken === undefined
              ? {}
              : { setupToken: configuration.installationSetupToken }),
          },
          localAccountPasswordRoutes: false,
          embeddedIdentity,
          ...(configuration.demoAdminUserId === undefined
            ? {}
            : { demoAdminUserId: configuration.demoAdminUserId }),
          repositories: persistence.repositories,
          agentDefinitions: persistence.agentDefinitions,
          playground: persistence.playground,
          apiKeys: persistence.apiKeys,
          webhooks: persistence.webhooks,
          ...(configuration.webhookSecretEncryptionKey === undefined
            ? {}
            : { webhookCipher: new WebhookSecretCipher(configuration.webhookSecretEncryptionKey) }),
          personalizations: persistence.personalizations,
          scheduledTasks: persistence.scheduledTasks,
          ...(persistence.teamCollaboration === undefined
            ? {}
            : { teamCollaboration: persistence.teamCollaboration }),
          threadForks: persistence.threadForks,
          createCapability: createApiCreateCapability({
            threadCreation: persistence.threadCreation,
            enqueueOutbox: persistence.runDispatchCreation,
            ...(configuration.threadInputRoutingV2Enabled
              ? { threadInputs: persistence.threadInputs }
              : {}),
          }),
          archiveThread: persistence.archiveThread,
          renamePersonalThread: persistence.renamePersonalThread,
          experience: persistence.experience,
          modelWireTraces: persistence.modelWireTraces,
          blobs,
          resourceUploads,
          resourceAttachments: new ResourceAttachmentResolver(persistence.resourceCatalog),
          ...(configuration.historyFilesystemEnabled
            ? { historyFiles: new HistoryFileLibraryService(persistence.resourceFilesystem) }
            : {}),
          skillCenter: new SkillCenterService(persistence.skillCenter),
          resourceFilesystem: {
            catalog: persistence.resourceFilesystem,
            capabilities: resourceFilesystemCapabilities,
            ...(configuration.historyFilesystemEnabled
              ? { history: persistence.resourceFilesystem }
              : {}),
            skills: {
              catalog: persistence.skillFilesystem,
              contents: new BlobSkillContentStore(skillBlobs),
            },
          },
          ...(configuration.threadContextV2ReadEnabled
            ? {
                threadContext: persistence.threadContext(blobs),
                threadContinuity: persistence.threadContinuity,
              }
            : {}),
          cursorCodec,
          readiness: Object.freeze({
            probe: async () => {
              await Promise.all([probes.postgres(), probes.objectStorage()]);
            },
          }),
          clock,
          ids: Object.freeze({
            thread: () => threadId(`thread_${randomUUID()}`),
            run: () => runId(`run_${randomUUID()}`),
            workspace: () => workspaceId(`workspace_${randomUUID()}`),
          }),
        },
        {
          logger: true,
          trustProxy: productionTrustProxy(transport),
          ...(tls === undefined ? {} : { https: tls }),
        },
      );
      await probes.postgres();
      await probes.objectStorage();
      await app.listen({ host: configuration.listenHost, port: configuration.listenPort });
      const listeningApp = app;
      return Object.freeze({
        // Fastify close 先停止 listener，再等待已经进入 handler 的请求完成。
        stopAccepting: () => listeningApp.close(),
        resources: Object.freeze([
          Object.freeze({ name: "postgres", close: () => persistence.close() }),
        ]),
        readiness: Object.freeze([
          Object.freeze({ name: "postgres", probe: probes.postgres }),
          Object.freeze({ name: "object-storage", probe: probes.objectStorage }),
        ]),
      });
    } catch (error) {
      if (app !== undefined) await app.close().catch(() => undefined);
      await persistence.close().catch(() => undefined);
      throw error;
    }
  },
};

export function startProductionApiProcess(
  configuration: ApiProcessConfiguration,
  options: Readonly<{
    signalSource?: import("@hoox/process-runtime").ProcessSignalSource;
    onShutdownFailure?: (error: Error) => void;
  }> = {},
) {
  return startServiceProcess({
    serviceName: "api",
    configuration,
    shutdownTimeoutMilliseconds: configuration.shutdownTimeoutMilliseconds,
    assembler: productionApiAssembler,
    ...(options.signalSource === undefined ? {} : { signalSource: options.signalSource }),
    ...(options.onShutdownFailure === undefined
      ? {}
      : { onShutdownFailure: options.onShutdownFailure }),
  });
}

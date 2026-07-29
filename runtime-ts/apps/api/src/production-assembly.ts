import { randomUUID } from "node:crypto";
import { isoTimestamp, runId, threadId, workspaceId } from "@cube-runtime/domain";
import {
  createApiPersistenceRuntime,
  createS3BlobStore,
  probeS3BlobStore,
  RUNTIME_BLOB_OBJECT_PREFIX,
  type CreateS3BlobStoreConfig,
} from "@cube-runtime/persistence";
import { startServiceProcess, type ServiceAssemblyFactory } from "@cube-runtime/process-runtime";
import { createApiApp } from "./app.js";
import { createApiCreateCapability } from "./capabilities.js";
import { createThreadCursorCodec, parseThreadCursorSigningKeys } from "./cursor.js";
import { createProductionJwtAuthResolver } from "./production-auth.js";
import { loadProductionTlsCredentials, productionTrustProxy } from "./production-transport.js";
import type { ApiProcessConfiguration } from "./process-entry.js";

const cursorTtlMilliseconds = 15 * 60_000;
const cursorMaximumTtlMilliseconds = 60 * 60_000;
// 生产 HTTP API 只交付已完整校验的小对象；该边界独立于开发 fixture，避免把 provider 流直接暴露给浏览器。
const productionApiMaxBlobSizeBytes = 16 * 1_024 * 1_024;

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
      configuration.databaseSsl === undefined
    ) {
      throw new Error("PRODUCTION_API_ASSEMBLY_FORBIDDEN");
    }
    const persistence = createApiPersistenceRuntime({
      connectionString: configuration.databaseUrl,
      ssl: configuration.databaseSsl,
      schema: configuration.databaseSchema,
      expectedRuntimeRole: configuration.databaseRuntimeRole,
      applicationName: "cube-runtime-api-production",
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
      app = createApiApp(
        {
          auth: createProductionJwtAuthResolver(configuration.production.jwt),
          repositories: persistence.repositories,
          createCapability: createApiCreateCapability({
            threadCreation: persistence.threadCreation,
            enqueueOutbox: persistence.runDispatchCreation,
          }),
          archiveThread: persistence.archiveThread,
          experience: persistence.experience,
          blobs,
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
      await Promise.all([probes.postgres(), probes.objectStorage()]);
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
    signalSource?: import("@cube-runtime/process-runtime").ProcessSignalSource;
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

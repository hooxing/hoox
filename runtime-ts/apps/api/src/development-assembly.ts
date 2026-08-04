import { randomUUID } from "node:crypto";
import { isoTimestamp, runId, tenantId, threadId, userId, workspaceId } from "@cube-runtime/domain";
import {
  BlobSkillContentStore,
  createApiPersistenceRuntime,
  createS3BlobStore,
  DurableResourceBlobWriter,
  DurableResourceUploadBlobAdapter,
  RUNTIME_BLOB_OBJECT_PREFIX,
} from "@cube-runtime/persistence";
import type { ServiceAssemblyFactory } from "@cube-runtime/process-runtime";
import {
  createResourceFilesystemCapabilityCodec,
  ResourceAttachmentResolver,
  ResourceUploadService,
} from "@cube-runtime/resource";
import { SkillCenterService } from "@cube-runtime/skill";
import {
  startDevelopmentResourceFsProxy,
  type RunningDevelopmentResourceFsProxy,
} from "../development-resourcefs-proxy.mjs";
import { createApiApp } from "./app.js";
import { createApiCreateCapability } from "./capabilities.js";
import { createThreadCursorCodec, parseThreadCursorSigningKeys } from "./cursor.js";
import { createDevelopmentAuthResolver } from "./development-auth.js";
import {
  assertDevelopmentPrincipalsIsolated,
  assertDevelopmentPublicObjectStorageEndpoint,
  normalizeDevelopmentLoopbackHost,
} from "./development-boundary.js";
import type { ApiProcessConfiguration } from "./process-entry.js";

const cursorTtlMilliseconds = 15 * 60_000;
const cursorMaximumTtlMilliseconds = 60 * 60_000;
// BlobStore 当前会在完整校验后才交付内存对象；开发 API 不得绕过其 16 MiB 绝对边界。
const developmentApiMaxBlobSizeBytes = 16 * 1_024 * 1_024;
const developmentApiMaxSkillBlobSizeBytes = 32 * 1_024 * 1_024;

export { parseThreadCursorSigningKeys } from "./cursor.js";

/** 仅用于本地 development：真实 PG、固定开发身份和真实 TCP listener，不代表生产装配。 */
export const developmentApiAssembler: ServiceAssemblyFactory<ApiProcessConfiguration> = {
  async assemble(configuration) {
    if (
      configuration.runtimeEnvironment !== "development" ||
      configuration.developmentPrincipals === undefined
    ) {
      throw new Error("DEVELOPMENT_API_ASSEMBLY_FORBIDDEN");
    }
    // 即使调用方绕过进程配置解析直接调用装配器，也不能扩大固定凭据的网络与身份边界。
    assertDevelopmentPrincipalsIsolated(configuration.developmentPrincipals);
    const listenHost = normalizeDevelopmentLoopbackHost(configuration.listenHost);
    assertDevelopmentPublicObjectStorageEndpoint(
      configuration.objectStorage.publicEndpoint,
      listenHost,
      configuration.listenPort,
    );
    const persistence = createApiPersistenceRuntime({
      connectionString: configuration.databaseUrl,
      schema: configuration.databaseSchema,
      applicationName: "cube-runtime-api-development",
      serialQueueV2Enabled: configuration.serialQueueV2Enabled,
      // PG 签发的 canonical physicalObjectKey 必须与 S3 客户端使用同一持久前缀。
      blobLifecycle: { objectPrefix: RUNTIME_BLOB_OBJECT_PREFIX },
    });
    let app: ReturnType<typeof createApiApp> | undefined;
    let resourceFilesystemProxy: RunningDevelopmentResourceFsProxy | undefined;
    try {
      const clock = Object.freeze({ now: () => isoTimestamp(new Date().toISOString()) });
      const [firstPrincipal, secondPrincipal] = configuration.developmentPrincipals;
      const principals = Object.freeze([
        Object.freeze({
          userId: userId(firstPrincipal.userId),
          tenantId: tenantId(firstPrincipal.tenantId),
        }),
        Object.freeze({
          userId: userId(secondPrincipal.userId),
          tenantId: tenantId(secondPrincipal.tenantId),
        }),
      ] as const);
      const cursorCodec = createThreadCursorCodec({
        activeKid: configuration.cursorActiveKeyId,
        keys: parseThreadCursorSigningKeys(configuration.cursorSigningKeys),
        clock,
        ttlMilliseconds: cursorTtlMilliseconds,
        maximumTtlMilliseconds: cursorMaximumTtlMilliseconds,
      });
      const blobs = createS3BlobStore(
        {
          endpoint: configuration.objectStorage.endpoint,
          publicEndpoint: configuration.objectStorage.publicEndpoint,
          bucket: configuration.objectStorage.bucket,
          region: configuration.objectStorage.region,
          accessKeyId: configuration.objectStorage.accessKeyId,
          secretAccessKey: configuration.objectStorage.secretAccessKey,
          forcePathStyle: configuration.objectStorage.forcePathStyle,
          // Worker 将 Workspace/Artifact 对象置于这个受控前缀；下载端必须解析同一物理命名空间。
          prefix: RUNTIME_BLOB_OBJECT_PREFIX,
          maxBlobSizeBytes: developmentApiMaxBlobSizeBytes,
        },
        persistence.blobLifecycle,
      );
      const skillBlobs = createS3BlobStore(
        {
          endpoint: configuration.objectStorage.endpoint,
          publicEndpoint: configuration.objectStorage.publicEndpoint,
          bucket: configuration.objectStorage.bucket,
          region: configuration.objectStorage.region,
          accessKeyId: configuration.objectStorage.accessKeyId,
          secretAccessKey: configuration.objectStorage.secretAccessKey,
          forcePathStyle: configuration.objectStorage.forcePathStyle,
          prefix: RUNTIME_BLOB_OBJECT_PREFIX,
          maxBlobSizeBytes: developmentApiMaxSkillBlobSizeBytes,
        },
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
            developmentApiMaxBlobSizeBytes,
          ),
        ),
        persistence.resourceUploads,
        { maxBytes: developmentApiMaxBlobSizeBytes, now: clock.now },
      );
      app = createApiApp(
        {
          auth: createDevelopmentAuthResolver({
            runtimeEnvironment: configuration.runtimeEnvironment,
            principals,
          }),
          repositories: persistence.repositories,
          createCapability: createApiCreateCapability({
            threadCreation: persistence.threadCreation,
            enqueueOutbox: persistence.runDispatchCreation,
            ...(configuration.threadInputRoutingV2Enabled
              ? { threadInputs: persistence.threadInputs }
              : {}),
          }),
          archiveThread: persistence.archiveThread,
          experience: persistence.experience,
          modelWireTraces: persistence.modelWireTraces,
          blobs,
          resourceUploads,
          resourceAttachments: new ResourceAttachmentResolver(persistence.resourceCatalog),
          skillCenter: new SkillCenterService(persistence.skillCenter),
          resourceFilesystem: {
            catalog: persistence.resourceFilesystem,
            capabilities: resourceFilesystemCapabilities,
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
          readiness: Object.freeze({ probe: () => persistence.probe() }),
          clock,
          ids: Object.freeze({
            thread: () => threadId(`thread_${randomUUID()}`),
            run: () => runId(`run_${randomUUID()}`),
            workspace: () => workspaceId(`workspace_${randomUUID()}`),
          }),
        },
        { logger: true },
      );
      await persistence.probe();
      await app.listen({ host: listenHost, port: configuration.listenPort });
      if (configuration.developmentResourceFilesystemProxy !== undefined) {
        resourceFilesystemProxy = await startDevelopmentResourceFsProxy(
          configuration.developmentResourceFilesystemProxy,
        );
      }
      const listeningApp = app;
      const listeningResourceFilesystemProxy = resourceFilesystemProxy;
      return Object.freeze({
        // 先停止 Sidecar 并等待转发结束，再关闭它依赖的 Fastify upstream。
        stopAccepting: async () => {
          await listeningResourceFilesystemProxy?.close();
          await listeningApp.close();
        },
        resources: Object.freeze([
          Object.freeze({ name: "postgres", close: () => persistence.close() }),
        ]),
        readiness: Object.freeze([
          Object.freeze({ name: "postgres", probe: () => persistence.probe() }),
          ...(listeningResourceFilesystemProxy === undefined
            ? []
            : [
                Object.freeze({
                  name: "resourcefs-proxy",
                  probe: () => listeningResourceFilesystemProxy.probe(),
                }),
              ]),
        ]),
      });
    } catch (error) {
      if (resourceFilesystemProxy !== undefined) {
        await resourceFilesystemProxy.close().catch(() => undefined);
      }
      if (app !== undefined) await app.close().catch(() => undefined);
      await persistence.close().catch(() => undefined);
      throw error;
    }
  },
};

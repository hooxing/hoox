import { randomUUID } from "node:crypto";
import { isoTimestamp, runId, tenantId, threadId, userId, workspaceId } from "@cube-runtime/domain";
import { createApiPersistenceRuntime, createS3BlobStore } from "@cube-runtime/persistence";
import type { ServiceAssemblyFactory } from "@cube-runtime/process-runtime";
import { createApiApp } from "./app.js";
import { createApiCreateCapability } from "./capabilities.js";
import { createThreadCursorCodec, type ThreadCursorSigningKey } from "./cursor.js";
import { createDevelopmentAuthResolver } from "./development-auth.js";
import {
  assertDevelopmentPrincipalsIsolated,
  normalizeDevelopmentLoopbackHost,
} from "./development-boundary.js";
import type { ApiProcessConfiguration } from "./process-entry.js";

const cursorTtlMilliseconds = 15 * 60_000;
const cursorMaximumTtlMilliseconds = 60 * 60_000;

/**
 * 密钥环使用 `kid:base64url,kid:base64url`，这里只拆分结构；密钥长度和规范编码仍由 codec 校验。
 * 解析错误不能包含原始字符串，避免启动日志意外带出密钥。
 */
export function parseThreadCursorSigningKeys(value: string): readonly ThreadCursorSigningKey[] {
  const entries = value.split(",");
  if (entries.length === 0) throw new TypeError("分页游标签名密钥环无效");
  return Object.freeze(
    entries.map((entry) => {
      const separator = entry.indexOf(":");
      if (
        separator < 1 ||
        separator === entry.length - 1 ||
        entry.indexOf(":", separator + 1) >= 0
      ) {
        throw new TypeError("分页游标签名密钥环无效");
      }
      return Object.freeze({ kid: entry.slice(0, separator), secret: entry.slice(separator + 1) });
    }),
  );
}

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
    const persistence = createApiPersistenceRuntime({
      connectionString: configuration.databaseUrl,
      schema: configuration.databaseSchema,
      applicationName: "cube-runtime-api-development",
    });
    let app: ReturnType<typeof createApiApp> | undefined;
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
          maxBlobSizeBytes: 100 * 1_024 * 1_024,
        },
        persistence.blobLifecycle,
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
          }),
          archiveThread: persistence.archiveThread,
          experience: persistence.experience,
          blobs,
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
      const listeningApp = app;
      return Object.freeze({
        // Fastify close 会先停止接收并等待已经进入 handler 的请求完成。
        stopAccepting: () => listeningApp.close(),
        resources: Object.freeze([
          Object.freeze({ name: "postgres", close: () => persistence.close() }),
        ]),
        readiness: Object.freeze([
          Object.freeze({ name: "postgres", probe: () => persistence.probe() }),
        ]),
      });
    } catch (error) {
      if (app !== undefined) await app.close().catch(() => undefined);
      await persistence.close().catch(() => undefined);
      throw error;
    }
  },
};

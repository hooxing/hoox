import { randomUUID } from "node:crypto";
import { MAX_RUN_INPUT_UTF8_BYTES } from "@hoox/protocol";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import { isApiCreateCapability } from "./capabilities.js";
import type { ApiDependencies } from "./dependencies.js";
import { registerHttpMiddleware } from "./http-middleware.js";
import { beijingPinoTimestamp } from "./logging.js";
import { createRequestAuthentication } from "./request-auth.js";
import { registerResourceFilesystemHttp } from "./resource-filesystem-http.js";
import { registerArtifactRoutes } from "./routes/artifacts.js";
import { registerPlaygroundRoutes } from "./routes/playground.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAutomationRoutes } from "./routes/automations.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerHistoryFileRoutes } from "./routes/history-files.js";
import { registerModelWireTraceRoutes } from "./routes/model-wire-traces.js";
import { registerPersonalizationRoutes } from "./routes/personalization.js";
import {
  MAX_RESOURCE_UPLOAD_BYTES,
  registerResourceUploadRoutes,
} from "./routes/resource-uploads.js";
import { registerRunEventRoutes } from "./routes/run-events.js";
import { registerSkillRoutes } from "./routes/skills.js";
import { registerTeamRoutes } from "./routes/teams.js";
import { registerThreadAndRunRoutes } from "./routes/threads-and-runs.js";
import { ApiService } from "./service.js";

export type { ApiDependencies } from "./dependencies.js";

export interface ApiAppOptions {
  readonly logger?: boolean;
  readonly bodyLimitBytes?: number;
  readonly requestTimeoutMs?: number;
  /** production 仅允许由明确 CIDR 匹配器启用反向代理语义。 */
  readonly trustProxy?: false | ((address: string, hop: number) => boolean);
  /** 生产直连模式在 Fastify 建立 listener 前提供已校验的 TLS 凭据。 */
  readonly https?: Readonly<{
    readonly key: Buffer;
    readonly cert: Buffer;
    readonly minVersion: "TLSv1.2";
  }>;
}

export function createApiApp(
  dependencies: ApiDependencies,
  options: ApiAppOptions = {},
): FastifyInstance {
  // 只读取调用方依赖一次；后续路由注册和 Service 必须共享同一个不可变快照。
  const normalizedDependencies = Object.freeze({ ...dependencies });
  const createCapability = normalizedDependencies.createCapability;
  if (createCapability !== undefined && !isApiCreateCapability(createCapability)) {
    throw new TypeError("API 创建能力必须由 createApiCreateCapability 签发");
  }
  const app = Fastify({
    // 输入以解码后的 UTF-8 字节计量。JSON 的 \u0000 等转义最多占六倍 wire 字节，
    // 因此 HTTP 上限不能错误地把合法的 1 MiB 解码输入挡在解析器之前。
    bodyLimit:
      options.bodyLimitBytes ??
      Math.max(MAX_RUN_INPUT_UTF8_BYTES * 6 + 16 * 1024, MAX_RESOURCE_UPLOAD_BYTES),
    requestTimeout: options.requestTimeoutMs ?? 15_000,
    handlerTimeout: options.requestTimeoutMs ?? 15_000,
    connectionTimeout: 5_000,
    trustProxy: options.trustProxy ?? false,
    ...(options.https === undefined ? {} : { https: options.https }),
    onProtoPoisoning: "error",
    onConstructorPoisoning: "error",
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    ajv: {
      customOptions: { removeAdditional: false },
      onCreate: (ajv) => {
        ajv.addFormat("hoox-iso-utc-timestamp-v1", true);
      },
    },
    serializerOpts: {
      ajv: { formats: { "hoox-iso-utc-timestamp-v1": true } },
    },
    logger:
      options.logger === false
        ? false
        : {
            level: "info",
            timestamp: beijingPinoTimestamp,
            redact: {
              paths: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
              censor: "[REDACTED]",
            },
          },
  });
  const service = new ApiService(normalizedDependencies);
  const { authenticate, authenticateSelectedTenant } = createRequestAuthentication(service);

  if (normalizedDependencies.resourceUploads !== undefined) {
    app.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: MAX_RESOURCE_UPLOAD_BYTES },
      (_request, body, done) => done(null, body),
    );
  }
  registerHttpMiddleware(app);

  registerHealthRoutes(app, normalizedDependencies);
  registerAutomationRoutes(app, normalizedDependencies.scheduledTasks, authenticate);
  registerAuthRoutes(app, normalizedDependencies);
  registerPersonalizationRoutes(
    app,
    normalizedDependencies.personalizations,
    authenticate,
    authenticateSelectedTenant,
  );
  registerTeamRoutes(app, normalizedDependencies, authenticate);
  registerSkillRoutes(app, normalizedDependencies.skillCenter, authenticate);
  registerPlaygroundRoutes(app, normalizedDependencies.playground, authenticate);
  registerAgentRoutes(app, normalizedDependencies, service, authenticate);
  registerHistoryFileRoutes(app, normalizedDependencies, authenticate, authenticateSelectedTenant);

  if (
    normalizedDependencies.resourceFilesystem !== undefined &&
    normalizedDependencies.blobs !== undefined
  ) {
    registerResourceFilesystemHttp(app, {
      ...normalizedDependencies.resourceFilesystem,
      blobs: normalizedDependencies.blobs,
    });
  }
  registerResourceUploadRoutes(app, normalizedDependencies.resourceUploads, authenticate);
  registerThreadAndRunRoutes(
    app,
    normalizedDependencies,
    createCapability,
    service,
    authenticate,
    authenticateSelectedTenant,
  );
  registerRunEventRoutes(app, normalizedDependencies, service, authenticate);
  registerArtifactRoutes(app, normalizedDependencies, service, authenticate);
  registerModelWireTraceRoutes(app, normalizedDependencies, service, authenticate);

  return app;
}

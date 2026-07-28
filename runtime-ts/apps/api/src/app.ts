import { randomUUID } from "node:crypto";
import { runId } from "@cube-runtime/domain";
import type {
  BlobStore,
  CoreRepositories,
  RunExperienceArtifact,
  RunExperienceReadPort,
} from "@cube-runtime/persistence";
import { BlobStoreError, PersistenceError } from "@cube-runtime/persistence";
import {
  ArtifactDeliverySuccessEnvelopeSchema,
  ArtifactListSuccessEnvelopeSchema,
  type CreateRunRequest,
  CreateRunRequestSchema,
  type CreateThreadRequest,
  CreateThreadRequestSchema,
  createErrorEnvelope,
  type ErrorEnvelope,
  ErrorEnvelopeSchema,
  HealthSuccessEnvelopeSchema,
  MAX_RUN_INPUT_UTF8_BYTES,
  type RunArtifactPath,
  RunArtifactPathSchema,
  type RunEventListQuery,
  RunEventListQuerySchema,
  RunEventPageSuccessEnvelopeSchema,
  type RunPath,
  RunPathSchema,
  RunSuccessEnvelopeSchema,
  type ThreadListQuery,
  ThreadListQuerySchema,
  ThreadPageSuccessEnvelopeSchema,
  type ThreadPath,
  ThreadPathSchema,
  ThreadSuccessEnvelopeSchema,
} from "@cube-runtime/protocol";
import Fastify, { type FastifyInstance, type FastifyRequest, LogController } from "fastify";
import { type ApiCreateCapability, isApiCreateCapability } from "./capabilities.js";
import type {
  ApiClock,
  ApiIdGenerator,
  ArchiveThreadCommandPort,
  AuthContextResolver,
  ReadinessPort,
  ThreadCursorCodec,
} from "./ports.js";
import { ApiFailure, type ApiFailureKind, ApiService } from "./service.js";

export interface ApiDependencies {
  readonly auth: AuthContextResolver;
  readonly repositories: CoreRepositories;
  readonly createCapability?: ApiCreateCapability;
  readonly archiveThread: ArchiveThreadCommandPort;
  readonly cursorCodec: ThreadCursorCodec;
  readonly readiness: ReadinessPort;
  readonly clock: ApiClock;
  readonly ids: ApiIdGenerator;
  readonly experience?: RunExperienceReadPort;
  readonly blobs?: BlobStore;
}

export interface ApiAppOptions {
  readonly logger?: boolean;
  readonly bodyLimitBytes?: number;
  readonly requestTimeoutMs?: number;
}

const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const publicAgentEventTypes = new Set([
  "agent.started",
  "agent.settled",
  "message.delta",
  "message.completed",
  "tool.started",
  "tool.updated",
  "tool.completed",
  "queue.updated",
  "compaction.forbidden",
  "error",
]);

const statusByFailure: Readonly<Record<ApiFailureKind, number>> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  invalid_state: 422,
  unsupported_media_type: 415,
  dependency_unavailable: 503,
  internal: 500,
};

function requestId(request: FastifyRequest): string {
  return String(request.id);
}

function authorization(request: FastifyRequest): string | undefined {
  const value = request.headers.authorization;
  return typeof value === "string" ? value : undefined;
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !idempotencyKeyPattern.test(value)) {
    throw new ApiFailure("bad_request");
  }
  return value;
}

function requireJsonContentType(request: FastifyRequest): void {
  const value = request.headers["content-type"];
  if (
    typeof value !== "string" ||
    value.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    throw new ApiFailure("unsupported_media_type");
  }
}

function success<T>(request: FastifyRequest, data: T) {
  return { version: "v1" as const, requestId: requestId(request), data };
}

function persistenceFailure(error: PersistenceError): ApiFailureKind {
  switch (error.code) {
    case "CONFLICT":
      return "conflict";
    case "UNAVAILABLE":
      return "dependency_unavailable";
    case "CONSTRAINT_VIOLATION":
    case "MIGRATION_MISMATCH":
    case "UNEXPECTED":
      return "internal";
  }
}

function errorEnvelope(id: string, kind: ApiFailureKind): ErrorEnvelope {
  return createErrorEnvelope(id, { kind });
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
    bodyLimit: options.bodyLimitBytes ?? MAX_RUN_INPUT_UTF8_BYTES * 6 + 16 * 1024,
    requestTimeout: options.requestTimeoutMs ?? 15_000,
    handlerTimeout: options.requestTimeoutMs ?? 15_000,
    connectionTimeout: 5_000,
    onProtoPoisoning: "error",
    onConstructorPoisoning: "error",
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    ajv: {
      customOptions: { removeAdditional: false },
      onCreate: (ajv) => {
        ajv.addFormat("cube-iso-utc-timestamp-v1", true);
      },
    },
    serializerOpts: {
      ajv: { formats: { "cube-iso-utc-timestamp-v1": true } },
    },
    logger:
      options.logger === false
        ? false
        : {
            level: "info",
            redact: {
              paths: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
              censor: "[REDACTED]",
            },
          },
  });
  const service = new ApiService(normalizedDependencies);

  app.addHook("onSend", async (request, reply) => {
    void reply.header("x-request-id", requestId(request));
  });
  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        requestId: requestId(request),
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
        responseTimeMs: reply.elapsedTime,
      },
      "HTTP 请求完成",
    );
  });

  app.setErrorHandler((error, request, reply) => {
    let kind: ApiFailureKind;
    const errorShape =
      typeof error === "object" && error !== null
        ? (error as { readonly validation?: unknown; readonly code?: unknown })
        : {};
    if (
      errorShape.validation !== undefined ||
      new Set([
        "FST_ERR_CTP_BODY_TOO_LARGE",
        "FST_ERR_CTP_INVALID_JSON_BODY",
        "FST_ERR_CTP_EMPTY_JSON_BODY",
      ]).has(String(errorShape.code))
    ) {
      kind = "bad_request";
    } else if (errorShape.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      kind = "unsupported_media_type";
    } else if (errorShape.code === "FST_ERR_HANDLER_TIMEOUT") {
      kind = "dependency_unavailable";
    } else if (error instanceof ApiFailure) {
      kind = error.kind;
    } else if (error instanceof PersistenceError) {
      kind = persistenceFailure(error);
    } else if (error instanceof BlobStoreError) {
      // 对象已经通过业务授权后，签名、完整性或 provider 失败都是依赖异常，不能泄漏内部对象状态。
      kind = "dependency_unavailable";
    } else {
      kind = "internal";
    }
    // 不记录异常消息、请求体或 Header，避免驱动细节和凭据进入日志。
    request.log.warn(
      { requestId: requestId(request), route: request.routeOptions.url, failure: kind },
      "HTTP 请求失败",
    );
    void reply.status(statusByFailure[kind]).send(errorEnvelope(requestId(request), kind));
  });
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send(errorEnvelope(requestId(request), "not_found"));
  });

  const healthSchema = {
    response: { 200: HealthSuccessEnvelopeSchema, 503: ErrorEnvelopeSchema },
  } as const;
  app.get("/live", { schema: healthSchema }, async (request) =>
    success(request, { status: "ok" as const, checkedAt: normalizedDependencies.clock.now() }),
  );
  app.get("/ready", { schema: healthSchema }, async (request) => {
    try {
      await normalizedDependencies.readiness.probe();
    } catch {
      throw new ApiFailure("dependency_unavailable");
    }
    return success(request, {
      status: "ok" as const,
      checkedAt: normalizedDependencies.clock.now(),
    });
  });

  if (createCapability !== undefined) {
    app.post<{ Body: CreateThreadRequest }>(
      "/v1/threads",
      {
        preValidation: async (request) => requireJsonContentType(request),
        schema: {
          body: CreateThreadRequestSchema,
          response: {
            200: ThreadSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            409: ErrorEnvelopeSchema,
            415: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const auth = await service.authenticate(authorization(request), requestId(request));
        return success(
          request,
          await service.createThread(auth, request.body.title, requireIdempotencyKey(request)),
        );
      },
    );

    app.post<{ Params: ThreadPath; Body: CreateRunRequest }>(
      "/v1/threads/:threadId/runs",
      {
        preValidation: async (request) => requireJsonContentType(request),
        schema: {
          params: ThreadPathSchema,
          body: CreateRunRequestSchema,
          response: {
            200: RunSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            409: ErrorEnvelopeSchema,
            415: ErrorEnvelopeSchema,
            422: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const auth = await service.authenticate(authorization(request), requestId(request));
        return success(
          request,
          await service.createRun(
            auth,
            request.params.threadId,
            request.body.input,
            requireIdempotencyKey(request),
          ),
        );
      },
    );
  }

  app.get<{ Querystring: ThreadListQuery }>(
    "/v1/threads",
    {
      schema: {
        querystring: ThreadListQuerySchema,
        response: {
          200: ThreadPageSuccessEnvelopeSchema,
          400: ErrorEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
          503: ErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const auth = await service.authenticate(authorization(request), requestId(request));
      return success(request, await service.listThreads(auth, request.query));
    },
  );

  app.get<{ Params: ThreadPath }>(
    "/v1/threads/:threadId",
    {
      schema: {
        params: ThreadPathSchema,
        response: {
          200: ThreadSuccessEnvelopeSchema,
          400: ErrorEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
          503: ErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const auth = await service.authenticate(authorization(request), requestId(request));
      return success(request, await service.getThread(auth, request.params.threadId));
    },
  );

  app.delete<{ Params: ThreadPath }>(
    "/v1/threads/:threadId",
    {
      schema: {
        params: ThreadPathSchema,
        response: {
          200: ThreadSuccessEnvelopeSchema,
          400: ErrorEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          409: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
          503: ErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const auth = await service.authenticate(authorization(request), requestId(request));
      return success(request, await service.archiveThread(auth, request.params.threadId));
    },
  );

  app.get<{ Params: RunPath }>(
    "/v1/threads/:threadId/runs/:runId",
    {
      schema: {
        params: RunPathSchema,
        response: {
          200: RunSuccessEnvelopeSchema,
          400: ErrorEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
          503: ErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const auth = await service.authenticate(authorization(request), requestId(request));
      return success(
        request,
        await service.getRun(auth, request.params.threadId, request.params.runId),
      );
    },
  );

  app.delete<{ Params: RunPath }>(
    "/v1/threads/:threadId/runs/:runId",
    {
      schema: {
        params: RunPathSchema,
        response: {
          200: RunSuccessEnvelopeSchema,
          400: ErrorEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          409: ErrorEnvelopeSchema,
          422: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
          503: ErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const auth = await service.authenticate(authorization(request), requestId(request));
      return success(
        request,
        await service.cancelRun(auth, request.params.threadId, request.params.runId),
      );
    },
  );

  if (normalizedDependencies.experience !== undefined) {
    app.get<{ Params: RunPath; Querystring: RunEventListQuery }>(
      "/v1/threads/:threadId/runs/:runId/events",
      {
        schema: {
          params: RunPathSchema,
          querystring: RunEventListQuerySchema,
          response: {
            200: RunEventPageSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const auth = await service.authenticate(authorization(request), requestId(request));
        const run = await service.getRun(auth, request.params.threadId, request.params.runId);
        const read = await normalizedDependencies.experience?.listEvents({
          scope: auth.scope,
          runId: runId(run.id),
          after: request.query.after ?? -1,
          limit: request.query.limit ?? 100,
        });
        if (read === undefined || read.outcome === "not_found") throw new ApiFailure("not_found");
        return success(request, {
          ...(read.attemptId === undefined ? {} : { attemptId: read.attemptId }),
          items: read.events.map((event) => ({
            eventId: `${read.attemptId ?? "pending"}-${event.sequence}`,
            sequence: event.sequence,
            type: publicEventType(event.kind, event.payload),
            kind: event.kind,
            payload: event.payload,
            occurredAt: event.occurredAt,
          })),
        });
      },
    );

    app.get<{ Params: RunPath }>(
      "/v1/threads/:threadId/runs/:runId/artifacts",
      {
        schema: {
          params: RunPathSchema,
          response: {
            200: ArtifactListSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const auth = await service.authenticate(authorization(request), requestId(request));
        const run = await service.getRun(auth, request.params.threadId, request.params.runId);
        const read = await normalizedDependencies.experience?.listArtifacts({
          scope: auth.scope,
          runId: runId(run.id),
        });
        if (read === undefined || read.outcome === "not_found") throw new ApiFailure("not_found");
        return success(request, {
          items: read.artifacts.map((artifact) => ({
            id: artifact.id,
            tenantId: auth.scope.tenantId,
            threadId: artifact.threadId,
            runId: artifact.runId,
            resourceVersionId: artifact.resourceVersionId,
            name: artifact.name,
            mediaType: artifact.mediaType,
            sizeBytes: artifact.sizeBytes,
            status: "published" as const,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
          })),
        });
      },
    );
  }

  if (
    normalizedDependencies.experience !== undefined &&
    normalizedDependencies.blobs !== undefined
  ) {
    const artifactDeliverySchema = {
      params: RunArtifactPathSchema,
      response: {
        200: ArtifactDeliverySuccessEnvelopeSchema,
        400: ErrorEnvelopeSchema,
        401: ErrorEnvelopeSchema,
        404: ErrorEnvelopeSchema,
        422: ErrorEnvelopeSchema,
        500: ErrorEnvelopeSchema,
        503: ErrorEnvelopeSchema,
      },
    } as const;
    for (const [path, disposition] of [
      ["/v1/threads/:threadId/runs/:runId/artifacts/:artifactId/preview", "preview"],
      ["/v1/threads/:threadId/runs/:runId/artifacts/:artifactId/download", "download"],
    ] as const) {
      app.get<{ Params: RunArtifactPath }>(
        path,
        { schema: artifactDeliverySchema },
        async (request) => {
          const auth = await service.authenticate(authorization(request), requestId(request));
          const run = await service.getRun(auth, request.params.threadId, request.params.runId);
          const artifact = await normalizedDependencies.experience?.getArtifact({
            scope: auth.scope,
            runId: runId(run.id),
            artifactId: request.params.artifactId,
          });
          if (artifact === undefined || artifact.outcome === "not_found")
            throw new ApiFailure("not_found");
          if (
            disposition === "preview" &&
            !isPassivePreviewMediaType(artifact.artifact.mediaType)
          ) {
            throw new ApiFailure("invalid_state");
          }
          const delivery = await normalizedDependencies.blobs?.presignDownload({
            scope: { tenantId: auth.scope.tenantId },
            blob: artifact.artifact.blob,
            ttlSeconds: 300,
            responseMediaType: artifact.artifact.mediaType,
            delivery: disposition === "preview" ? "inline-preview" : "artifact-download",
            ...(disposition === "download"
              ? {
                  downloadName: safeArtifactDownloadName(
                    artifact.artifact.name,
                    artifact.artifact.id,
                  ),
                }
              : {}),
          });
          // 签发 URL 后再读取一次固定身份，避免成员撤销或发布状态变化时留下可用 URL。
          const confirmed = await normalizedDependencies.experience?.getArtifact({
            scope: auth.scope,
            runId: runId(run.id),
            artifactId: request.params.artifactId,
          });
          if (
            delivery === undefined ||
            confirmed === undefined ||
            confirmed.outcome === "not_found" ||
            !sameArtifactAuthorization(artifact.artifact, confirmed.artifact)
          ) {
            throw new ApiFailure("not_found");
          }
          return success(request, {
            artifact: {
              id: artifact.artifact.id,
              tenantId: auth.scope.tenantId,
              threadId: artifact.artifact.threadId,
              runId: artifact.artifact.runId,
              resourceVersionId: artifact.artifact.resourceVersionId,
              name: artifact.artifact.name,
              mediaType: artifact.artifact.mediaType,
              sizeBytes: artifact.artifact.sizeBytes,
              status: "published" as const,
              createdAt: artifact.artifact.createdAt,
              updatedAt: artifact.artifact.updatedAt,
            },
            url: validateArtifactDeliveryUrl(delivery),
            expiresInSeconds: 300,
            disposition,
          });
        },
      );
    }
  }

  return app;
}

function sameArtifactAuthorization(
  expected: RunExperienceArtifact,
  confirmed: RunExperienceArtifact,
): boolean {
  return (
    expected.authorizationRevision === confirmed.authorizationRevision &&
    expected.tenantId === confirmed.tenantId &&
    expected.threadId === confirmed.threadId &&
    expected.runId === confirmed.runId &&
    expected.id === confirmed.id &&
    expected.resourceVersionId === confirmed.resourceVersionId &&
    expected.name === confirmed.name &&
    expected.mediaType === confirmed.mediaType &&
    expected.sizeBytes === confirmed.sizeBytes &&
    expected.createdAt === confirmed.createdAt &&
    expected.updatedAt === confirmed.updatedAt &&
    expected.blob.tenantId === confirmed.blob.tenantId &&
    expected.blob.purpose === confirmed.blob.purpose &&
    expected.blob.sha256 === confirmed.blob.sha256 &&
    expected.blob.size === confirmed.blob.size &&
    expected.blob.mediaType === confirmed.blob.mediaType &&
    expected.blob.incarnationId === confirmed.blob.incarnationId &&
    expected.blob.physicalObjectKey === confirmed.blob.physicalObjectKey
  );
}

function isPassivePreviewMediaType(value: string): boolean {
  const [rawBase, ...rawParameters] = value.split(";");
  const base = rawBase?.trim().toLowerCase();
  if (base === "text/plain") {
    return rawParameters.every((parameter) =>
      /^charset\s*=\s*(?:"(?:utf-8|us-ascii|iso-8859-1|windows-1252)"|(?:utf-8|us-ascii|iso-8859-1|windows-1252))$/iu.test(
        parameter.trim(),
      ),
    );
  }
  return (
    rawParameters.length === 0 &&
    new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]).has(
      base ?? "",
    )
  );
}

/** 仅透传已由 RuntimeAgentEvent 协议声明的 agent 子类型，未知 payload 不能伪造公开事件类型。 */
function publicEventType(kind: string, payload: Readonly<Record<string, unknown>>): string {
  if (kind !== "agent_event") return kind;
  const candidate = payload.type;
  return typeof candidate === "string" && publicAgentEventTypes.has(candidate) ? candidate : kind;
}

function safeArtifactDownloadName(name: string, artifactId: string): string {
  const normalized = Array.from(name.normalize("NFKC"))
    .map((character) =>
      /[\p{Cc}\p{Cf}]/u.test(character) || '/\\"*:<>?|'.includes(character) ? "_" : character,
    )
    .join("")
    .replace(/[. ]+$/gu, "")
    .trim();
  return (normalized.length === 0 ? `artifact-${artifactId}` : normalized).slice(0, 180);
}

function validateArtifactDeliveryUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      !url.host
    ) {
      throw new Error("invalid artifact URL");
    }
    return url.toString();
  } catch {
    throw new ApiFailure("dependency_unavailable");
  }
}

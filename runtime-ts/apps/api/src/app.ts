import { randomUUID } from "node:crypto";
import { runId, threadId } from "@cube-runtime/domain";
import type {
  BlobStore,
  CoreRepositories,
  ModelWireTraceBody,
  ModelWireTraceCursor,
  ModelWireTraceReadPort,
  RunExperienceArtifact,
  RunExperienceReadPort,
  ThreadContinuityReadPort,
  ThreadContextReadPort,
} from "@cube-runtime/persistence";
import {
  assertBlobRef,
  BlobStoreError,
  PersistenceError,
  sha256Hex,
} from "@cube-runtime/persistence";
import {
  ArtifactDeliverySuccessEnvelopeSchema,
  ArtifactListSuccessEnvelopeSchema,
  type CreateRunRequest,
  CreateRunRequestSchema,
  type CreateThreadInputRequest,
  CreateThreadInputRequestSchema,
  type CreateThreadRequest,
  CreateThreadRequestSchema,
  createErrorEnvelope,
  type ErrorEnvelope,
  ErrorEnvelopeSchema,
  HealthSuccessEnvelopeSchema,
  MAX_RUN_INPUT_UTF8_BYTES,
  type ModelWireTraceBodyPath,
  ModelWireTraceBodyPathSchema,
  type ModelWireTraceListQuery,
  ModelWireTraceListQuerySchema,
  ModelWireTraceListSuccessEnvelopeSchema,
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
  type ThreadContextListQuery,
  ThreadContextListQuerySchema,
  ThreadContextPageSuccessEnvelopeSchema,
  ThreadContinuityStatusSuccessEnvelopeSchema,
  type ThreadInputReceiptPath,
  ThreadInputReceiptPathSchema,
  ThreadInputReceiptSuccessEnvelopeSchema,
  type ThreadPath,
  ThreadPathSchema,
  type ThreadRunListQuery,
  ThreadRunListQuerySchema,
  ThreadRunPageSuccessEnvelopeSchema,
  ThreadSuccessEnvelopeSchema,
  type UploadedResourceDto,
  UploadedResourceSuccessEnvelopeSchema,
} from "@cube-runtime/protocol";
import {
  type ResourceAttachmentResolverPort,
  type ResourceFilesystemCapabilityCodec,
  type ResourceFilesystemCatalog,
  ResourceServiceError,
  type ResourceUploadPort,
  stripAttachmentsFromUserFacingPrompt,
} from "@cube-runtime/resource";
import { beijingPinoTimestamp } from "./logging.js";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController,
} from "fastify";
import { type ApiCreateCapability, isApiCreateCapability } from "./capabilities.js";
import {
  decodeModelWireTraceCursor,
  encodeModelWireTraceCursor,
  InvalidModelWireTraceCursorError,
} from "./model-wire-trace-cursor.js";
import type {
  ApiClock,
  ApiIdGenerator,
  ArchiveThreadCommandPort,
  AuthContextResolver,
  ReadinessPort,
  TenantSelector,
  ThreadCursorCodec,
} from "./ports.js";
import { ApiFailure, type ApiFailureKind, ApiService } from "./service.js";
import {
  registerResourceFilesystemHttp,
  ResourceFilesystemHttpError,
} from "./resource-filesystem-http.js";

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
  readonly modelWireTraces?: ModelWireTraceReadPort;
  readonly blobs?: BlobStore;
  readonly threadContext?: ThreadContextReadPort;
  readonly threadContinuity?: ThreadContinuityReadPort;
  readonly resourceUploads?: ResourceUploadPort;
  readonly resourceAttachments?: ResourceAttachmentResolverPort;
  readonly resourceFilesystem?: Readonly<{
    catalog: ResourceFilesystemCatalog;
    capabilities: ResourceFilesystemCapabilityCodec;
  }>;
}

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

const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const publicAgentEventTypes = new Set([
  "agent.started",
  "agent.settled",
  "thinking.started",
  "thinking.delta",
  "thinking.completed",
  "message.delta",
  "message.completed",
  "tool.started",
  "tool.updated",
  "tool.completed",
  "queue.updated",
  "compaction.forbidden",
  "error",
]);
const MAX_TEXT_ARTIFACT_PREVIEW_BYTES = 1_024 * 1_024;
const diagnosticCacheControl = "private, no-store, no-cache, must-revalidate";
const MAX_RESOURCE_UPLOAD_BYTES = 16 * 1_024 * 1_024;

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

function headerValues(request: FastifyRequest, name: string): readonly string[] {
  const rawHeaders = request.raw.rawHeaders;
  if (Array.isArray(rawHeaders)) {
    const values: string[] = [];
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
      if (rawHeaders[index]?.toLowerCase() === name) {
        const value = rawHeaders[index + 1];
        if (value !== undefined) values.push(value);
      }
    }
    return values;
  }
  const value = request.headers[name];
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value : [];
}

function authorization(request: FastifyRequest): string | undefined {
  const values = headerValues(request, "authorization");
  return values.length === 1 ? values[0] : undefined;
}

function tenantSelector(request: FastifyRequest): TenantSelector {
  const values = headerValues(request, "x-tenant-id");
  if (values.length === 0) return Object.freeze({ kind: "absent" });
  if (values.length !== 1 || values[0] === undefined) return Object.freeze({ kind: "invalid" });
  return Object.freeze({ kind: "selected", value: values[0] });
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

function resourceFailure(error: ResourceServiceError): ApiFailureKind {
  switch (error.code) {
    case "INVALID_REQUEST":
    case "LIMIT_EXCEEDED":
    case "PREVIEW_BUDGET_EXCEEDED":
      return "bad_request";
    case "CONFLICT":
      return "conflict";
    case "NOT_FOUND":
    case "NOT_AUTHORIZED":
      return "not_found";
    case "DEPENDENCY_FAILURE":
    case "DEPENDENCY_UNAVAILABLE":
      return "dependency_unavailable";
    case "CONTENT_INTEGRITY_ERROR":
      return "internal";
  }
}

function singleHeader(request: FastifyRequest, name: string): string | undefined {
  const values = headerValues(request, name);
  if (values.length > 1) throw new ApiFailure("bad_request");
  return values[0];
}

function decodeUploadFileName(value: string | undefined): string {
  if (value === undefined || value.length > 1_024) throw new ApiFailure("bad_request");
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiFailure("bad_request");
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
            timestamp: beijingPinoTimestamp,
            redact: {
              paths: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
              censor: "[REDACTED]",
            },
          },
  });
  const service = new ApiService(normalizedDependencies);
  const authenticate = async (request: FastifyRequest) =>
    service.authenticate(authorization(request), requestId(request), tenantSelector(request));

  if (normalizedDependencies.resourceUploads !== undefined) {
    app.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: MAX_RESOURCE_UPLOAD_BYTES },
      (_request, body, done) => done(null, body),
    );
  }

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
    } else if (error instanceof ResourceFilesystemHttpError) {
      void reply.status(error.statusCode).send();
      return;
    } else if (error instanceof ResourceServiceError) {
      kind = resourceFailure(error);
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

  if (
    normalizedDependencies.resourceFilesystem !== undefined &&
    normalizedDependencies.blobs !== undefined
  ) {
    registerResourceFilesystemHttp(app, {
      ...normalizedDependencies.resourceFilesystem,
      blobs: normalizedDependencies.blobs,
    });
  }

  if (normalizedDependencies.resourceUploads !== undefined) {
    const resourceUploads = normalizedDependencies.resourceUploads;
    app.post<{ Body: Buffer }>(
      "/v1/resources/uploads",
      {
        schema: {
          response: {
            200: UploadedResourceSuccessEnvelopeSchema,
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
        const contentType = request.headers["content-type"];
        if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/octet-stream") {
          throw new ApiFailure("unsupported_media_type");
        }
        const auth = await authenticate(request);
        const name = decodeUploadFileName(singleHeader(request, "x-file-name"));
        const mediaType = singleHeader(request, "x-file-media-type") ?? "application/octet-stream";
        const uploaded: UploadedResourceDto = await resourceUploads.upload({
          context: auth.scope,
          idempotencyKey: requireIdempotencyKey(request),
          name,
          mediaType,
          body: new Uint8Array(request.body),
        });
        return success(request, uploaded);
      },
    );
  }

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
        const auth = await authenticate(request);
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
        const auth = await authenticate(request);
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

    if (createCapability.threadInputs !== undefined) {
      app.post<{ Params: ThreadPath; Body: CreateThreadInputRequest }>(
        "/v1/threads/:threadId/inputs",
        {
          preValidation: async (request) => requireJsonContentType(request),
          schema: {
            params: ThreadPathSchema,
            body: CreateThreadInputRequestSchema,
            response: {
              200: ThreadInputReceiptSuccessEnvelopeSchema,
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
          const auth = await authenticate(request);
          return success(
            request,
            await service.submitThreadInput(
              auth,
              request.params.threadId,
              request.body,
              requireIdempotencyKey(request),
            ),
          );
        },
      );

      app.get<{ Params: ThreadInputReceiptPath }>(
        "/v1/threads/:threadId/inputs/:receiptId",
        {
          schema: {
            params: ThreadInputReceiptPathSchema,
            response: {
              200: ThreadInputReceiptSuccessEnvelopeSchema,
              400: ErrorEnvelopeSchema,
              401: ErrorEnvelopeSchema,
              404: ErrorEnvelopeSchema,
              500: ErrorEnvelopeSchema,
              503: ErrorEnvelopeSchema,
            },
          },
        },
        async (request) => {
          const auth = await authenticate(request);
          return success(
            request,
            await service.getThreadInputReceipt(
              auth,
              request.params.threadId,
              request.params.receiptId,
            ),
          );
        },
      );
    }
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
      const auth = await authenticate(request);
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
      const auth = await authenticate(request);
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
      const auth = await authenticate(request);
      return success(request, await service.archiveThread(auth, request.params.threadId));
    },
  );

  app.get<{ Params: ThreadPath; Querystring: ThreadRunListQuery }>(
    "/v1/threads/:threadId/runs",
    {
      schema: {
        params: ThreadPathSchema,
        querystring: ThreadRunListQuerySchema,
        response: {
          200: ThreadRunPageSuccessEnvelopeSchema,
          400: ErrorEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
          503: ErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const auth = await authenticate(request);
      return success(
        request,
        await service.listLatestRuns(auth, request.params.threadId, request.query),
      );
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
      const auth = await authenticate(request);
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
      const auth = await authenticate(request);
      return success(
        request,
        await service.cancelRun(auth, request.params.threadId, request.params.runId),
      );
    },
  );

  if (normalizedDependencies.threadContext !== undefined) {
    app.get<{ Params: ThreadPath; Querystring: ThreadContextListQuery }>(
      "/v1/threads/:threadId/context",
      {
        schema: {
          params: ThreadPathSchema,
          querystring: ThreadContextListQuerySchema,
          response: {
            200: ThreadContextPageSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const auth = await authenticate(request);
        const read = await normalizedDependencies.threadContext?.listMessages({
          scope: auth.scope,
          threadId: threadId(request.params.threadId),
          after: request.query.after ?? 0,
          limit: request.query.limit ?? 100,
        });
        if (read === undefined || read.outcome === "not_found") throw new ApiFailure("not_found");
        return success(request, {
          items: read.items.map((item) =>
            item.role === "user"
              ? { ...item, text: stripAttachmentsFromUserFacingPrompt(item.text) }
              : item,
          ),
          hasMore: read.hasMore,
        });
      },
    );
  }

  if (normalizedDependencies.threadContinuity !== undefined) {
    app.get<{ Params: ThreadPath }>(
      "/v1/threads/:threadId/continuity",
      {
        schema: {
          params: ThreadPathSchema,
          response: {
            200: ThreadContinuityStatusSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const auth = await authenticate(request);
        const read = await normalizedDependencies.threadContinuity?.getStatus({
          scope: auth.scope,
          threadId: threadId(request.params.threadId),
        });
        if (read === undefined || read.outcome === "not_found") throw new ApiFailure("not_found");
        return success(request, read.status);
      },
    );
  }

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
        const auth = await authenticate(request);
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
          hasMore: read.hasMore,
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
        const auth = await authenticate(request);
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
        async (request, reply) => {
          void reply.header("cache-control", "no-store");
          void reply.header("pragma", "no-cache");
          void reply.header("x-content-type-options", "nosniff");
          const auth = await authenticate(request);
          const run = await service.getRun(auth, request.params.threadId, request.params.runId);
          const artifact = await normalizedDependencies.experience?.getArtifact({
            scope: auth.scope,
            runId: runId(run.id),
            artifactId: request.params.artifactId,
          });
          if (artifact === undefined || artifact.outcome === "not_found")
            throw new ApiFailure("not_found");
          const textPreview =
            disposition === "preview" && isTextPreviewMediaType(artifact.artifact.mediaType);
          if (
            disposition === "preview" &&
            !textPreview &&
            !isInlineBinaryPreviewMediaType(artifact.artifact.mediaType)
          ) {
            throw new ApiFailure("invalid_state");
          }
          if (textPreview && artifact.artifact.sizeBytes > MAX_TEXT_ARTIFACT_PREVIEW_BYTES) {
            throw new ApiFailure("invalid_state");
          }
          const previewBytes = textPreview
            ? await normalizedDependencies.blobs?.getBytes(
                { tenantId: auth.scope.tenantId },
                artifact.artifact.blob,
              )
            : undefined;
          if (
            previewBytes !== undefined &&
            (previewBytes.byteLength !== artifact.artifact.sizeBytes ||
              previewBytes.byteLength > MAX_TEXT_ARTIFACT_PREVIEW_BYTES)
          ) {
            throw new ApiFailure("invalid_state");
          }
          let previewText: string | undefined;
          if (previewBytes !== undefined) {
            try {
              previewText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                previewBytes,
              );
            } catch {
              throw new ApiFailure("invalid_state");
            }
          }
          const delivery = textPreview
            ? undefined
            : await normalizedDependencies.blobs?.presignDownload({
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
            confirmed === undefined ||
            confirmed.outcome === "not_found" ||
            !sameArtifactAuthorization(artifact.artifact, confirmed.artifact)
          ) {
            throw new ApiFailure("not_found");
          }
          const artifactDto = {
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
          };
          if (previewText !== undefined) {
            return success(request, { ...artifactDto, text: previewText, disposition: "preview" });
          }
          if (delivery === undefined) throw new ApiFailure("not_found");
          return success(request, {
            ...artifactDto,
            url: validateArtifactDeliveryUrl(delivery),
            expiresInSeconds: 300,
            disposition,
          });
        },
      );
    }
  }

  if (
    normalizedDependencies.modelWireTraces !== undefined &&
    normalizedDependencies.blobs !== undefined
  ) {
    app.get<{ Params: RunPath; Querystring: ModelWireTraceListQuery }>(
      "/v1/threads/:threadId/runs/:runId/model-wire-traces",
      {
        schema: {
          params: RunPathSchema,
          querystring: ModelWireTraceListQuerySchema,
          response: {
            200: ModelWireTraceListSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request, reply) => {
        setDiagnosticResponseHeaders(reply);
        const auth = await authenticate(request);
        const run = await service.getRun(auth, request.params.threadId, request.params.runId);
        const cursorScope = {
          tenantId: auth.scope.tenantId,
          userId: auth.scope.userId,
          threadId: request.params.threadId,
          runId: run.id,
        } as const;
        let after: ModelWireTraceCursor | undefined;
        try {
          after =
            request.query.cursor === undefined
              ? undefined
              : decodeModelWireTraceCursor(cursorScope, request.query.cursor);
        } catch (error) {
          if (error instanceof InvalidModelWireTraceCursorError) {
            throw new ApiFailure("bad_request");
          }
          throw error;
        }
        const read = await normalizedDependencies.modelWireTraces?.list({
          scope: auth.scope,
          threadId: request.params.threadId,
          runId: run.id,
          limit: request.query.limit ?? 200,
          ...(after === undefined ? {} : { after }),
        });
        if (read === undefined || read.outcome === "not_found") throw new ApiFailure("not_found");
        const last = read.records.at(-1);
        const nextCursor =
          read.nextCursor ??
          (last === undefined
            ? undefined
            : {
                createdAt: last.createdAt,
                attemptId: last.attemptId,
                modelTurn: last.modelTurn,
                transportAttempt: last.transportAttempt,
                part: last.part,
              });
        if (read.hasMore && nextCursor === undefined) throw new ApiFailure("internal");
        return success(request, {
          items: read.records,
          hasMore: read.hasMore,
          ...(nextCursor === undefined
            ? {}
            : { nextCursor: encodeModelWireTraceCursor(cursorScope, nextCursor) }),
        });
      },
    );

    app.get<{ Params: ModelWireTraceBodyPath }>(
      "/v1/threads/:threadId/runs/:runId/model-wire-traces/:attemptId/:modelTurn/:transportAttempt/:part/body",
      {
        schema: {
          params: ModelWireTraceBodyPathSchema,
          response: {
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request, reply) => {
        setDiagnosticResponseHeaders(reply);
        const auth = await authenticate(request);
        const run = await service.getRun(auth, request.params.threadId, request.params.runId);
        const identity = {
          scope: auth.scope,
          threadId: request.params.threadId,
          runId: run.id,
          attemptId: request.params.attemptId,
          modelTurn: request.params.modelTurn,
          transportAttempt: request.params.transportAttempt,
          part: request.params.part,
        } as const;
        const authorized = await normalizedDependencies.modelWireTraces?.getBody(identity);
        if (
          authorized === undefined ||
          authorized.outcome === "not_found" ||
          !validTraceBodyAuthorization(auth.scope.tenantId, identity, authorized.body)
        ) {
          throw new ApiFailure("not_found");
        }
        const bytes = await normalizedDependencies.blobs?.getBytes(
          { tenantId: auth.scope.tenantId },
          authorized.body.blob,
        );
        if (bytes === undefined) throw new ApiFailure("not_found");
        if (
          bytes.byteLength !== authorized.body.blob.size ||
          sha256Hex(bytes) !== authorized.body.blob.sha256
        ) {
          throw new BlobStoreError("BLOB_INTEGRITY_MISMATCH", "诊断正文完整性校验失败");
        }
        // 对象读取后重验 Membership、过期时间和固定 Blob 身份，拒绝撤权/清理竞态留下正文。
        const confirmed = await normalizedDependencies.modelWireTraces?.getBody(identity);
        if (
          confirmed === undefined ||
          confirmed.outcome === "not_found" ||
          !sameTraceBodyAuthorization(authorized.body, confirmed.body)
        ) {
          throw new ApiFailure("not_found");
        }
        void reply
          .type("application/octet-stream")
          .header(
            "content-disposition",
            `inline; filename="model-turn-${request.params.modelTurn}-http-${request.params.transportAttempt}-${request.params.part}.bin"`,
          );
        return reply.send(Buffer.from(bytes));
      },
    );
  }

  return app;
}

function setDiagnosticResponseHeaders(reply: FastifyReply): void {
  void reply
    .header("cache-control", diagnosticCacheControl)
    .header("pragma", "no-cache")
    .header("expires", "0")
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer");
}

function validTraceBodyAuthorization(
  tenant: string,
  identity: Readonly<{
    attemptId: string;
    modelTurn: number;
    transportAttempt: number;
    part: "request" | "response";
  }>,
  body: ModelWireTraceBody,
): boolean {
  try {
    assertBlobRef({ tenantId: tenant }, body.blob);
  } catch {
    return false;
  }
  return (
    body.blob.kind === "stable" &&
    body.blob.tenantId === tenant &&
    body.blob.purpose === "trace" &&
    body.metadata.attemptId === identity.attemptId &&
    body.metadata.modelTurn === identity.modelTurn &&
    body.metadata.transportAttempt === identity.transportAttempt &&
    body.metadata.part === identity.part &&
    body.metadata.persistenceStatus === "stored" &&
    body.metadata.bodyAvailable &&
    body.metadata.sha256 === body.blob.sha256 &&
    body.metadata.size === body.blob.size
  );
}

function sameTraceBodyAuthorization(expected: ModelWireTraceBody, confirmed: ModelWireTraceBody) {
  return (
    expected.metadata.attemptId === confirmed.metadata.attemptId &&
    expected.metadata.modelTurn === confirmed.metadata.modelTurn &&
    expected.metadata.transportAttempt === confirmed.metadata.transportAttempt &&
    expected.metadata.part === confirmed.metadata.part &&
    expected.metadata.captureStatus === confirmed.metadata.captureStatus &&
    expected.metadata.persistenceStatus === confirmed.metadata.persistenceStatus &&
    expected.metadata.captureErrorCode === confirmed.metadata.captureErrorCode &&
    expected.metadata.httpStatus === confirmed.metadata.httpStatus &&
    expected.metadata.sha256 === confirmed.metadata.sha256 &&
    expected.metadata.size === confirmed.metadata.size &&
    expected.metadata.bodyAvailable === confirmed.metadata.bodyAvailable &&
    expected.metadata.createdAt === confirmed.metadata.createdAt &&
    expected.metadata.expiresAt === confirmed.metadata.expiresAt &&
    expected.blob.tenantId === confirmed.blob.tenantId &&
    expected.blob.purpose === confirmed.blob.purpose &&
    expected.blob.sha256 === confirmed.blob.sha256 &&
    expected.blob.size === confirmed.blob.size &&
    expected.blob.mediaType === confirmed.blob.mediaType &&
    expected.blob.incarnationId === confirmed.blob.incarnationId &&
    expected.blob.physicalObjectKey === confirmed.blob.physicalObjectKey
  );
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

function isInlineBinaryPreviewMediaType(value: string): boolean {
  const [rawBase, ...rawParameters] = value.split(";");
  const base = rawBase?.trim().toLowerCase();
  return (
    rawParameters.length === 0 &&
    new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]).has(
      base ?? "",
    )
  );
}

function isTextPreviewMediaType(value: string): boolean {
  return /^text\/plain\s*;\s*charset\s*=\s*utf-8\s*$/iu.test(value);
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

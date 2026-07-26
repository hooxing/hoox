import { randomUUID } from "node:crypto";
import {
  CreateRunRequestSchema,
  CreateThreadRequestSchema,
  ErrorEnvelopeSchema,
  HealthSuccessEnvelopeSchema,
  RunPathSchema,
  RunSuccessEnvelopeSchema,
  ThreadListQuerySchema,
  ThreadPageSuccessEnvelopeSchema,
  ThreadPathSchema,
  ThreadSuccessEnvelopeSchema,
  createErrorEnvelope,
  type CreateRunRequest,
  type CreateThreadRequest,
  type ErrorEnvelope,
  type RunPath,
  type ThreadListQuery,
  type ThreadPath,
} from "@cube-runtime/protocol";
import { PersistenceError } from "@cube-runtime/persistence";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type {
  ApiClock,
  ApiIdGenerator,
  AuthContextResolver,
  EnqueueOutboxPort,
  ReadinessPort,
  ThreadCreationPort,
} from "./ports.js";
import { ApiFailure, type ApiFailureKind, ApiService } from "./service.js";
import type { CoreRepositories } from "@cube-runtime/persistence";

export interface ApiDependencies {
  readonly auth: AuthContextResolver;
  readonly repositories: CoreRepositories;
  readonly threadCreation: ThreadCreationPort;
  readonly enqueueOutbox: EnqueueOutboxPort;
  readonly readiness: ReadinessPort;
  readonly clock: ApiClock;
  readonly ids: ApiIdGenerator;
}

export interface ApiAppOptions {
  readonly logger?: boolean;
  readonly bodyLimitBytes?: number;
  readonly requestTimeoutMs?: number;
}

const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

const statusByFailure: Readonly<Record<ApiFailureKind, number>> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  invalid_state: 422,
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
  const app = Fastify({
    bodyLimit: options.bodyLimitBytes ?? 64 * 1024,
    requestTimeout: options.requestTimeoutMs ?? 15_000,
    handlerTimeout: options.requestTimeoutMs ?? 15_000,
    connectionTimeout: 5_000,
    disableRequestLogging: true,
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
  const service = new ApiService(dependencies);

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
    if (errorShape.validation !== undefined || errorShape.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      kind = "bad_request";
    } else if (errorShape.code === "FST_ERR_HANDLER_TIMEOUT") {
      kind = "dependency_unavailable";
    } else if (error instanceof ApiFailure) {
      kind = error.kind;
    } else if (error instanceof PersistenceError) {
      kind = persistenceFailure(error);
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
    success(request, { status: "ok" as const, checkedAt: dependencies.clock.now() }),
  );
  app.get("/ready", { schema: healthSchema }, async (request) => {
    try {
      await dependencies.readiness.probe();
    } catch {
      throw new ApiFailure("dependency_unavailable");
    }
    return success(request, { status: "ok" as const, checkedAt: dependencies.clock.now() });
  });

  app.post<{ Body: CreateThreadRequest }>(
    "/v1/threads",
    {
      schema: {
        body: CreateThreadRequestSchema,
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
      return success(
        request,
        await service.createThread(auth, request.body.title, requireIdempotencyKey(request)),
      );
    },
  );

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

  app.post<{ Params: ThreadPath; Body: CreateRunRequest }>(
    "/v1/threads/:threadId/runs",
    {
      schema: {
        params: ThreadPathSchema,
        body: CreateRunRequestSchema,
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
        await service.createRun(auth, request.params.threadId, requireIdempotencyKey(request)),
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

  return app;
}

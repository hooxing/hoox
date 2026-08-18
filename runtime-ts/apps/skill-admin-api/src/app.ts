import { randomUUID } from "node:crypto";
import type { AuthContextResolver } from "@hoox/api";
import type { UserId } from "@hoox/domain";
import {
  CreateSkillSubmissionRequestSchema,
  CreateSkillSubmissionSuccessEnvelopeSchema,
  createErrorEnvelope,
  ErrorEnvelopeSchema,
  IdSchema,
  PublishSkillSubmissionRequestSchema,
  PublishSkillSubmissionSuccessEnvelopeSchema,
  ReviewSkillSubmissionRequestSchema,
  ReviewSkillSubmissionSuccessEnvelopeSchema,
  RevokeSkillSubmissionRequestSchema,
  RevokeSkillSubmissionSuccessEnvelopeSchema,
  SkillSubmissionPageSuccessEnvelopeSchema,
  SkillSubmissionSuccessEnvelopeSchema,
  SubmitSkillSubmissionRequestSchema,
  SubmitSkillSubmissionSuccessEnvelopeSchema,
  type CreateSkillSubmissionRequest,
  type PublishSkillSubmissionRequest,
  type ReviewSkillSubmissionRequest,
  type RevokeSkillSubmissionRequest,
  type SubmitSkillSubmissionRequest,
} from "@hoox/protocol";
import {
  DEFAULT_SKILL_PUBLICATION_COMPATIBILITY,
  type SkillPublicationService,
  SkillServiceError,
} from "@hoox/skill";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";

const strict = { additionalProperties: false } as const;
const SubmissionPathSchema = Type.Object({ submissionId: IdSchema }, strict);
type SubmissionPath = Static<typeof SubmissionPathSchema>;
const ListQuerySchema = Type.Object(
  {
    cursor: Type.Optional(IdSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })),
  },
  strict,
);
type ListQuery = Static<typeof ListQuerySchema>;

export interface SkillAdminApiDependencies {
  readonly auth: AuthContextResolver;
  readonly publications: SkillPublicationService;
  readonly readiness: { probe(): Promise<void> };
  readonly now?: () => Date;
  readonly submissionId?: () => string;
}

export interface SkillAdminApiAppOptions {
  readonly logger?: boolean;
  readonly bodyLimitBytes?: number;
  readonly trustProxy?: false | ((address: string, hop: number) => boolean);
  readonly https?: Readonly<{
    readonly key: Buffer;
    readonly cert: Buffer;
    readonly minVersion: "TLSv1.2";
  }>;
}

export function createSkillAdminApiApp(
  dependencies: SkillAdminApiDependencies,
  options: SkillAdminApiAppOptions = {},
): FastifyInstance {
  const app = Fastify({
    logger:
      options.logger === true
        ? {
            level: "info",
            redact: {
              paths: ["req.headers.authorization", "req.headers.cookie"],
              censor: "[REDACTED]",
            },
          }
        : false,
    bodyLimit: options.bodyLimitBytes ?? 48 * 1024 * 1024,
    requestTimeout: 60_000,
    handlerTimeout: 60_000,
    connectionTimeout: 5_000,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    trustProxy: options.trustProxy ?? false,
    ...(options.https === undefined ? {} : { https: options.https }),
    onProtoPoisoning: "error",
    onConstructorPoisoning: "error",
    ajv: {
      customOptions: { removeAdditional: false },
      onCreate: (ajv) => {
        ajv.addFormat("hoox-iso-utc-timestamp-v1", true);
      },
    },
    serializerOpts: {
      ajv: { formats: { "hoox-iso-utc-timestamp-v1": true } },
    },
  });
  const now = dependencies.now ?? (() => new Date());
  const nextSubmissionId =
    dependencies.submissionId ?? (() => `submission_${randomUUID().replaceAll("-", "")}`);

  app.addHook("onSend", async (request, reply) => {
    void reply
      .header("x-request-id", String(request.id))
      .header("cache-control", "private, no-store, no-cache, must-revalidate")
      .header("pragma", "no-cache")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer");
  });

  app.setErrorHandler(async (error, request, reply) => {
    let failure: FailureKind = "internal";
    if (error instanceof AdminApiFailure) failure = error.kind;
    else if (error instanceof SkillServiceError) failure = skillFailure(error);
    else if (isFastifyBadRequest(error)) failure = "bad_request";
    else if (errorCode(error) === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      failure = "unsupported_media_type";
    } else if (errorCode(error) === "FST_ERR_HANDLER_TIMEOUT") {
      failure = "dependency_unavailable";
    }
    const response = failureResponse(request, failure);
    // 管理端日志不能包含提交正文、入口指令、鉴权 Header 或对象存储细节。
    request.log.warn({ failure, requestId: request.id }, "Skill 管理请求失败");
    await reply.status(response.status).send(response.body);
  });

  app.get("/live", async (request) =>
    success(request, { status: "ok" as const, checkedAt: now().toISOString() }),
  );
  app.get("/ready", async (request) => {
    try {
      await dependencies.readiness.probe();
    } catch {
      throw new AdminApiFailure("dependency_unavailable");
    }
    return success(request, { status: "ok" as const, checkedAt: now().toISOString() });
  });

  app.get<{ Querystring: ListQuery }>(
    "/v1/admin/skill-submissions",
    {
      schema: {
        querystring: ListQuerySchema,
        response: responseSchemas(SkillSubmissionPageSuccessEnvelopeSchema),
      },
    },
    async (request) => {
      const userId = await authenticate(request, dependencies.auth);
      const page = await dependencies.publications.list({
        userId,
        ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
      });
      return success(request, {
        items: page.items,
        ...(page.nextSubmissionId === undefined ? {} : { nextCursor: page.nextSubmissionId }),
      });
    },
  );

  app.get<{ Params: SubmissionPath }>(
    "/v1/admin/skill-submissions/:submissionId",
    {
      schema: {
        params: SubmissionPathSchema,
        response: responseSchemas(SkillSubmissionSuccessEnvelopeSchema),
      },
    },
    async (request) => {
      const userId = await authenticate(request, dependencies.auth);
      return success(
        request,
        await dependencies.publications.get(userId, request.params.submissionId),
      );
    },
  );

  app.post<{ Body: CreateSkillSubmissionRequest }>(
    "/v1/admin/skill-submissions",
    {
      schema: {
        body: CreateSkillSubmissionRequestSchema,
        response: responseSchemas(CreateSkillSubmissionSuccessEnvelopeSchema),
      },
    },
    async (request) => {
      requireJson(request);
      const userId = await authenticate(request, dependencies.auth);
      const { files, compatibility, sourceUrl, sourceRevision, ...metadata } = request.body;
      return success(
        request,
        await dependencies.publications.create({
          userId,
          submissionId: nextSubmissionId(),
          metadata: {
            ...metadata,
            compatibility: compatibility ?? DEFAULT_SKILL_PUBLICATION_COMPATIBILITY,
            sourceUrl: sourceUrl ?? "",
            sourceRevision: sourceRevision ?? "",
          },
          files,
          idempotencyKey: requireIdempotencyKey(request),
        }),
      );
    },
  );

  registerAction<SubmitSkillSubmissionRequest>(
    app,
    dependencies,
    "submit",
    SubmitSkillSubmissionRequestSchema,
    SubmitSkillSubmissionSuccessEnvelopeSchema,
    async (request, userId) =>
      dependencies.publications.submit({
        userId,
        submissionId: request.params.submissionId,
        expectedVersionToken: request.body.expectedVersionToken,
        idempotencyKey: requireIdempotencyKey(request),
      }),
  );
  registerAction<ReviewSkillSubmissionRequest>(
    app,
    dependencies,
    "review",
    ReviewSkillSubmissionRequestSchema,
    ReviewSkillSubmissionSuccessEnvelopeSchema,
    async (request, userId) =>
      dependencies.publications.review({
        userId,
        submissionId: request.params.submissionId,
        expectedVersionToken: request.body.expectedVersionToken,
        decision: request.body.decision,
        ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
        idempotencyKey: requireIdempotencyKey(request),
      }),
  );
  registerAction<PublishSkillSubmissionRequest>(
    app,
    dependencies,
    "publish",
    PublishSkillSubmissionRequestSchema,
    PublishSkillSubmissionSuccessEnvelopeSchema,
    async (request, userId) =>
      dependencies.publications.publish({
        userId,
        submissionId: request.params.submissionId,
        expectedVersionToken: request.body.expectedVersionToken,
        recommended: request.body.recommended,
        idempotencyKey: requireIdempotencyKey(request),
      }),
  );
  registerAction<RevokeSkillSubmissionRequest>(
    app,
    dependencies,
    "revoke",
    RevokeSkillSubmissionRequestSchema,
    RevokeSkillSubmissionSuccessEnvelopeSchema,
    async (request, userId) =>
      dependencies.publications.revoke({
        userId,
        submissionId: request.params.submissionId,
        expectedVersionToken: request.body.expectedVersionToken,
        reason: request.body.reason,
        idempotencyKey: requireIdempotencyKey(request),
      }),
  );

  return app;
}

function registerAction<TBody>(
  app: FastifyInstance,
  dependencies: SkillAdminApiDependencies,
  action: string,
  bodySchema: object,
  successSchema: object,
  execute: (
    request: FastifyRequest<{ Params: SubmissionPath; Body: TBody }>,
    userId: UserId,
  ) => Promise<unknown>,
): void {
  app.post<{ Params: SubmissionPath; Body: TBody }>(
    `/v1/admin/skill-submissions/:submissionId/${action}`,
    {
      schema: {
        params: SubmissionPathSchema,
        body: bodySchema,
        response: responseSchemas(successSchema),
      },
    },
    async (request) => {
      requireJson(request);
      const userId = await authenticate(request, dependencies.auth);
      return success(request, await execute(request, userId));
    },
  );
}

async function authenticate(request: FastifyRequest, resolver: AuthContextResolver) {
  const authorization = singleHeader(request, "authorization");
  const principal = await resolver.resolve({ authorization, requestId: String(request.id) });
  if (principal === undefined) throw new AdminApiFailure("not_found");
  return principal.userId;
}

function requireJson(request: FastifyRequest): void {
  const type = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new AdminApiFailure("unsupported_media_type");
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const value = singleHeader(request, "idempotency-key");
  if (value === undefined) throw new AdminApiFailure("bad_request");
  return value;
}

function singleHeader(request: FastifyRequest, name: string): string | undefined {
  const values = headerValues(request, name);
  if (values.length > 1) throw new AdminApiFailure("bad_request");
  return values[0];
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

function success<T>(request: FastifyRequest, data: T) {
  return { version: "v1" as const, requestId: String(request.id), data };
}

function responseSchemas(successSchema: object) {
  return {
    200: successSchema,
    400: ErrorEnvelopeSchema,
    401: ErrorEnvelopeSchema,
    404: ErrorEnvelopeSchema,
    409: ErrorEnvelopeSchema,
    415: ErrorEnvelopeSchema,
    500: ErrorEnvelopeSchema,
    503: ErrorEnvelopeSchema,
  };
}

type FailureKind =
  | "bad_request"
  | "not_found"
  | "conflict"
  | "unsupported_media_type"
  | "dependency_unavailable"
  | "internal";

class AdminApiFailure extends Error {
  constructor(readonly kind: FailureKind) {
    super(kind);
  }
}

function skillFailure(error: SkillServiceError): FailureKind {
  switch (error.code) {
    case "INVALID_REQUEST":
    case "LIMIT_EXCEEDED":
      return "bad_request";
    case "NOT_FOUND":
      return "not_found";
    case "CONFLICT":
      return "conflict";
    case "DEPENDENCY_UNAVAILABLE":
      return "dependency_unavailable";
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return String((error as { readonly code?: unknown }).code);
}

function isFastifyBadRequest(error: unknown): boolean {
  const code = errorCode(error);
  return (
    (typeof error === "object" &&
      error !== null &&
      "validation" in error &&
      Array.isArray((error as { readonly validation?: unknown }).validation)) ||
    code === "FST_ERR_CTP_BODY_TOO_LARGE" ||
    code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
    code === "FST_ERR_CTP_EMPTY_JSON_BODY"
  );
}

function failureResponse(request: FastifyRequest, failure: FailureKind) {
  const status = {
    bad_request: 400,
    not_found: 404,
    conflict: 409,
    unsupported_media_type: 415,
    dependency_unavailable: 503,
    internal: 500,
  } as const;
  return {
    status: status[failure],
    body: createErrorEnvelope(String(request.id), { kind: failure }),
  };
}

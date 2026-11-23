import type { EvaluationCommand } from "@hoox/persistence/postgres";
import { ErrorEnvelopeSchema, IdSchema, MAX_RUN_INPUT_UTF8_BYTES } from "@hoox/protocol";
import type { FastifyInstance } from "fastify";
import type { ApiDependencies } from "../dependencies.js";
import { requireIdempotencyKey, requireJsonContentType, success } from "../http.js";
import type { AuthenticateRequest } from "../request-auth.js";
import { ApiFailure } from "../service.js";

const receipt = {
  type: "object",
  additionalProperties: false,
  required: ["tenantId", "threadId", "runId"],
  properties: { tenantId: IdSchema, threadId: IdSchema, runId: IdSchema },
};

export function registerPlaygroundRoutes(
  app: FastifyInstance,
  playground: ApiDependencies["playground"],
  authenticate: AuthenticateRequest,
): void {
  if (!playground) return;
  app.post<{
    Body: {
      definitionId: string;
      revisionId: string;
      message: string;
      mocks?: Record<string, unknown>;
    };
  }>(
    "/v1/playground/runs",
    {
      preValidation: async (request) => requireJsonContentType(request),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["definitionId", "revisionId", "message"],
          properties: {
            definitionId: IdSchema,
            revisionId: IdSchema,
            message: { type: "string", minLength: 1, maxLength: MAX_RUN_INPUT_UTF8_BYTES },
            mocks: { type: "object", maxProperties: 64, additionalProperties: true },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["version", "requestId", "data"],
            properties: {
              version: { const: "v1", type: "string" },
              requestId: { type: "string" },
              data: receipt,
            },
          },
          400: ErrorEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          403: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          409: ErrorEnvelopeSchema,
          415: ErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      // 管理身份不来自浏览器；普通 Tenant 切换和集成 Key 都不是试运行授权。
      const auth = await authenticate(request);
      if (
        request.headers["x-tenant-id"] !== undefined ||
        auth.tenant.tenant.kind !== "personal" ||
        auth.tenant.tenant.ownerUserId !== auth.scope.userId ||
        auth.tenant.user.kind !== "human"
      ) {
        throw new ApiFailure("forbidden");
      }
      const { definitionId, revisionId, message } = request.body;
      if (
        !message.trim() ||
        Buffer.byteLength(message) > MAX_RUN_INPUT_UTF8_BYTES ||
        message.includes("\0")
      ) {
        throw new ApiFailure("bad_request");
      }
      const mocks = request.body.mocks ?? {};
      if (Buffer.byteLength(JSON.stringify(mocks)) > 65_536) throw new ApiFailure("bad_request");
      const accepted = await playground.accept({
        scope: auth.scope,
        definitionId,
        revisionId,
        message,
        mocks,
        idempotencyKey: requireIdempotencyKey(request),
      });
      if (!accepted) throw new ApiFailure("forbidden");
      void reply.header("cache-control", "private, no-store");
      return success(request, accepted);
    },
  );
}

export function registerEvaluationCommandRoute(
  app: FastifyInstance,
  capability: ApiDependencies["evaluationCommand"],
): void {
  if (!capability) return;
  app.post<{ Body: Omit<EvaluationCommand, "token"> }>(
    "/internal/evaluation-command",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId", "userId", "generation", "plannedRunId"],
          properties: {
            tenantId: IdSchema,
            userId: IdSchema,
            generation: { type: "string", pattern: "^[0-9]{1,19}$" },
            plannedRunId: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (request, reply) => {
      const token = /^Bearer ([a-f0-9-]{36})$/.exec(request.headers.authorization ?? "")?.[1];
      if (!token) throw new ApiFailure("unauthorized");
      const result = await capability.execute({ ...request.body, token });
      if (result === "stale") throw new ApiFailure("not_found");
      return reply.header("cache-control", "no-store").send({ status: result });
    },
  );
}

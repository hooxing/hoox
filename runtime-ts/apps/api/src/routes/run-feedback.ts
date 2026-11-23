import {
  ErrorEnvelopeSchema,
  type PutRunFeedbackRequest,
  PutRunFeedbackRequestSchema,
  type RunPath,
  RunPathSchema,
  RunFeedbackSuccessEnvelopeSchema,
} from "@hoox/protocol";
import type { FastifyInstance } from "fastify";
import type { ApiDependencies } from "../dependencies.js";
import { requireJsonContentType, success } from "../http.js";
import type { AuthenticateRequest } from "../request-auth.js";
import { ApiFailure } from "../service.js";

export function registerRunFeedbackRoutes(
  app: FastifyInstance,
  dependencies: Pick<ApiDependencies, "runFeedback">,
  authenticate: AuthenticateRequest,
): void {
  for (const method of ["GET", "PUT", "DELETE"] as const) {
    app.route<{ Params: RunPath; Body: PutRunFeedbackRequest }>({
      method,
      url: "/v1/threads/:threadId/runs/:runId/feedback",
      ...(method === "PUT"
        ? { preValidation: async (request) => requireJsonContentType(request) }
        : {}),
      schema: {
        params: RunPathSchema,
        ...(method === "PUT" ? { body: PutRunFeedbackRequestSchema } : {}),
        response: {
          200: RunFeedbackSuccessEnvelopeSchema,
          400: ErrorEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          403: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          415: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
          503: ErrorEnvelopeSchema,
        },
      },
      handler: async (request) => {
        const auth = await authenticate(request, method === "GET" ? "runs:read" : "runs:create");
        if (auth.apiKey !== undefined && auth.principal.kind !== "end_user")
          throw new ApiFailure("forbidden");
        if (dependencies.runFeedback === undefined) throw new ApiFailure("dependency_unavailable");
        const result = await dependencies.runFeedback.execute({
          scope: auth.scope,
          ...request.params,
          operation: method === "GET" ? "get" : method === "PUT" ? "put" : "delete",
          ...(method === "PUT" ? { feedback: request.body } : {}),
        });
        if (typeof result === "string") throw new ApiFailure(result);
        return success(request, result);
      },
    });
  }
}

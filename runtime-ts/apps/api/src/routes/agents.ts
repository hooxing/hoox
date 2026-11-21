import { AvailableAgentListSuccessEnvelopeSchema, ErrorEnvelopeSchema } from "@hoox/protocol";
import type { FastifyInstance } from "fastify";
import type { ApiDependencies } from "../dependencies.js";
import { success } from "../http.js";
import type { AuthenticateRequest } from "../request-auth.js";
import type { ApiService } from "../service.js";

export function registerAgentRoutes(
  app: FastifyInstance,
  dependencies: Pick<ApiDependencies, "agentDefinitions">,
  service: ApiService,
  authenticate: AuthenticateRequest,
): void {
  if (dependencies.agentDefinitions === undefined) return;
  app.get(
    "/v1/agents",
    {
      schema: {
        response: {
          200: AvailableAgentListSuccessEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          403: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
          503: ErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const auth = await authenticate(request, "threads:read");
      return success(request, { items: await service.listAvailableAgents(auth) });
    },
  );
}

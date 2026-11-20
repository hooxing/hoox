import { DomainError, normalizePersonalizationContent } from "@hoox/domain";
import type { PersonalizationSettingsPort } from "@hoox/persistence/postgres";
import {
  ErrorEnvelopeSchema,
  PersonalPersonalizationSuccessEnvelopeSchema,
  type TeamPath,
  TeamPathSchema,
  TeamPersonalizationSuccessEnvelopeSchema,
  type UpdatePersonalPersonalizationRequest,
  UpdatePersonalPersonalizationRequestSchema,
  type UpdateTeamPersonalizationRequest,
  UpdateTeamPersonalizationRequestSchema,
} from "@hoox/protocol";
import type { FastifyInstance } from "fastify";
import { requireJsonContentType, success } from "../http.js";
import type { AuthenticateRequest, AuthenticateSelectedTenant } from "../request-auth.js";
import { requireTeamScope } from "../request-auth.js";
import { ApiFailure } from "../service.js";

export function registerPersonalizationRoutes(
  app: FastifyInstance,
  personalizations: PersonalizationSettingsPort | undefined,
  authenticate: AuthenticateRequest,
  authenticateSelectedTenant: AuthenticateSelectedTenant,
): void {
  if (personalizations !== undefined) {
    app.get(
      "/v1/me/personalization",
      {
        schema: {
          response: {
            200: PersonalPersonalizationSuccessEnvelopeSchema,
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
        if (auth.tenant.tenant.kind !== "personal") throw new ApiFailure("not_found");
        return success(request, await personalizations.getPersonal({ scope: auth.scope }));
      },
    );

    app.put<{ Body: UpdatePersonalPersonalizationRequest }>(
      "/v1/me/personalization",
      {
        preValidation: async (request) => requireJsonContentType(request),
        schema: {
          body: UpdatePersonalPersonalizationRequestSchema,
          response: {
            200: PersonalPersonalizationSuccessEnvelopeSchema,
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
        if (auth.tenant.tenant.kind !== "personal") throw new ApiFailure("not_found");
        const result = await personalizations.updatePersonal({
          scope: auth.scope,
          content: personalizationContent(request.body.content),
          applyToTeamTasks: request.body.applyToTeamTasks,
          expectedVersion: request.body.expectedVersion,
        });
        if (result.outcome === "succeeded") return success(request, result.value);
        throw new ApiFailure(result.outcome === "conflict" ? "conflict" : "not_found");
      },
    );

    app.get<{ Params: TeamPath }>(
      "/v1/teams/:teamId/personalization",
      {
        schema: {
          params: TeamPathSchema,
          response: {
            200: TeamPersonalizationSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const auth = await authenticateSelectedTenant(request, request.params.teamId);
        requireTeamScope(auth, request.params.teamId);
        const value = await personalizations.getTeam({ scope: auth.scope });
        if (value === undefined) throw new ApiFailure("not_found");
        return success(request, value);
      },
    );

    app.put<{ Params: TeamPath; Body: UpdateTeamPersonalizationRequest }>(
      "/v1/teams/:teamId/personalization",
      {
        preValidation: async (request) => requireJsonContentType(request),
        schema: {
          params: TeamPathSchema,
          body: UpdateTeamPersonalizationRequestSchema,
          response: {
            200: TeamPersonalizationSuccessEnvelopeSchema,
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
        const auth = await authenticateSelectedTenant(request, request.params.teamId);
        requireTeamScope(auth, request.params.teamId);
        const result = await personalizations.updateTeam({
          scope: auth.scope,
          content: personalizationContent(request.body.content),
          expectedVersion: request.body.expectedVersion,
        });
        if (result.outcome === "succeeded") return success(request, result.value);
        throw new ApiFailure(result.outcome === "conflict" ? "conflict" : "not_found");
      },
    );
  }
}

function personalizationContent(raw: string): string {
  try {
    return normalizePersonalizationContent(raw);
  } catch (error) {
    if (error instanceof DomainError && error.code === "INVALID_ARGUMENT") {
      throw new ApiFailure("bad_request");
    }
    throw error;
  }
}

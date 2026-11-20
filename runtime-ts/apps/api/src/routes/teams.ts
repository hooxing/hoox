import { createHash } from "node:crypto";
import { membershipId, tenantId, userId } from "@hoox/domain";
import {
  type AddTeamMemberRequest,
  AddTeamMemberRequestSchema,
  type ChangeTeamMemberRoleRequest,
  ChangeTeamMemberRoleRequestSchema,
  type CreateTeamRequest,
  CreateTeamRequestSchema,
  ErrorEnvelopeSchema,
  TeamDissolveSuccessEnvelopeSchema,
  TeamListSuccessEnvelopeSchema,
  TeamMemberListSuccessEnvelopeSchema,
  type TeamMemberPath,
  TeamMemberPathSchema,
  TeamMemberRemovalSuccessEnvelopeSchema,
  TeamMembershipSuccessEnvelopeSchema,
  type TeamPath,
  TeamPathSchema,
  TeamSuccessEnvelopeSchema,
} from "@hoox/protocol";
import type { FastifyInstance } from "fastify";
import type { ApiDependencies } from "../dependencies.js";
import { requireIdempotencyKey, requireJsonContentType, success } from "../http.js";
import type { AuthenticateRequest } from "../request-auth.js";
import { requireTeamScope } from "../request-auth.js";
import { ApiFailure } from "../service.js";

export function registerTeamRoutes(
  app: FastifyInstance,
  dependencies: Pick<ApiDependencies, "clock" | "teamCollaboration">,
  authenticate: AuthenticateRequest,
): void {
  if (dependencies.teamCollaboration !== undefined) {
    const teams = dependencies.teamCollaboration;
    app.get(
      "/v1/me/teams",
      {
        schema: {
          response: {
            200: TeamListSuccessEnvelopeSchema,
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
        return success(request, { items: await teams.listForUser({ scope: auth.scope }) });
      },
    );

    app.post<{ Body: CreateTeamRequest }>(
      "/v1/teams",
      {
        preValidation: async (request) => requireJsonContentType(request),
        schema: {
          body: CreateTeamRequestSchema,
          response: {
            200: TeamSuccessEnvelopeSchema,
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
        if (auth.tenant.tenant.kind !== "personal") throw new ApiFailure("invalid_state");
        const displayName = request.body.displayName.trim();
        if (displayName.length === 0 || displayName.length > 200) {
          throw new ApiFailure("bad_request");
        }
        const key = requireIdempotencyKey(request);
        const identity = createHash("sha256")
          .update(`${auth.scope.userId}\0${key}`, "utf8")
          .digest("hex")
          .slice(0, 40);
        const targetTeamId = tenantId(`team_${identity}`);
        const result = await teams.create({
          scope: auth.scope,
          teamId: targetTeamId,
          membershipId: membershipId(`membership_${identity}`),
          displayName,
          createdAt: dependencies.clock.now(),
        });
        if (result.outcome === "succeeded") return success(request, result.value);
        if (result.outcome === "conflict") {
          const replay = (await teams.listForUser({ scope: auth.scope })).find(
            (item) => item.id === targetTeamId,
          );
          if (replay !== undefined && replay.displayName === displayName) {
            return success(request, replay);
          }
        }
        throw teamMutationFailure(result.outcome);
      },
    );

    app.get<{ Params: TeamPath }>(
      "/v1/teams/:teamId/members",
      {
        schema: {
          params: TeamPathSchema,
          response: {
            200: TeamMemberListSuccessEnvelopeSchema,
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
        requireTeamScope(auth, request.params.teamId);
        const items = await teams.listMembers({ scope: auth.scope });
        if (items === undefined) throw new ApiFailure("not_found");
        return success(request, { items });
      },
    );

    app.post<{ Params: TeamPath; Body: AddTeamMemberRequest }>(
      "/v1/teams/:teamId/members",
      {
        preValidation: async (request) => requireJsonContentType(request),
        schema: {
          params: TeamPathSchema,
          body: AddTeamMemberRequestSchema,
          response: {
            200: TeamMembershipSuccessEnvelopeSchema,
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
        requireTeamScope(auth, request.params.teamId);
        const identity = createHash("sha256")
          .update(`${auth.scope.tenantId}\0${request.body.userId}`, "utf8")
          .digest("hex")
          .slice(0, 40);
        const result = await teams.addMember({
          scope: auth.scope,
          targetUserId: userId(request.body.userId),
          membershipId: membershipId(`membership_${identity}`),
          role: request.body.role,
          createdAt: dependencies.clock.now(),
        });
        if (result.outcome !== "succeeded") throw teamMutationFailure(result.outcome);
        return success(request, result.value);
      },
    );

    app.patch<{ Params: TeamMemberPath; Body: ChangeTeamMemberRoleRequest }>(
      "/v1/teams/:teamId/members/:userId",
      {
        preValidation: async (request) => requireJsonContentType(request),
        schema: {
          params: TeamMemberPathSchema,
          body: ChangeTeamMemberRoleRequestSchema,
          response: {
            200: TeamMembershipSuccessEnvelopeSchema,
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
        requireTeamScope(auth, request.params.teamId);
        const result = await teams.changeRole({
          scope: auth.scope,
          targetUserId: userId(request.params.userId),
          role: request.body.role,
        });
        if (result.outcome !== "succeeded") throw teamMutationFailure(result.outcome);
        return success(request, result.value);
      },
    );

    app.delete<{ Params: TeamMemberPath }>(
      "/v1/teams/:teamId/members/:userId",
      {
        schema: {
          params: TeamMemberPathSchema,
          response: {
            200: TeamMemberRemovalSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            422: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const auth = await authenticate(request);
        requireTeamScope(auth, request.params.teamId);
        const result = await teams.removeMember({
          scope: auth.scope,
          targetUserId: userId(request.params.userId),
        });
        if (result.outcome !== "succeeded") throw teamMutationFailure(result.outcome);
        return success(request, { removed: true as const });
      },
    );

    app.delete<{ Params: TeamPath }>(
      "/v1/teams/:teamId",
      {
        schema: {
          params: TeamPathSchema,
          response: {
            200: TeamDissolveSuccessEnvelopeSchema,
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
        requireTeamScope(auth, request.params.teamId);
        const result = await teams.dissolve({ scope: auth.scope });
        if (result.outcome !== "succeeded") throw teamMutationFailure(result.outcome);
        return success(request, { dissolved: true as const });
      },
    );
  }
}

function teamMutationFailure(
  outcome: "not_found" | "not_authorized" | "conflict" | "last_owner" | "user_not_found",
): ApiFailure {
  if (outcome === "conflict") return new ApiFailure("conflict");
  if (outcome === "last_owner") return new ApiFailure("invalid_state");
  return new ApiFailure("not_found");
}

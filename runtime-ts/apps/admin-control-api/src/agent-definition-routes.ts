import { tenantId } from "@hoox/domain";
import {
  type AgentDefinitionAdminRepositoryPort,
  AgentDefinitionValidationError,
} from "@hoox/persistence/admin";
import {
  AdminAgentDefinitionListSchema,
  type AdminAgentGeneration,
  AdminAgentGenerationSchema,
  type AdminPublishAgentRevision,
  AdminPublishAgentRevisionSchema,
  AdminAgentRevisionHistorySchema,
  type AdminCreateAgentDefinition,
  AdminCreateAgentDefinitionSchema,
  type AdminRevokeAgentRevision,
  AdminRevokeAgentRevisionSchema,
  type AdminSaveAgentRevision,
  AdminSaveAgentRevisionSchema,
  type AdminSetAgentAvailability,
  AdminSetAgentAvailabilitySchema,
  AgentDefinitionDtoSchema,
  AgentDefinitionResponseSchema,
  AgentRevisionDtoSchema,
  IdSchema,
  successEnvelopeSchema,
} from "@hoox/protocol";
import { type TSchema, Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";

const base = "/v1/admin/control/agent-definitions";
const strict = { additionalProperties: false } as const;
const definitionPath = Type.Object({ definitionId: IdSchema }, strict);
const revisionPath = Type.Object({ definitionId: IdSchema, revisionId: IdSchema }, strict);
type DefinitionPath = { definitionId: string };
type RevisionPath = DefinitionPath & { revisionId: string };

function availability(value: AdminSetAgentAvailability["availability"]) {
  return value.mode === "selected_tenants"
    ? { mode: value.mode, tenantIds: value.tenantIds.map(tenantId) }
    : value;
}

export function registerAgentDefinitionRoutes(
  app: FastifyInstance,
  agents: AgentDefinitionAdminRepositoryPort,
  helpers: {
    actor: (request: FastifyRequest) => Promise<string>;
    success: (request: FastifyRequest, data: unknown) => unknown;
    requireJson: (request: FastifyRequest) => void;
    idempotencyKey: (request: FastifyRequest) => string;
    notFound: () => never;
    responseSchemas: (schema: object) => object;
  },
): void {
  const { actor, success, requireJson, idempotencyKey, notFound, responseSchemas } = helpers;
  const response = (schema: TSchema) => responseSchemas(successEnvelopeSchema(schema));
  const json = async (request: FastifyRequest) => requireJson(request);
  const command = async (request: FastifyRequest) => ({
    actorUserId: await actor(request),
    idempotencyKey: idempotencyKey(request),
  });
  app.get(
    base,
    { schema: { response: response(AdminAgentDefinitionListSchema) } },
    async (request) => success(request, await agents.listDefinitions(await actor(request))),
  );
  app.get<{ Params: DefinitionPath }>(
    `${base}/:definitionId/revisions`,
    { schema: { params: definitionPath, response: response(AdminAgentRevisionHistorySchema) } },
    async (request) => {
      const result = await agents.listRevisions(await actor(request), request.params.definitionId);
      return success(request, result ?? notFound());
    },
  );
  app.get<{ Params: RevisionPath }>(
    `${base}/:definitionId/revisions/:revisionId`,
    { schema: { params: revisionPath, response: response(AgentRevisionDtoSchema) } },
    async (request) => {
      const result = await agents.readAdminRevision(
        await actor(request),
        request.params.definitionId,
        request.params.revisionId,
      );
      return success(request, result ?? notFound());
    },
  );
  app.post<{ Body: AdminCreateAgentDefinition }>(
    base,
    {
      preValidation: json,
      schema: {
        body: AdminCreateAgentDefinitionSchema,
        response: response(AgentDefinitionResponseSchema),
      },
    },
    async (request, reply) => {
      const result = await agents.createDraft({
        ...(await command(request)),
        ...request.body,
        availability: availability(request.body.availability),
      });
      return reply.code(201).send(success(request, result));
    },
  );
  app.post<{ Params: DefinitionPath; Body: AdminSaveAgentRevision }>(
    `${base}/:definitionId/revisions`,
    {
      preValidation: json,
      schema: {
        params: definitionPath,
        body: AdminSaveAgentRevisionSchema,
        response: response(AgentRevisionDtoSchema),
      },
    },
    async (request, reply) => {
      const result = await agents.createDraftRevision({
        ...(await command(request)),
        ...request.params,
        ...request.body,
      });
      return reply.code(201).send(success(request, result));
    },
  );
  app.post<{ Params: RevisionPath; Body: AdminPublishAgentRevision }>(
    `${base}/:definitionId/revisions/:revisionId/publish`,
    {
      preValidation: json,
      schema: {
        params: revisionPath,
        body: AdminPublishAgentRevisionSchema,
        response: response(AgentDefinitionDtoSchema),
      },
    },
    async (request) =>
      success(
        request,
        await agents.publish({ ...(await command(request)), ...request.params, ...request.body }),
      ),
  );
  app.post<{ Params: DefinitionPath; Body: AdminAgentGeneration }>(
    `${base}/:definitionId/deactivate`,
    {
      preValidation: json,
      schema: {
        params: definitionPath,
        body: AdminAgentGenerationSchema,
        response: response(AgentDefinitionDtoSchema),
      },
    },
    async (request) =>
      success(
        request,
        await agents.deactivate({
          ...(await command(request)),
          ...request.params,
          ...request.body,
        }),
      ),
  );
  app.post<{ Params: RevisionPath; Body: AdminRevokeAgentRevision }>(
    `${base}/:definitionId/revisions/:revisionId/revoke`,
    {
      preValidation: json,
      schema: {
        params: revisionPath,
        body: AdminRevokeAgentRevisionSchema,
        response: response(AgentDefinitionDtoSchema),
      },
    },
    async (request) => {
      const context = await command(request);
      const reason = request.body.reason;
      if (reason.trim().length === 0 || Buffer.byteLength(reason, "utf8") > 500) {
        throw new AgentDefinitionValidationError("撤销原因不能为空，且不得超过 500 字节");
      }
      return success(
        request,
        await agents.revoke({ ...context, ...request.params, ...request.body }),
      );
    },
  );
  app.put<{ Params: DefinitionPath; Body: AdminSetAgentAvailability }>(
    `${base}/:definitionId/availability`,
    {
      preValidation: json,
      schema: {
        params: definitionPath,
        body: AdminSetAgentAvailabilitySchema,
        response: response(AgentDefinitionDtoSchema),
      },
    },
    async (request) =>
      success(
        request,
        await agents.setAvailability({
          ...(await command(request)),
          ...request.params,
          ...request.body,
          availability: availability(request.body.availability),
        }),
      ),
  );
}

import { createHash } from "node:crypto";
import { tenantId, validateAgentRevisionContent } from "@hoox/domain";
import {
  AgentDefinitionAccessError,
  type AgentDefinitionAdminRepositoryPort,
  AgentDefinitionValidationError,
} from "@hoox/persistence/admin";
import { PersistenceError } from "@hoox/persistence/postgres";
import {
  AdminAgentDefinitionListSchema,
  type AdminAgentGeneration,
  AdminAgentGenerationSchema,
  AdminAgentRevisionHistorySchema,
  type AdminCreateAgentDefinition,
  AdminCreateAgentDefinitionSchema,
  type AdminPublishAgentRevision,
  AdminPublishAgentRevisionSchema,
  type AdminRevokeAgentRevision,
  AdminRevokeAgentRevisionSchema,
  type AdminSaveAgentRevision,
  AdminSaveAgentRevisionSchema,
  type AdminSetAgentAvailability,
  AdminSetAgentAvailabilitySchema,
  AgentConfigurationError,
  AgentConfigurationImportRequestSchema,
  AgentDefinitionDtoSchema,
  AgentDefinitionResponseSchema,
  AgentRevisionDtoSchema,
  IdSchema,
  parseAgentConfiguration,
  serializeAgentConfiguration,
  successEnvelopeSchema,
} from "@hoox/protocol";
import { type TSchema, Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const base = "/v1/admin/control/agent-definitions";
const strict = { additionalProperties: false } as const;
const definitionPath = Type.Object({ definitionId: IdSchema }, strict);
const revisionPath = Type.Object({ definitionId: IdSchema, revisionId: IdSchema }, strict);
type DefinitionPath = { definitionId: string };
type RevisionPath = DefinitionPath & { revisionId: string };
type ImportPath = { definitionId?: string };
type ImportBody = { yaml: string; dryRun: boolean; expectedGeneration?: number };

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
  app.get<{ Params: RevisionPath }>(
    `${base}/:definitionId/revisions/:revisionId/export`,
    { schema: { params: revisionPath } },
    async (request, reply) => {
      const result = await agents.readRevisionForExport(
        await actor(request),
        request.params.definitionId,
        request.params.revisionId,
      );
      if (!result) return notFound();
      const yaml = serializeAgentConfiguration({
        schemaVersion: 1,
        definition: {
          id: result.definition.id,
          availability: result.definition.availability,
        },
        revision: {
          content: result.revision.content,
          ...(result.revision.versionNotes === undefined
            ? {}
            : { versionNotes: result.revision.versionNotes }),
        },
      });
      return reply
        .type("application/yaml; charset=utf-8")
        .header("content-disposition", `attachment; filename="${result.definition.id}.yaml"`)
        .send(yaml);
    },
  );
  const importSchema = { body: AgentConfigurationImportRequestSchema };
  const importConfiguration = async (
    request: FastifyRequest<{ Params: ImportPath; Body: ImportBody }>,
    reply: FastifyReply,
  ) => {
    const actorUserId = await actor(request);
    const imported = (() => {
      try {
        return parseAgentConfiguration(request.body.yaml);
      } catch (error) {
        if (error instanceof AgentConfigurationError && request.body.dryRun) {
          return { errors: error.errors } as const;
        }
        throw error;
      }
    })();
    if ("errors" in imported) {
      return success(request, { valid: false, errors: imported.errors });
    }
    const definitionId = request.params.definitionId;
    const existing = definitionId !== undefined;
    if (existing && request.body.expectedGeneration === undefined) {
      throw new AgentConfigurationError([
        {
          path: "/expectedGeneration",
          code: "INVALID_VALUE",
          message: "追加到现有 Agent 时必须提供 expectedGeneration",
        },
      ]);
    }
    if (
      !existing &&
      request.body.expectedGeneration !== undefined &&
      request.body.expectedGeneration !== 0
    ) {
      throw new AgentConfigurationError([
        {
          path: "/expectedGeneration",
          code: "INVALID_VALUE",
          message: "新建 Agent 的 expectedGeneration 必须为 0",
        },
      ]);
    }
    let content: ReturnType<typeof validateAgentRevisionContent>;
    try {
      content = validateAgentRevisionContent(imported.revision.content);
    } catch {
      const validationErrors = [
        {
          path: "/revision/content",
          code: "INVALID_VALUE",
          message: "Agent Revision 内容不符合领域约束",
        },
      ];
      if (request.body.dryRun) return success(request, { valid: false, errors: validationErrors });
      throw new AgentConfigurationError(validationErrors);
    }
    const importedAvailability = availability(imported.definition.availability);
    if (request.body.dryRun) {
      try {
        await agents.validateImport(actorUserId, {
          id: imported.definition.id,
          availability: importedAvailability,
          content,
          ...(definitionId === undefined ? {} : { definitionId }),
          ...(request.body.expectedGeneration === undefined
            ? {}
            : { expectedGeneration: request.body.expectedGeneration }),
        });
      } catch (error) {
        if (error instanceof AgentDefinitionAccessError) throw error;
        if (error instanceof AgentDefinitionValidationError) {
          return success(request, {
            valid: false,
            errors: [
              {
                path:
                  error.message.includes("Tenant") || error.message.includes("可用范围")
                    ? "/definition/availability"
                    : "/revision/content",
                code: "REFERENCE_INVALID",
                message: error.message,
              },
            ],
          });
        }
        if (error instanceof PersistenceError && error.code === "CONFLICT") {
          return success(request, {
            valid: false,
            errors: [
              {
                path: "/definition/id",
                code: "CONFLICT",
                message: "导入目标不存在、状态已变化或新建 ID 已被占用",
              },
            ],
          });
        }
        if (error instanceof PersistenceError && error.code === "CONSTRAINT_VIOLATION") {
          return success(request, {
            valid: false,
            errors: [
              {
                path: "/definition/availability",
                code: "REFERENCE_INVALID",
                message: "可用范围引用无效或已不存在",
              },
            ],
          });
        }
        throw error;
      }
      return success(request, { valid: true, definitionId: imported.definition.id });
    }
    const idempotency = idempotencyKey(request);
    const revisionId = `agent_revision_import_${createHash("sha256")
      .update(idempotency)
      .digest("hex")
      .slice(0, 32)}`;
    const notes = imported.revision.versionNotes;
    try {
      if (existing) {
        const result = await agents.createDraftRevision({
          actorUserId,
          idempotencyKey: idempotency,
          definitionId,
          revisionId,
          content,
          expectedGeneration: request.body.expectedGeneration as number,
          auditAction: "imported",
          importDefinition: { id: imported.definition.id, availability: importedAvailability },
          ...(notes === undefined ? {} : { versionNotes: notes }),
        });
        return reply.code(201).send(success(request, result));
      }
      const result = await agents.createDraft({
        actorUserId,
        idempotencyKey: idempotency,
        id: imported.definition.id,
        availability: importedAvailability,
        revisionId,
        content,
        expectedGeneration: 0,
        auditAction: "imported",
        ...(notes === undefined ? {} : { versionNotes: notes }),
      });
      return reply.code(201).send(success(request, result));
    } catch (error) {
      if (error instanceof AgentDefinitionAccessError) throw error;
      if (error instanceof AgentDefinitionValidationError) {
        throw new AgentConfigurationError([
          {
            path:
              error.message.includes("Tenant") || error.message.includes("可用范围")
                ? "/definition/availability"
                : "/revision/content",
            code: "REFERENCE_INVALID",
            message: error.message,
          },
        ]);
      }
      if (error instanceof PersistenceError && error.code === "CONSTRAINT_VIOLATION") {
        throw new AgentConfigurationError([
          {
            path: "/definition/availability",
            code: "REFERENCE_INVALID",
            message: "可用范围引用无效或已不存在",
          },
        ]);
      }
      throw error;
    }
  };
  app.post<{ Params: ImportPath; Body: ImportBody }>(
    `${base}/import`,
    { bodyLimit: 6_500_000, preValidation: json, schema: importSchema },
    async (request, reply) => importConfiguration(request, reply),
  );
  app.post<{ Params: DefinitionPath; Body: ImportBody }>(
    `${base}/:definitionId/import`,
    {
      bodyLimit: 6_500_000,
      preValidation: json,
      schema: { ...importSchema, params: definitionPath },
    },
    async (request, reply) => importConfiguration(request, reply),
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

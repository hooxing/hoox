import type { ExternalToolAdminService } from "@hoox/admin-control";
import {
  type AdminCreateMcpDraft,
  AdminCreateMcpDraftSchema,
  AdminExternalToolBatchDtoSchema,
  type AdminExternalToolGeneration,
  AdminExternalToolGenerationSchema,
  AdminExternalToolOverviewSchema,
  type AdminHttpToolPreviewRequest,
  AdminHttpToolPreviewRequestSchema,
  AdminHttpToolPreviewSchema,
  AdminMcpDraftDtoSchema,
  AdminMcpProbeReportSchema,
  type AdminRevokeExternalToolBatch,
  AdminRevokeExternalToolBatchSchema,
  type AdminSetMcpDraftCredential,
  AdminSetMcpDraftCredentialSchema,
  type AdminUpdateMcpDraft,
  AdminUpdateMcpDraftSchema,
  IdSchema,
  successEnvelopeSchema,
} from "@hoox/protocol";
import { type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance, FastifyRequest } from "fastify";

export const EXTERNAL_TOOL_ROUTE_PREFIX = "/v1/admin/control/external-tools";
const base = EXTERNAL_TOOL_ROUTE_PREFIX;
// DNS 和远端交互最多 120 秒，另留一分钟给鉴权、数据库事务与审计。
const probeHandlerTimeout = 180_000;
const probeTimeoutOptions = {
  handlerTimeout: probeHandlerTimeout,
  onRequest: async (request: FastifyRequest) => {
    request.raw.socket?.setTimeout?.(probeHandlerTimeout);
  },
};
const strict = { additionalProperties: false } as const;
const draftPath = Type.Object({ draftId: IdSchema }, strict);
const batchPath = Type.Object({ batchId: IdSchema }, strict);
type DraftPath = { draftId: string };
type BatchPath = { batchId: string };

/** 路由只做协议校验与装配；授权、幂等、generation 与审计由服务与仓储在事务内完成。 */
export function registerExternalToolRoutes(
  app: FastifyInstance,
  service: ExternalToolAdminService,
  helpers: {
    actor: (request: FastifyRequest) => Promise<string>;
    success: (request: FastifyRequest, data: unknown) => unknown;
    requireJson: (request: FastifyRequest) => void;
    idempotencyKey: (request: FastifyRequest) => string;
    responseSchemas: (schema: object) => object;
  },
): void {
  const { actor, success, requireJson, idempotencyKey, responseSchemas } = helpers;
  const response = (schema: TSchema) => responseSchemas(successEnvelopeSchema(schema));
  const json = (schema: TSchema) => async (request: FastifyRequest) => {
    requireJson(request);
    // 不接受 AJV 隐式转换，例如把错误的凭据类型解释为清除凭据。
    if (!Value.Check(schema, request.body)) throw new TypeError("外部工具请求字段不符合要求");
  };
  const command = async (request: FastifyRequest) => ({
    actorUserId: await actor(request),
    idempotencyKey: idempotencyKey(request),
  });

  app.get(
    base,
    { schema: { response: response(AdminExternalToolOverviewSchema) } },
    async (request) => success(request, await service.overview(await actor(request))),
  );
  app.post<{ Body: AdminCreateMcpDraft }>(
    `${base}/mcp-drafts`,
    {
      preValidation: json(AdminCreateMcpDraftSchema),
      schema: { body: AdminCreateMcpDraftSchema, response: response(AdminMcpDraftDtoSchema) },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          success(
            request,
            await service.createMcpDraft({ ...(await command(request)), ...request.body }),
          ),
        ),
  );
  app.put<{ Params: DraftPath; Body: AdminUpdateMcpDraft }>(
    `${base}/mcp-drafts/:draftId`,
    {
      preValidation: json(AdminUpdateMcpDraftSchema),
      schema: {
        params: draftPath,
        body: AdminUpdateMcpDraftSchema,
        response: response(AdminMcpDraftDtoSchema),
      },
    },
    async (request) =>
      success(
        request,
        await service.updateMcpDraft({
          ...(await command(request)),
          ...request.params,
          ...request.body,
        }),
      ),
  );
  app.put<{ Params: DraftPath; Body: AdminSetMcpDraftCredential }>(
    `${base}/mcp-drafts/:draftId/credential`,
    {
      preValidation: json(AdminSetMcpDraftCredentialSchema),
      schema: {
        params: draftPath,
        body: AdminSetMcpDraftCredentialSchema,
        response: response(AdminMcpDraftDtoSchema),
      },
    },
    async (request) =>
      success(
        request,
        await service.setDraftCredential({
          ...(await command(request)),
          ...request.params,
          ...request.body,
        }),
      ),
  );
  app.post<{ Params: DraftPath; Body: AdminExternalToolGeneration }>(
    `${base}/mcp-drafts/:draftId/probe`,
    {
      ...probeTimeoutOptions,
      preValidation: json(AdminExternalToolGenerationSchema),
      schema: {
        params: draftPath,
        body: AdminExternalToolGenerationSchema,
        response: response(AdminMcpProbeReportSchema),
      },
    },
    async (request) =>
      success(
        request,
        await service.probe({
          actorUserId: await actor(request),
          ...request.params,
          ...request.body,
        }),
      ),
  );
  app.post<{ Params: DraftPath; Body: AdminExternalToolGeneration }>(
    `${base}/mcp-drafts/:draftId/publish`,
    {
      ...probeTimeoutOptions,
      preValidation: json(AdminExternalToolGenerationSchema),
      schema: {
        params: draftPath,
        body: AdminExternalToolGenerationSchema,
        response: response(AdminExternalToolBatchDtoSchema),
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        success(
          request,
          await service.publish({
            ...(await command(request)),
            ...request.params,
            ...request.body,
          }),
        ),
      ),
  );
  app.post<{ Params: BatchPath; Body: AdminRevokeExternalToolBatch }>(
    `${base}/batches/:batchId/revoke`,
    {
      preValidation: json(AdminRevokeExternalToolBatchSchema),
      schema: {
        params: batchPath,
        body: AdminRevokeExternalToolBatchSchema,
        response: response(AdminExternalToolBatchDtoSchema),
      },
    },
    async (request) =>
      success(
        request,
        await service.revokeBatch({
          ...(await command(request)),
          ...request.params,
          ...request.body,
        }),
      ),
  );
  app.post<{ Body: AdminHttpToolPreviewRequest }>(
    `${base}/http/preview`,
    {
      preValidation: json(AdminHttpToolPreviewRequestSchema),
      schema: {
        body: AdminHttpToolPreviewRequestSchema,
        response: response(AdminHttpToolPreviewSchema),
      },
    },
    async (request) =>
      success(request, await service.previewHttpTool(await actor(request), request.body)),
  );
}

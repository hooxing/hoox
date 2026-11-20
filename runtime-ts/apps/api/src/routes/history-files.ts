import {
  ErrorEnvelopeSchema,
  type HistoryFileDownloadPath,
  HistoryFileDownloadPathSchema,
  HistoryFileDownloadSuccessEnvelopeSchema,
  type HistoryFileListQuery,
  HistoryFileListQuerySchema,
  HistoryFilePageSuccessEnvelopeSchema,
  type ImportTeamFileRequest,
  ImportTeamFileRequestSchema,
  type UploadedResourceDto,
  UploadedResourceSuccessEnvelopeSchema,
} from "@hoox/protocol";
import type { HistoryFileLibraryFile } from "@hoox/resource";
import type { FastifyInstance } from "fastify";
import type { ApiDependencies } from "../dependencies.js";
import {
  isInlineBinaryPreviewMediaType,
  safeDownloadName,
  validateFileDeliveryUrl,
} from "../file-delivery.js";
import { requireIdempotencyKey, requireJsonContentType, success } from "../http.js";
import type { AuthenticateRequest, AuthenticateSelectedTenant } from "../request-auth.js";
import { ApiFailure } from "../service.js";

export function registerHistoryFileRoutes(
  app: FastifyInstance,
  dependencies: Pick<ApiDependencies, "blobs" | "historyFiles" | "resourceUploads">,
  authenticate: AuthenticateRequest,
  authenticateSelectedTenant: AuthenticateSelectedTenant,
): void {
  if (dependencies.historyFiles !== undefined && dependencies.blobs !== undefined) {
    const historyFiles = dependencies.historyFiles;
    const blobs = dependencies.blobs;
    app.get<{ Querystring: HistoryFileListQuery }>(
      "/v1/me/history-files",
      {
        schema: {
          querystring: HistoryFileListQuerySchema,
          response: {
            200: HistoryFilePageSuccessEnvelopeSchema,
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
        if (
          (request.query.beforeLastFileAt === undefined) !==
          (request.query.beforeThreadId === undefined)
        ) {
          throw new ApiFailure("bad_request");
        }
        const page = await historyFiles.list({
          context: auth.scope,
          ...(request.query.q === undefined ? {} : { query: request.query.q }),
          ...(request.query.activeAfter === undefined
            ? {}
            : { activeAfter: request.query.activeAfter }),
          ...(request.query.activeBefore === undefined
            ? {}
            : { activeBefore: request.query.activeBefore }),
          ...(request.query.beforeLastFileAt === undefined ||
          request.query.beforeThreadId === undefined
            ? {}
            : {
                before: {
                  lastFileAt: request.query.beforeLastFileAt,
                  threadId: request.query.beforeThreadId,
                },
              }),
          ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
        });
        return success(request, {
          ...page,
          items: page.items.map((task) => ({
            ...task,
            files: task.files.map(historyFileDto),
          })),
        });
      },
    );

    for (const [path, disposition] of [
      ["/v1/me/history-files/:resourceId/versions/:versionId/download", "download"],
      ["/v1/me/history-files/:resourceId/versions/:versionId/preview", "preview"],
    ] as const) {
      app.get<{ Params: HistoryFileDownloadPath }>(
        path,
        {
          schema: {
            params: HistoryFileDownloadPathSchema,
            response: {
              200: HistoryFileDownloadSuccessEnvelopeSchema,
              400: ErrorEnvelopeSchema,
              401: ErrorEnvelopeSchema,
              404: ErrorEnvelopeSchema,
              422: ErrorEnvelopeSchema,
              500: ErrorEnvelopeSchema,
              503: ErrorEnvelopeSchema,
            },
          },
        },
        async (request, reply) => {
          void reply.header("cache-control", "private, no-store");
          void reply.header("pragma", "no-cache");
          const auth = await authenticate(request);
          const file = await historyFiles.resolve({
            context: auth.scope,
            resourceId: request.params.resourceId,
            versionId: request.params.versionId,
          });
          if (disposition === "preview" && !isInlineBinaryPreviewMediaType(file.mediaType)) {
            throw new ApiFailure("invalid_state");
          }
          const delivery = await blobs.presignDownload({
            scope: { tenantId: auth.scope.tenantId },
            blob: { kind: "stable", ...file.object },
            ttlSeconds: 300,
            responseMediaType: file.mediaType,
            delivery: disposition === "preview" ? "inline-preview" : "artifact-download",
            ...(disposition === "download"
              ? { downloadName: safeDownloadName(file.entryName, file.resourceId) }
              : {}),
          });
          // 签名后重读历史关系；成员撤销或文件关系漂移时不得留下可用交付 URL。
          const confirmed = await historyFiles.resolve({
            context: auth.scope,
            resourceId: request.params.resourceId,
            versionId: request.params.versionId,
          });
          if (!sameHistoryFileAuthorization(file, confirmed)) throw new ApiFailure("not_found");
          return success(request, {
            file: historyFileDto(file),
            url: validateFileDeliveryUrl(delivery),
            expiresInSeconds: 300,
          });
        },
      );
    }
  }

  if (
    dependencies.historyFiles !== undefined &&
    dependencies.blobs !== undefined &&
    dependencies.resourceUploads !== undefined
  ) {
    app.post<{ Body: ImportTeamFileRequest }>(
      "/v1/me/team-files/import",
      {
        preValidation: async (request) => requireJsonContentType(request),
        schema: {
          body: ImportTeamFileRequestSchema,
          response: {
            200: UploadedResourceSuccessEnvelopeSchema,
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
        const personalAuth = await authenticate(request);
        if (personalAuth.tenant.tenant.kind !== "personal") {
          throw new ApiFailure("invalid_state");
        }
        const teamAuth = await authenticateSelectedTenant(request, request.body.sourceTeamId);
        if (teamAuth.tenant.tenant.kind !== "team") throw new ApiFailure("not_found");
        const source = await dependencies.historyFiles?.resolve({
          context: teamAuth.scope,
          resourceId: request.body.resourceId,
          versionId: request.body.versionId,
        });
        if (source === undefined) throw new ApiFailure("not_found");
        const body = await dependencies.blobs?.getBytes(
          { tenantId: teamAuth.scope.tenantId },
          { kind: "stable", ...source.object },
        );
        if (body === undefined) throw new ApiFailure("not_found");
        const imported = await dependencies.resourceUploads?.upload({
          context: personalAuth.scope,
          idempotencyKey: requireIdempotencyKey(request),
          name: source.name,
          mediaType: source.mediaType,
          body,
        });
        if (imported === undefined) throw new ApiFailure("internal");
        return success(request, imported satisfies UploadedResourceDto);
      },
    );
  }
}

function historyFileDto(file: HistoryFileLibraryFile) {
  return {
    threadId: file.threadId,
    taskName: file.taskName,
    resourceId: file.resourceId,
    versionId: file.versionId,
    name: file.name,
    entryName: file.entryName,
    path: file.path,
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    attachedAt: file.attachedAt,
  };
}

function sameHistoryFileAuthorization(
  expected: HistoryFileLibraryFile,
  confirmed: HistoryFileLibraryFile,
): boolean {
  return (
    expected.threadId === confirmed.threadId &&
    expected.resourceId === confirmed.resourceId &&
    expected.versionId === confirmed.versionId &&
    expected.entryName === confirmed.entryName &&
    expected.attachedAt === confirmed.attachedAt &&
    expected.object.tenantId === confirmed.object.tenantId &&
    expected.object.purpose === confirmed.object.purpose &&
    expected.object.sha256 === confirmed.object.sha256 &&
    expected.object.size === confirmed.object.size &&
    expected.object.mediaType === confirmed.object.mediaType &&
    expected.object.incarnationId === confirmed.object.incarnationId &&
    expected.object.physicalObjectKey === confirmed.object.physicalObjectKey
  );
}

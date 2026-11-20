import { runId } from "@hoox/domain";
import type { RunExperienceArtifact } from "@hoox/persistence/postgres";
import {
  ArtifactDeliverySuccessEnvelopeSchema,
  ArtifactListSuccessEnvelopeSchema,
  ErrorEnvelopeSchema,
  type RunArtifactPath,
  RunArtifactPathSchema,
  type RunPath,
  RunPathSchema,
} from "@hoox/protocol";
import type { FastifyInstance } from "fastify";
import type { ApiDependencies } from "../dependencies.js";
import {
  isInlineBinaryPreviewMediaType,
  safeDownloadName,
  validateFileDeliveryUrl,
} from "../file-delivery.js";
import { success } from "../http.js";
import type { AuthenticateRequest } from "../request-auth.js";
import { ApiFailure, type ApiService } from "../service.js";

export function registerArtifactRoutes(
  app: FastifyInstance,
  dependencies: Pick<ApiDependencies, "experience" | "blobs">,
  service: ApiService,
  authenticate: AuthenticateRequest,
): void {
  if (dependencies.experience !== undefined) {
    app.get<{ Params: RunPath }>(
      "/v1/threads/:threadId/runs/:runId/artifacts",
      {
        schema: {
          params: RunPathSchema,
          response: {
            200: ArtifactListSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            403: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const auth = await authenticate(request, "runs:read");
        const run = await service.getRun(auth, request.params.threadId, request.params.runId);
        const read = await dependencies.experience?.listArtifacts({
          scope: auth.scope,
          runId: runId(run.id),
        });
        if (read === undefined || read.outcome === "not_found") throw new ApiFailure("not_found");
        return success(request, {
          items: read.artifacts.map((artifact) => ({
            id: artifact.id,
            tenantId: auth.scope.tenantId,
            threadId: artifact.threadId,
            runId: artifact.runId,
            resourceVersionId: artifact.resourceVersionId,
            name: artifact.name,
            mediaType: artifact.mediaType,
            sizeBytes: artifact.sizeBytes,
            status: "published" as const,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
          })),
        });
      },
    );
  }

  if (dependencies.experience !== undefined && dependencies.blobs !== undefined) {
    app.get<{ Params: RunArtifactPath }>(
      "/v1/threads/:threadId/runs/:runId/artifacts/:artifactId/content",
      { schema: { params: RunArtifactPathSchema } },
      async (request, reply) => {
        const auth = await authenticate(request, "runs:read");
        await service.getRun(auth, request.params.threadId, request.params.runId);
        const lookup = {
          scope: auth.scope,
          runId: runId(request.params.runId),
          artifactId: request.params.artifactId,
        };
        const found = await dependencies.experience?.getArtifact(lookup);
        if (found?.outcome !== "found") throw new ApiFailure("not_found");
        const { MAX_FILE_PREVIEW_BYTES, filePreviewKind } = await import(
          "@hoox/protocol/file-references"
        );
        if (
          found.artifact.sizeBytes > MAX_FILE_PREVIEW_BYTES ||
          filePreviewKind(found.artifact.name, found.artifact.mediaType) === undefined
        )
          throw new ApiFailure("invalid_state");
        const bytes = await dependencies.blobs?.getBytes(
          { tenantId: auth.scope.tenantId },
          found.artifact.blob,
        );
        const confirmed = await dependencies.experience?.getArtifact(lookup);
        if (
          confirmed?.outcome !== "found" ||
          !sameArtifactAuthorization(found.artifact, confirmed.artifact)
        )
          throw new ApiFailure("not_found");
        if (
          bytes === undefined ||
          bytes.byteLength !== found.artifact.sizeBytes ||
          bytes.byteLength > MAX_FILE_PREVIEW_BYTES
        )
          throw new ApiFailure("invalid_state");
        return reply
          .header("cache-control", "no-store")
          .header("x-content-type-options", "nosniff")
          .header("content-disposition", "attachment")
          .header("x-resource-version-id", found.artifact.resourceVersionId)
          .type("application/octet-stream")
          .send(Buffer.from(bytes));
      },
    );
    const artifactDeliverySchema = {
      params: RunArtifactPathSchema,
      response: {
        200: ArtifactDeliverySuccessEnvelopeSchema,
        400: ErrorEnvelopeSchema,
        401: ErrorEnvelopeSchema,
        403: ErrorEnvelopeSchema,
        404: ErrorEnvelopeSchema,
        422: ErrorEnvelopeSchema,
        500: ErrorEnvelopeSchema,
        503: ErrorEnvelopeSchema,
      },
    } as const;
    for (const [path, disposition] of [
      ["/v1/threads/:threadId/runs/:runId/artifacts/:artifactId/preview", "preview"],
      ["/v1/threads/:threadId/runs/:runId/artifacts/:artifactId/download", "download"],
    ] as const) {
      app.get<{ Params: RunArtifactPath }>(
        path,
        { schema: artifactDeliverySchema },
        async (request, reply) => {
          void reply.header("cache-control", "no-store");
          void reply.header("pragma", "no-cache");
          void reply.header("x-content-type-options", "nosniff");
          const auth = await authenticate(request, "runs:read");
          const run = await service.getRun(auth, request.params.threadId, request.params.runId);
          const artifact = await dependencies.experience?.getArtifact({
            scope: auth.scope,
            runId: runId(run.id),
            artifactId: request.params.artifactId,
          });
          if (artifact === undefined || artifact.outcome === "not_found")
            throw new ApiFailure("not_found");
          const textPreview =
            disposition === "preview" && isTextPreviewMediaType(artifact.artifact.mediaType);
          if (
            disposition === "preview" &&
            !textPreview &&
            !isInlineBinaryPreviewMediaType(artifact.artifact.mediaType)
          ) {
            throw new ApiFailure("invalid_state");
          }
          if (textPreview && artifact.artifact.sizeBytes > MAX_TEXT_ARTIFACT_PREVIEW_BYTES) {
            throw new ApiFailure("invalid_state");
          }
          const previewBytes = textPreview
            ? await dependencies.blobs?.getBytes(
                { tenantId: auth.scope.tenantId },
                artifact.artifact.blob,
              )
            : undefined;
          if (
            previewBytes !== undefined &&
            (previewBytes.byteLength !== artifact.artifact.sizeBytes ||
              previewBytes.byteLength > MAX_TEXT_ARTIFACT_PREVIEW_BYTES)
          ) {
            throw new ApiFailure("invalid_state");
          }
          let previewText: string | undefined;
          if (previewBytes !== undefined) {
            try {
              previewText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                previewBytes,
              );
            } catch {
              throw new ApiFailure("invalid_state");
            }
          }
          const delivery = textPreview
            ? undefined
            : await dependencies.blobs?.presignDownload({
                scope: { tenantId: auth.scope.tenantId },
                blob: artifact.artifact.blob,
                ttlSeconds: 300,
                responseMediaType: artifact.artifact.mediaType,
                delivery: disposition === "preview" ? "inline-preview" : "artifact-download",
                ...(disposition === "download"
                  ? {
                      downloadName: safeDownloadName(artifact.artifact.name, artifact.artifact.id),
                    }
                  : {}),
              });
          // 签发 URL 后再读取一次固定身份，避免成员撤销或发布状态变化时留下可用 URL。
          const confirmed = await dependencies.experience?.getArtifact({
            scope: auth.scope,
            runId: runId(run.id),
            artifactId: request.params.artifactId,
          });
          if (
            confirmed === undefined ||
            confirmed.outcome === "not_found" ||
            !sameArtifactAuthorization(artifact.artifact, confirmed.artifact)
          ) {
            throw new ApiFailure("not_found");
          }
          const artifactDto = {
            artifact: {
              id: artifact.artifact.id,
              tenantId: auth.scope.tenantId,
              threadId: artifact.artifact.threadId,
              runId: artifact.artifact.runId,
              resourceVersionId: artifact.artifact.resourceVersionId,
              name: artifact.artifact.name,
              mediaType: artifact.artifact.mediaType,
              sizeBytes: artifact.artifact.sizeBytes,
              status: "published" as const,
              createdAt: artifact.artifact.createdAt,
              updatedAt: artifact.artifact.updatedAt,
            },
          };
          if (previewText !== undefined) {
            return success(request, { ...artifactDto, text: previewText, disposition: "preview" });
          }
          if (delivery === undefined) throw new ApiFailure("not_found");
          return success(request, {
            ...artifactDto,
            url: validateFileDeliveryUrl(delivery),
            expiresInSeconds: 300,
            disposition,
          });
        },
      );
    }
  }
}

const MAX_TEXT_ARTIFACT_PREVIEW_BYTES = 1_024 * 1_024;

function sameArtifactAuthorization(
  expected: RunExperienceArtifact,
  confirmed: RunExperienceArtifact,
): boolean {
  return (
    expected.authorizationRevision === confirmed.authorizationRevision &&
    expected.tenantId === confirmed.tenantId &&
    expected.threadId === confirmed.threadId &&
    expected.runId === confirmed.runId &&
    expected.id === confirmed.id &&
    expected.resourceVersionId === confirmed.resourceVersionId &&
    expected.name === confirmed.name &&
    expected.mediaType === confirmed.mediaType &&
    expected.sizeBytes === confirmed.sizeBytes &&
    expected.createdAt === confirmed.createdAt &&
    expected.updatedAt === confirmed.updatedAt &&
    expected.blob.tenantId === confirmed.blob.tenantId &&
    expected.blob.purpose === confirmed.blob.purpose &&
    expected.blob.sha256 === confirmed.blob.sha256 &&
    expected.blob.size === confirmed.blob.size &&
    expected.blob.mediaType === confirmed.blob.mediaType &&
    expected.blob.incarnationId === confirmed.blob.incarnationId &&
    expected.blob.physicalObjectKey === confirmed.blob.physicalObjectKey
  );
}

function isTextPreviewMediaType(value: string): boolean {
  return /^text\/plain\s*;\s*charset\s*=\s*utf-8\s*$/iu.test(value);
}

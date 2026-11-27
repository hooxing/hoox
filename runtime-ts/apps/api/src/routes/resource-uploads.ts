import { resourceId, resourceVersionId } from "@hoox/domain";
import {
  ErrorEnvelopeSchema,
  type ResourceDownloadPath,
  ResourceDownloadPathSchema,
  ResourceDownloadSuccessEnvelopeSchema,
  UploadedResourceSuccessEnvelopeSchema,
} from "@hoox/protocol";
import { ResourceServiceError, type ResourceUploadPort } from "@hoox/resource";
import type { ResourceFilesystemCatalog, ResourceFilesystemFile } from "@hoox/resource";
import type { BlobStore } from "@hoox/persistence/blob";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { headerValues, requireIdempotencyKey, success } from "../http.js";
import type { AuthenticateRequest } from "../request-auth.js";
import { ApiFailure } from "../service.js";
import { safeDownloadName, validateFileDeliveryUrl } from "../file-delivery.js";

export const MAX_RESOURCE_UPLOAD_BYTES = 16 * 1_024 * 1_024;

export function registerResourceUploadRoutes(
  app: FastifyInstance,
  resourceUploads: ResourceUploadPort | undefined,
  authenticate: AuthenticateRequest,
  downloads?: Readonly<{ catalog: ResourceFilesystemCatalog; blobs: BlobStore }>,
): void {
  if (resourceUploads !== undefined) {
    app.post<{ Body: Buffer }>(
      "/v1/resources/uploads",
      {
        schema: {
          response: {
            200: UploadedResourceSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            409: ErrorEnvelopeSchema,
            413: ErrorEnvelopeSchema,
            415: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const contentType = request.headers["content-type"];
        if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/octet-stream") {
          throw new ApiFailure("unsupported_media_type");
        }
        const auth = await authenticate(request, "runs:create");
        const name = decodeUploadFileName(singleHeader(request, "x-file-name"));
        const mediaType = singleHeader(request, "x-file-media-type") ?? "application/octet-stream";
        try {
          const uploaded = await resourceUploads.upload({
            context: auth.scope,
            idempotencyKey: requireIdempotencyKey(request),
            name,
            mediaType,
            body: new Uint8Array(request.body),
          });
          return success(request, uploaded);
        } catch (error) {
          if (error instanceof ResourceServiceError && error.code === "CONFLICT") {
            throw new ApiFailure("idempotency_conflict");
          }
          throw error;
        }
      },
    );
  }
  if (downloads !== undefined) {
    app.get<{ Params: ResourceDownloadPath }>(
      "/v1/resources/:resourceId/versions/:versionId/download",
      {
        schema: {
          params: ResourceDownloadPathSchema,
          response: {
            200: ResourceDownloadSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            403: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request, reply) => {
        void reply.header("cache-control", "private, no-store");
        void reply.header("pragma", "no-cache");
        void reply.header("x-content-type-options", "nosniff");
        const auth = await authenticate(request, "runs:read");
        const identity = {
          tenantId: auth.scope.tenantId,
          resourceId: resourceId(request.params.resourceId),
          versionId: resourceVersionId(request.params.versionId),
        };
        const file = await downloads.catalog.resolve(identity);
        if (file === undefined) throw new ApiFailure("not_found");
        const url = await downloads.blobs.presignDownload({
          scope: { tenantId: auth.scope.tenantId },
          blob: { kind: "stable", ...file.object },
          ttlSeconds: 300,
          responseMediaType: file.mediaType,
          delivery: "artifact-download",
          downloadName: safeDownloadName(file.name, file.resourceId),
        });
        const confirmed = await downloads.catalog.resolve(identity);
        if (confirmed === undefined || !sameResourceFile(file, confirmed)) {
          throw new ApiFailure("not_found");
        }
        return success(request, {
          resourceId: file.resourceId,
          versionId: file.versionId,
          name: file.name,
          mediaType: file.mediaType,
          sizeBytes: file.sizeBytes,
          url: validateFileDeliveryUrl(url),
          expiresInSeconds: 300,
        });
      },
    );
  }
}

function sameResourceFile(left: ResourceFilesystemFile, right: ResourceFilesystemFile): boolean {
  return (
    left.resourceId === right.resourceId &&
    left.versionId === right.versionId &&
    left.name === right.name &&
    left.path === right.path &&
    left.mediaType === right.mediaType &&
    left.sizeBytes === right.sizeBytes &&
    left.object.tenantId === right.object.tenantId &&
    left.object.purpose === right.object.purpose &&
    left.object.sha256 === right.object.sha256 &&
    left.object.size === right.object.size &&
    left.object.mediaType === right.object.mediaType &&
    left.object.incarnationId === right.object.incarnationId &&
    left.object.physicalObjectKey === right.object.physicalObjectKey
  );
}

function singleHeader(request: FastifyRequest, name: string): string | undefined {
  const values = headerValues(request, name);
  if (values.length > 1) throw new ApiFailure("bad_request");
  return values[0];
}

function decodeUploadFileName(value: string | undefined): string {
  if (value === undefined || value.length > 1_024) throw new ApiFailure("bad_request");
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiFailure("bad_request");
  }
}

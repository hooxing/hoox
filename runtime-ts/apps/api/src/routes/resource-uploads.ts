import {
  ErrorEnvelopeSchema,
  type UploadedResourceDto,
  UploadedResourceSuccessEnvelopeSchema,
} from "@hoox/protocol";
import type { ResourceUploadPort } from "@hoox/resource";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { headerValues, requireIdempotencyKey, success } from "../http.js";
import type { AuthenticateRequest } from "../request-auth.js";
import { ApiFailure } from "../service.js";

export const MAX_RESOURCE_UPLOAD_BYTES = 16 * 1_024 * 1_024;

export function registerResourceUploadRoutes(
  app: FastifyInstance,
  resourceUploads: ResourceUploadPort | undefined,
  authenticate: AuthenticateRequest,
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
        const auth = await authenticate(request);
        const name = decodeUploadFileName(singleHeader(request, "x-file-name"));
        const mediaType = singleHeader(request, "x-file-media-type") ?? "application/octet-stream";
        const uploaded: UploadedResourceDto = await resourceUploads.upload({
          context: auth.scope,
          idempotencyKey: requireIdempotencyKey(request),
          name,
          mediaType,
          body: new Uint8Array(request.body),
        });
        return success(request, uploaded);
      },
    );
  }
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

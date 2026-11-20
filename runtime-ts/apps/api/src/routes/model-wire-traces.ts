import { assertBlobRef, BlobStoreError, sha256Hex } from "@hoox/persistence/blob";
import type { ModelWireTraceBody, ModelWireTraceCursor } from "@hoox/persistence/thread";
import {
  ErrorEnvelopeSchema,
  type ModelWireTraceBodyPath,
  ModelWireTraceBodyPathSchema,
  type ModelWireTraceListQuery,
  ModelWireTraceListQuerySchema,
  ModelWireTraceListSuccessEnvelopeSchema,
  type RunPath,
  RunPathSchema,
} from "@hoox/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDependencies } from "../dependencies.js";
import { success } from "../http.js";
import {
  decodeModelWireTraceCursor,
  encodeModelWireTraceCursor,
  InvalidModelWireTraceCursorError,
} from "../model-wire-trace-cursor.js";
import type { AuthenticateRequest } from "../request-auth.js";
import { ApiFailure, type ApiService } from "../service.js";

export function registerModelWireTraceRoutes(
  app: FastifyInstance,
  dependencies: Pick<ApiDependencies, "blobs" | "modelWireTraces">,
  service: ApiService,
  authenticate: AuthenticateRequest,
): void {
  if (dependencies.modelWireTraces !== undefined && dependencies.blobs !== undefined) {
    app.get<{ Params: RunPath; Querystring: ModelWireTraceListQuery }>(
      "/v1/threads/:threadId/runs/:runId/model-wire-traces",
      {
        schema: {
          params: RunPathSchema,
          querystring: ModelWireTraceListQuerySchema,
          response: {
            200: ModelWireTraceListSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request, reply) => {
        setDiagnosticResponseHeaders(reply);
        const auth = await authenticate(request);
        const run = await service.getRun(auth, request.params.threadId, request.params.runId);
        const cursorScope = {
          tenantId: auth.scope.tenantId,
          userId: auth.scope.userId,
          threadId: request.params.threadId,
          runId: run.id,
        } as const;
        let after: ModelWireTraceCursor | undefined;
        try {
          after =
            request.query.cursor === undefined
              ? undefined
              : decodeModelWireTraceCursor(cursorScope, request.query.cursor);
        } catch (error) {
          if (error instanceof InvalidModelWireTraceCursorError) {
            throw new ApiFailure("bad_request");
          }
          throw error;
        }
        const read = await dependencies.modelWireTraces?.list({
          scope: auth.scope,
          threadId: request.params.threadId,
          runId: run.id,
          limit: request.query.limit ?? 200,
          ...(after === undefined ? {} : { after }),
        });
        if (read === undefined || read.outcome === "not_found") throw new ApiFailure("not_found");
        const last = read.records.at(-1);
        const nextCursor =
          read.nextCursor ??
          (last === undefined
            ? undefined
            : {
                createdAt: last.createdAt,
                attemptId: last.attemptId,
                modelTurn: last.modelTurn,
                transportAttempt: last.transportAttempt,
                part: last.part,
              });
        if (read.hasMore && nextCursor === undefined) throw new ApiFailure("internal");
        return success(request, {
          items: read.records,
          hasMore: read.hasMore,
          ...(nextCursor === undefined
            ? {}
            : { nextCursor: encodeModelWireTraceCursor(cursorScope, nextCursor) }),
        });
      },
    );

    app.get<{ Params: ModelWireTraceBodyPath }>(
      "/v1/threads/:threadId/runs/:runId/model-wire-traces/:attemptId/:modelTurn/:transportAttempt/:part/body",
      {
        schema: {
          params: ModelWireTraceBodyPathSchema,
          response: {
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request, reply) => {
        setDiagnosticResponseHeaders(reply);
        const auth = await authenticate(request);
        const run = await service.getRun(auth, request.params.threadId, request.params.runId);
        const identity = {
          scope: auth.scope,
          threadId: request.params.threadId,
          runId: run.id,
          attemptId: request.params.attemptId,
          modelTurn: request.params.modelTurn,
          transportAttempt: request.params.transportAttempt,
          part: request.params.part,
        } as const;
        const authorized = await dependencies.modelWireTraces?.getBody(identity);
        if (
          authorized === undefined ||
          authorized.outcome === "not_found" ||
          !validTraceBodyAuthorization(auth.scope.tenantId, identity, authorized.body)
        ) {
          throw new ApiFailure("not_found");
        }
        const bytes = await dependencies.blobs?.getBytes(
          { tenantId: auth.scope.tenantId },
          authorized.body.blob,
        );
        if (bytes === undefined) throw new ApiFailure("not_found");
        if (
          bytes.byteLength !== authorized.body.blob.size ||
          sha256Hex(bytes) !== authorized.body.blob.sha256
        ) {
          throw new BlobStoreError("BLOB_INTEGRITY_MISMATCH", "诊断正文完整性校验失败");
        }
        // 对象读取后重验 Membership、过期时间和固定 Blob 身份，拒绝撤权/清理竞态留下正文。
        const confirmed = await dependencies.modelWireTraces?.getBody(identity);
        if (
          confirmed === undefined ||
          confirmed.outcome === "not_found" ||
          !sameTraceBodyAuthorization(authorized.body, confirmed.body)
        ) {
          throw new ApiFailure("not_found");
        }
        void reply
          .type("application/octet-stream")
          .header(
            "content-disposition",
            `inline; filename="model-turn-${request.params.modelTurn}-http-${request.params.transportAttempt}-${request.params.part}.bin"`,
          );
        return reply.send(Buffer.from(bytes));
      },
    );
  }
}

const diagnosticCacheControl = "private, no-store, no-cache, must-revalidate";

function setDiagnosticResponseHeaders(reply: FastifyReply): void {
  void reply
    .header("cache-control", diagnosticCacheControl)
    .header("pragma", "no-cache")
    .header("expires", "0")
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer");
}

function validTraceBodyAuthorization(
  tenant: string,
  identity: Readonly<{
    attemptId: string;
    modelTurn: number;
    transportAttempt: number;
    part: "request" | "response";
  }>,
  body: ModelWireTraceBody,
): boolean {
  try {
    assertBlobRef({ tenantId: tenant }, body.blob);
  } catch {
    return false;
  }
  return (
    body.blob.kind === "stable" &&
    body.blob.tenantId === tenant &&
    body.blob.purpose === "trace" &&
    body.metadata.attemptId === identity.attemptId &&
    body.metadata.modelTurn === identity.modelTurn &&
    body.metadata.transportAttempt === identity.transportAttempt &&
    body.metadata.part === identity.part &&
    body.metadata.persistenceStatus === "stored" &&
    body.metadata.bodyAvailable &&
    body.metadata.sha256 === body.blob.sha256 &&
    body.metadata.size === body.blob.size
  );
}

function sameTraceBodyAuthorization(expected: ModelWireTraceBody, confirmed: ModelWireTraceBody) {
  return (
    expected.metadata.attemptId === confirmed.metadata.attemptId &&
    expected.metadata.modelTurn === confirmed.metadata.modelTurn &&
    expected.metadata.transportAttempt === confirmed.metadata.transportAttempt &&
    expected.metadata.part === confirmed.metadata.part &&
    expected.metadata.captureStatus === confirmed.metadata.captureStatus &&
    expected.metadata.persistenceStatus === confirmed.metadata.persistenceStatus &&
    expected.metadata.captureErrorCode === confirmed.metadata.captureErrorCode &&
    expected.metadata.httpStatus === confirmed.metadata.httpStatus &&
    expected.metadata.sha256 === confirmed.metadata.sha256 &&
    expected.metadata.size === confirmed.metadata.size &&
    expected.metadata.bodyAvailable === confirmed.metadata.bodyAvailable &&
    expected.metadata.createdAt === confirmed.metadata.createdAt &&
    expected.metadata.expiresAt === confirmed.metadata.expiresAt &&
    expected.blob.tenantId === confirmed.blob.tenantId &&
    expected.blob.purpose === confirmed.blob.purpose &&
    expected.blob.sha256 === confirmed.blob.sha256 &&
    expected.blob.size === confirmed.blob.size &&
    expected.blob.mediaType === confirmed.blob.mediaType &&
    expected.blob.incarnationId === confirmed.blob.incarnationId &&
    expected.blob.physicalObjectKey === confirmed.blob.physicalObjectKey
  );
}

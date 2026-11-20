import { BlobStoreError } from "@hoox/persistence/blob";
import { PersistenceError } from "@hoox/persistence/postgres";
import { createErrorEnvelope, type ErrorEnvelope } from "@hoox/protocol";
import { ResourceServiceError } from "@hoox/resource";
import { SkillServiceError } from "@hoox/skill";
import type { FastifyInstance } from "fastify";
import { requestId } from "./http.js";
import { ResourceFilesystemHttpError } from "./resource-filesystem-http.js";
import { ApiFailure, type ApiFailureKind } from "./service.js";

export function registerHttpMiddleware(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply) => {
    void reply.header("x-request-id", requestId(request));
  });
  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        requestId: requestId(request),
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
        responseTimeMs: reply.elapsedTime,
      },
      "HTTP 请求完成",
    );
  });

  app.setErrorHandler((error, request, reply) => {
    let kind: ApiFailureKind;
    let envelope: ErrorEnvelope | undefined;
    const errorShape =
      typeof error === "object" && error !== null
        ? (error as { readonly validation?: unknown; readonly code?: unknown })
        : {};
    if (
      errorShape.validation !== undefined ||
      new Set([
        "FST_ERR_CTP_BODY_TOO_LARGE",
        "FST_ERR_CTP_INVALID_JSON_BODY",
        "FST_ERR_CTP_EMPTY_JSON_BODY",
      ]).has(String(errorShape.code))
    ) {
      kind = "bad_request";
    } else if (errorShape.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      kind = "unsupported_media_type";
    } else if (errorShape.code === "FST_ERR_HANDLER_TIMEOUT") {
      kind = "dependency_unavailable";
    } else if (error instanceof ResourceFilesystemHttpError) {
      void reply.status(error.statusCode).send();
      return;
    } else if (error instanceof ResourceServiceError) {
      kind = resourceFailure(error);
    } else if (error instanceof SkillServiceError) {
      kind = skillFailure(error);
    } else if (error instanceof ApiFailure) {
      kind = error.kind;
    } else if (error instanceof PersistenceError) {
      kind = persistenceFailure(error);
      if (error.code === "AGENT_REVISION_UNAVAILABLE") {
        envelope = createErrorEnvelope(requestId(request), { kind: "agent_revision_unavailable" });
      }
    } else if (error instanceof BlobStoreError) {
      // 对象已经通过业务授权后，签名、完整性或 provider 失败都是依赖异常，不能泄漏内部对象状态。
      kind = "dependency_unavailable";
    } else {
      kind = "internal";
    }
    // 不记录异常消息、请求体或 Header，避免驱动细节和凭据进入日志。
    request.log.warn(
      { requestId: requestId(request), route: request.routeOptions.url, failure: kind },
      "HTTP 请求失败",
    );
    void reply
      .status(statusByFailure[kind])
      .send(envelope ?? errorEnvelope(requestId(request), kind));
  });
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send(errorEnvelope(requestId(request), "not_found"));
  });
}

const statusByFailure: Readonly<Record<ApiFailureKind, number>> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_state: 422,
  unsupported_media_type: 415,
  dependency_unavailable: 503,
  internal: 500,
};

function persistenceFailure(error: PersistenceError): ApiFailureKind {
  switch (error.code) {
    case "AGENT_REVISION_UNAVAILABLE":
    case "CONFLICT":
      return "conflict";
    case "UNAVAILABLE":
      return "dependency_unavailable";
    case "CONSTRAINT_VIOLATION":
    case "MIGRATION_MISMATCH":
    case "UNEXPECTED":
      return "internal";
  }
}

function resourceFailure(error: ResourceServiceError): ApiFailureKind {
  switch (error.code) {
    case "INVALID_REQUEST":
    case "LIMIT_EXCEEDED":
    case "PREVIEW_BUDGET_EXCEEDED":
      return "bad_request";
    case "CONFLICT":
      return "conflict";
    case "NOT_FOUND":
    case "NOT_AUTHORIZED":
      return "not_found";
    case "DEPENDENCY_FAILURE":
    case "DEPENDENCY_UNAVAILABLE":
      return "dependency_unavailable";
    case "CONTENT_INTEGRITY_ERROR":
      return "internal";
  }
}

function skillFailure(error: SkillServiceError): ApiFailureKind {
  switch (error.code) {
    case "INVALID_REQUEST":
      return "bad_request";
    case "NOT_FOUND":
      return "not_found";
    case "CONFLICT":
    case "LIMIT_EXCEEDED":
      return "conflict";
    case "DEPENDENCY_UNAVAILABLE":
      return "dependency_unavailable";
  }
}

function errorEnvelope(id: string, kind: ApiFailureKind): ErrorEnvelope {
  return createErrorEnvelope(id, { kind });
}

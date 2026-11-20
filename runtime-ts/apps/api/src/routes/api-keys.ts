import { apiKeyScope, apiKeyAttributes, isoTimestamp, type ApiKeyRecord } from "@hoox/domain";
import {
  ApiKeyCreatedSuccessEnvelopeSchema,
  ApiKeyListSuccessEnvelopeSchema,
  ApiKeyPathSchema,
  ApiKeySuccessEnvelopeSchema,
  CreateApiKeyRequestSchema,
  ErrorEnvelopeSchema,
  type ApiKeyDto,
  type CreateApiKeyRequest,
} from "@hoox/protocol";
import type { FastifyInstance } from "fastify";
import { createApiKeyToken, hashApiKey } from "@hoox/identity";
import type { ApiDependencies } from "../dependencies.js";
import { requireJsonContentType, success } from "../http.js";
import type { AuthenticateRequest } from "../request-auth.js";
import { ApiFailure } from "../service.js";

function dto(record: ApiKeyRecord): ApiKeyDto {
  return {
    id: record.id,
    prefix: record.prefix,
    name: record.name,
    ...(record.note === undefined ? {} : { note: record.note }),
    scopes: [...record.scopes],
    createdAt: record.createdAt,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
    ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt }),
  };
}

function requireTenantAdministrator(auth: Awaited<ReturnType<AuthenticateRequest>>): void {
  const role = auth.tenant.membership.role;
  if (
    auth.tenant.tenant.kind === "personal" ? role !== "owner" : role !== "owner" && role !== "admin"
  ) {
    throw new ApiFailure("not_found");
  }
}

export function registerApiKeyRoutes(
  app: FastifyInstance,
  dependencies: Pick<ApiDependencies, "apiKeys" | "clock">,
  authenticate: AuthenticateRequest,
): void {
  const keys = dependencies.apiKeys;
  if (keys === undefined) return;

  app.get(
    "/v1/api-keys",
    {
      schema: {
        response: {
          200: ApiKeyListSuccessEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          403: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const auth = await authenticate(request);
      requireTenantAdministrator(auth);
      return success(request, { items: (await keys.list(auth.scope)).map(dto) });
    },
  );

  app.post<{ Body: CreateApiKeyRequest }>(
    "/v1/api-keys",
    {
      preValidation: async (request) => requireJsonContentType(request),
      schema: {
        body: CreateApiKeyRequestSchema,
        response: {
          200: ApiKeyCreatedSuccessEnvelopeSchema,
          400: ErrorEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          403: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          415: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const auth = await authenticate(request);
      requireTenantAdministrator(auth);
      const now = dependencies.clock.now();
      const token = createApiKeyToken();
      const metadata = apiKeyAttributes({
        name: request.body.name,
        ...(request.body.note === undefined ? {} : { note: request.body.note }),
        scopes: request.body.scopes.map(apiKeyScope),
        createdAt: now,
        ...(request.body.expiresAt === undefined
          ? {}
          : { expiresAt: isoTimestamp(request.body.expiresAt) }),
      });
      const key = await keys.create({
        scope: auth.scope,
        createdBy: auth.scope.userId,
        keyHash: hashApiKey(token),
        prefix: token.slice(0, 12),
        name: metadata.name,
        ...(metadata.note === undefined ? {} : { note: metadata.note }),
        scopes: metadata.scopes,
        ...(metadata.expiresAt === undefined ? {} : { expiresAt: metadata.expiresAt }),
        now,
      });
      return success(request, { key: dto(key), token });
    },
  );

  app.delete<{ Params: { keyId: string } }>(
    "/v1/api-keys/:keyId",
    {
      schema: {
        params: ApiKeyPathSchema,
        response: {
          200: ApiKeySuccessEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          403: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const auth = await authenticate(request);
      requireTenantAdministrator(auth);
      const key = await keys.revoke(auth.scope, request.params.keyId, dependencies.clock.now());
      if (key === undefined) throw new ApiFailure("not_found");
      return success(request, dto(key));
    },
  );
}

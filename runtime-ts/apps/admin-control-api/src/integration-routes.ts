import { isoTimestamp, type ApiKeyRecord } from "@hoox/domain";
import type { PgIntegrationAdminRepository } from "@hoox/persistence/admin";
import {
  ApiKeyCreatedSuccessEnvelopeSchema,
  ApiKeyListSuccessEnvelopeSchema,
  ApiKeySuccessEnvelopeSchema,
  CreateApiKeyRequestSchema,
  CreateWebhookRequestSchema,
  IdSchema,
  WebhookCreatedSuccessEnvelopeSchema,
  WebhookDeletedSuccessEnvelopeSchema,
  WebhookListSuccessEnvelopeSchema,
  WebhookSecretSuccessEnvelopeSchema,
  WebhookSuccessEnvelopeSchema,
  type ApiKeyDto,
  type CreateApiKeyRequest,
  type CreateWebhookRequest,
} from "@hoox/protocol";
import { validateExternalHttpsTarget } from "@hoox/tool-router";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";

export type IntegrationAdminPort = Pick<
  PgIntegrationAdminRepository,
  | "assertAccess"
  | "listKeys"
  | "createKey"
  | "rotateKey"
  | "revokeKey"
  | "listWebhooks"
  | "createWebhook"
  | "rotateWebhook"
  | "disableWebhook"
  | "removeWebhook"
>;
const base = "/v1/admin/control/integrations/:tenantId";
const tenantPath = Type.Object({ tenantId: IdSchema }, { additionalProperties: false });
const keyPath = Type.Object(
  { tenantId: IdSchema, keyId: IdSchema },
  { additionalProperties: false },
);
const webhookPath = Type.Object(
  { tenantId: IdSchema, webhookId: IdSchema },
  { additionalProperties: false },
);
type TenantPath = { tenantId: string };
type KeyPath = TenantPath & { keyId: string };
type WebhookPath = TenantPath & { webhookId: string };

function keyDto(key: ApiKeyRecord): ApiKeyDto {
  const {
    tenantId: _tenantId,
    integrationUserId: _integrationUserId,
    createdBy: _createdBy,
    ...metadata
  } = key;
  return { ...metadata, scopes: [...key.scopes] };
}

export function registerIntegrationRoutes(
  app: FastifyInstance,
  repository: IntegrationAdminPort,
  helpers: {
    actor(request: FastifyRequest): Promise<string>;
    success(request: FastifyRequest, data: unknown): unknown;
    requireJson(request: FastifyRequest): void;
    responseSchemas(schema: object): object;
    badRequest(): never;
  },
  resolveTarget: typeof validateExternalHttpsTarget = validateExternalHttpsTarget,
): void {
  const { actor, success, requireJson, responseSchemas, badRequest } = helpers;
  app.get<{ Params: TenantPath }>(
    `${base}/api-keys`,
    {
      schema: { params: tenantPath, response: responseSchemas(ApiKeyListSuccessEnvelopeSchema) },
    },
    async (request) =>
      success(request, {
        items: (await repository.listKeys(await actor(request), request.params.tenantId)).map(
          keyDto,
        ),
      }),
  );
  app.post<{ Params: TenantPath; Body: CreateApiKeyRequest }>(
    `${base}/api-keys`,
    {
      preValidation: async (request) => requireJson(request),
      schema: {
        params: tenantPath,
        body: CreateApiKeyRequestSchema,
        response: responseSchemas(ApiKeyCreatedSuccessEnvelopeSchema),
      },
    },
    async (request) => {
      const { expiresAt, ...input } = request.body;
      const result = await repository.createKey(await actor(request), request.params.tenantId, {
        ...input,
        ...(expiresAt === undefined ? {} : { expiresAt: isoTimestamp(expiresAt) }),
      });
      return success(request, { key: keyDto(result.key), token: result.token });
    },
  );
  app.post<{ Params: KeyPath }>(
    `${base}/api-keys/:keyId/rotate`,
    {
      schema: { params: keyPath, response: responseSchemas(ApiKeyCreatedSuccessEnvelopeSchema) },
    },
    async (request) => {
      const result = await repository.rotateKey(
        await actor(request),
        request.params.tenantId,
        request.params.keyId,
      );
      return success(request, { key: keyDto(result.key), token: result.token });
    },
  );
  app.delete<{ Params: KeyPath }>(
    `${base}/api-keys/:keyId`,
    {
      schema: { params: keyPath, response: responseSchemas(ApiKeySuccessEnvelopeSchema) },
    },
    async (request) =>
      success(
        request,
        keyDto(
          await repository.revokeKey(
            await actor(request),
            request.params.tenantId,
            request.params.keyId,
          ),
        ),
      ),
  );
  app.get<{ Params: TenantPath }>(
    `${base}/webhooks`,
    {
      schema: { params: tenantPath, response: responseSchemas(WebhookListSuccessEnvelopeSchema) },
    },
    async (request) =>
      success(request, {
        items: await repository.listWebhooks(await actor(request), request.params.tenantId),
      }),
  );
  app.post<{ Params: TenantPath; Body: CreateWebhookRequest }>(
    `${base}/webhooks`,
    {
      preValidation: async (request) => requireJson(request),
      schema: {
        params: tenantPath,
        body: CreateWebhookRequestSchema,
        response: responseSchemas(WebhookCreatedSuccessEnvelopeSchema),
      },
    },
    async (request) => {
      const user = await actor(request);
      const tenant = request.params.tenantId;
      await repository.assertAccess(user, tenant);
      const handlerTimeout = request.routeOptions.handlerTimeout;
      const deadline =
        handlerTimeout > 0 ? Math.min(3_000, Math.max(1, Math.floor(handlerTimeout / 2))) : 3_000;
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(deadline)]);
      let cancel!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new Error("WEBHOOK_REGISTRATION_CANCELLED"));
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      });
      let endpointUrl: string;
      try {
        endpointUrl = (
          await Promise.race([resolveTarget(request.body.endpointUrl, { signal }), cancelled])
        ).url.toString();
        if (signal.aborted) return badRequest();
      } catch {
        return badRequest();
      } finally {
        signal.removeEventListener("abort", cancel);
      }
      return success(
        request,
        await repository.createWebhook(user, tenant, { ...request.body, endpointUrl }),
      );
    },
  );
  app.post<{ Params: WebhookPath }>(
    `${base}/webhooks/:webhookId/rotate-secret`,
    {
      schema: {
        params: webhookPath,
        response: responseSchemas(WebhookSecretSuccessEnvelopeSchema),
      },
    },
    async (request) =>
      success(
        request,
        await repository.rotateWebhook(
          await actor(request),
          request.params.tenantId,
          request.params.webhookId,
        ),
      ),
  );
  app.post<{ Params: WebhookPath }>(
    `${base}/webhooks/:webhookId/disable`,
    {
      schema: { params: webhookPath, response: responseSchemas(WebhookSuccessEnvelopeSchema) },
    },
    async (request) =>
      success(
        request,
        await repository.disableWebhook(
          await actor(request),
          request.params.tenantId,
          request.params.webhookId,
        ),
      ),
  );
  app.delete<{ Params: WebhookPath }>(
    `${base}/webhooks/:webhookId`,
    {
      schema: {
        params: webhookPath,
        response: responseSchemas(WebhookDeletedSuccessEnvelopeSchema),
      },
    },
    async (request) =>
      success(
        request,
        await repository.removeWebhook(
          await actor(request),
          request.params.tenantId,
          request.params.webhookId,
        ),
      ),
  );
}

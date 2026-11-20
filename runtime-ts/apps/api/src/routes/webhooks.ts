import { randomBytes, randomUUID } from "node:crypto";
import {
  CreateWebhookRequestSchema,
  WebhookCreatedSuccessEnvelopeSchema,
  WebhookDeletedSuccessEnvelopeSchema,
  WebhookListSuccessEnvelopeSchema,
  WebhookPathSchema,
  WebhookSecretSuccessEnvelopeSchema,
  WebhookSuccessEnvelopeSchema,
  type WebhookEventType,
  type CreateWebhookRequest,
} from "@hoox/protocol";
import type { FastifyInstance } from "fastify";
import { validateExternalHttpsTarget } from "@hoox/tool-router";
import type { ApiDependencies } from "../dependencies.js";
import { requireJsonContentType, success } from "../http.js";
import type { AuthenticateRequest } from "../request-auth.js";
import { ApiFailure } from "../service.js";

const eventTypes = new Set<WebhookEventType>([
  "run.waiting",
  "run.requires_action",
  "run.succeeded",
  "run.failed",
  "run.cancelled",
  "artifact.published",
]);
function requireAdmin(auth: Awaited<ReturnType<AuthenticateRequest>>): void {
  if (auth.apiKey?.scopes.includes("webhooks:manage")) return;
  const role = auth.tenant.membership.role;
  if (
    auth.tenant.tenant.kind === "personal" ? role !== "owner" : role !== "owner" && role !== "admin"
  )
    throw new ApiFailure("not_found");
}
function secret(): string {
  return randomBytes(32).toString("base64url");
}
export function registerWebhookRoutes(
  app: FastifyInstance,
  deps: Pick<ApiDependencies, "webhooks" | "webhookCipher">,
  authenticate: AuthenticateRequest,
): void {
  const repository = deps.webhooks;
  const cipher = deps.webhookCipher;
  if (!repository || !cipher) return;
  app.get(
    "/v1/webhooks",
    { schema: { response: { 200: WebhookListSuccessEnvelopeSchema } } },
    async (request) => {
      const auth = await authenticate(request, "webhooks:manage");
      requireAdmin(auth);
      return success(request, { items: await repository.list(auth.scope) });
    },
  );
  app.post<{ Body: CreateWebhookRequest }>(
    "/v1/webhooks",
    {
      preValidation: async (request) => requireJsonContentType(request),
      schema: {
        body: CreateWebhookRequestSchema,
        response: { 200: WebhookCreatedSuccessEnvelopeSchema },
      },
    },
    async (request) => {
      const auth = await authenticate(request, "webhooks:manage");
      requireAdmin(auth);
      const body = request.body;
      if (
        typeof body?.name !== "string" ||
        body.name.trim().length < 1 ||
        body.name.length > 120 ||
        typeof body.endpointUrl !== "string" ||
        !Array.isArray(body.eventTypes) ||
        body.eventTypes.length === 0 ||
        body.eventTypes.some((e) => !eventTypes.has(e))
      )
        throw new ApiFailure("bad_request");
      let endpoint: string;
      try {
        endpoint = (await validateExternalHttpsTarget(body.endpointUrl)).url.toString();
      } catch {
        throw new ApiFailure("bad_request");
      }
      const raw = secret();
      const id = `wh_${randomUUID()}`;
      const created = await repository.create({
        scope: auth.scope,
        id,
        name: body.name.trim(),
        endpointUrl: endpoint,
        eventTypes: [...new Set<WebhookEventType>(body.eventTypes)],
        secret: cipher.encrypt(auth.scope.tenantId, id, raw),
      });
      return success(request, { webhook: created, secret: raw });
    },
  );
  app.post<{ Params: { webhookId: string } }>(
    "/v1/webhooks/:webhookId/rotate-secret",
    {
      schema: { params: WebhookPathSchema, response: { 200: WebhookSecretSuccessEnvelopeSchema } },
    },
    async (request) => {
      const auth = await authenticate(request, "webhooks:manage");
      requireAdmin(auth);
      const raw = secret();
      const ok = await repository.rotate(
        auth.scope,
        request.params.webhookId,
        cipher.encrypt(auth.scope.tenantId, request.params.webhookId, raw),
      );
      if (!ok) throw new ApiFailure("not_found");
      return success(request, { secret: raw });
    },
  );
  app.post<{ Params: { webhookId: string } }>(
    "/v1/webhooks/:webhookId/disable",
    { schema: { params: WebhookPathSchema, response: { 200: WebhookSuccessEnvelopeSchema } } },
    async (request) => {
      const auth = await authenticate(request, "webhooks:manage");
      requireAdmin(auth);
      const value = await repository.disable(auth.scope, request.params.webhookId);
      if (!value) throw new ApiFailure("not_found");
      return success(request, { webhook: value });
    },
  );
  app.delete<{ Params: { webhookId: string } }>(
    "/v1/webhooks/:webhookId",
    {
      schema: { params: WebhookPathSchema, response: { 200: WebhookDeletedSuccessEnvelopeSchema } },
    },
    async (request) => {
      const auth = await authenticate(request, "webhooks:manage");
      requireAdmin(auth);
      if (!(await repository.remove(auth.scope, request.params.webhookId)))
        throw new ApiFailure("not_found");
      return success(request, { deleted: true });
    },
  );
}

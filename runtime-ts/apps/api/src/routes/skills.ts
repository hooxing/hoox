import {
  type ConfigureSkillRequest,
  ConfigureSkillRequestSchema,
  ErrorEnvelopeSchema,
  type InstallSkillRequest,
  InstallSkillRequestSchema,
  SkillCatalogPageSuccessEnvelopeSchema,
  type SkillCatalogQuery,
  SkillCatalogQuerySchema,
  SkillInstallationListSuccessEnvelopeSchema,
  SkillInstallationSuccessEnvelopeSchema,
  type SkillPath,
  SkillPathSchema,
  SkillUninstallSuccessEnvelopeSchema,
  type UninstallSkillQuery,
  UninstallSkillQuerySchema,
} from "@hoox/protocol";
import type { SkillCenterService } from "@hoox/skill";
import type { FastifyInstance } from "fastify";
import { requireIdempotencyKey, requireJsonContentType, success } from "../http.js";
import type { AuthenticateRequest } from "../request-auth.js";

export function registerSkillRoutes(
  app: FastifyInstance,
  skillCenter: SkillCenterService | undefined,
  authenticate: AuthenticateRequest,
): void {
  if (skillCenter !== undefined) {
    app.get<{ Querystring: SkillCatalogQuery }>(
      "/v1/skills",
      {
        schema: {
          querystring: SkillCatalogQuerySchema,
          response: {
            200: SkillCatalogPageSuccessEnvelopeSchema,
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
        const page = await skillCenter.browse({
          context: auth.scope,
          ...(request.query.q === undefined ? {} : { query: request.query.q }),
          ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
          ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
        });
        return success(request, {
          items: page.items,
          ...(page.nextCanonicalKey === undefined ? {} : { nextCursor: page.nextCanonicalKey }),
        });
      },
    );

    app.get(
      "/v1/me/skills",
      {
        schema: {
          response: {
            200: SkillInstallationListSuccessEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const auth = await authenticate(request);
        return success(request, { items: await skillCenter.listInstalled(auth.scope) });
      },
    );

    app.put<{ Params: SkillPath; Body: InstallSkillRequest }>(
      "/v1/me/skills/:canonicalKey",
      {
        preValidation: async (request) => requireJsonContentType(request),
        schema: {
          params: SkillPathSchema,
          body: InstallSkillRequestSchema,
          response: {
            200: SkillInstallationSuccessEnvelopeSchema,
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
        const auth = await authenticate(request);
        return success(
          request,
          await skillCenter.install({
            context: auth.scope,
            canonicalKey: request.params.canonicalKey,
            version: request.body.version,
            invocationName: request.body.invocationName,
            idempotencyKey: requireIdempotencyKey(request),
          }),
        );
      },
    );

    app.patch<{ Params: SkillPath; Body: ConfigureSkillRequest }>(
      "/v1/me/skills/:canonicalKey",
      {
        preValidation: async (request) => requireJsonContentType(request),
        schema: {
          params: SkillPathSchema,
          body: ConfigureSkillRequestSchema,
          response: {
            200: SkillInstallationSuccessEnvelopeSchema,
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
        const auth = await authenticate(request);
        return success(
          request,
          await skillCenter.configure({
            context: auth.scope,
            canonicalKey: request.params.canonicalKey,
            expectedVersionToken: request.body.expectedVersionToken,
            ...(request.body.version === undefined ? {} : { version: request.body.version }),
            ...(request.body.invocationName === undefined
              ? {}
              : { invocationName: request.body.invocationName }),
            ...(request.body.enabled === undefined ? {} : { enabled: request.body.enabled }),
            idempotencyKey: requireIdempotencyKey(request),
          }),
        );
      },
    );

    app.delete<{ Params: SkillPath; Querystring: UninstallSkillQuery }>(
      "/v1/me/skills/:canonicalKey",
      {
        schema: {
          params: SkillPathSchema,
          querystring: UninstallSkillQuerySchema,
          response: {
            200: SkillUninstallSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            409: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const auth = await authenticate(request);
        await skillCenter.uninstall({
          context: auth.scope,
          canonicalKey: request.params.canonicalKey,
          expectedVersionToken: request.query.expectedVersionToken,
          idempotencyKey: requireIdempotencyKey(request),
        });
        return success(request, {
          canonicalKey: request.params.canonicalKey,
          uninstalled: true as const,
        });
      },
    );
  }
}

import { userId, type UserId } from "@hoox/domain";
import type { AuthContextResolver } from "@hoox/identity/auth";
import { SkillServiceError, type SkillPublicationService } from "@hoox/skill";
import { createErrorEnvelope, ErrorEnvelopeSchema, IdSchema } from "@hoox/protocol";
import { Type, type Static } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";

const strict = { additionalProperties: false } as const;
const NamespaceParams = Type.Object(
  { namespace: Type.String({ minLength: 1, maxLength: 63 }) },
  strict,
);
const PublisherParams = Type.Object(
  { namespace: Type.String({ minLength: 1, maxLength: 63 }), userId: IdSchema },
  strict,
);
const CreateNamespaceBody = Type.Object(
  { namespace: Type.String({ minLength: 1, maxLength: 63 }) },
  strict,
);
const GrantPublisherBody = Type.Object({ userId: IdSchema }, strict);
const NamespaceList = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          namespace: Type.String(),
          createdBy: IdSchema,
          createdAt: Type.String(),
          publishers: Type.Array(
            Type.Object(
              { userId: IdSchema, grantedBy: IdSchema, grantedAt: Type.String() },
              strict,
            ),
          ),
        },
        strict,
      ),
    ),
  },
  strict,
);

export function registerSkillNamespaceRoutes(
  app: FastifyInstance,
  input: {
    readonly auth: AuthContextResolver;
    readonly publications: Pick<
      SkillPublicationService,
      | "publicationAccess"
      | "listNamespaces"
      | "createNamespace"
      | "grantNamespace"
      | "revokeNamespace"
    >;
  },
): void {
  void app.register(async (routes) => {
    routes.setErrorHandler(async (error, request, reply) => {
      const status = routeStatus(error);
      request.log.warn({ requestId: request.id, status }, "Skill 命名空间管理请求失败");
      await reply.status(status).send(
        createErrorEnvelope(String(request.id), {
          kind:
            status === 400
              ? "bad_request"
              : status === 401
                ? "unauthorized"
                : status === 404
                  ? "not_found"
                  : status === 409
                    ? "conflict"
                    : "internal",
        }),
      );
    });
    routes.get(
      "/v1/admin/control/skill-publication-access",
      {
        schema: {
          response: {
            200: Type.Object(
              {
                version: Type.Literal("v1"),
                requestId: Type.String(),
                data: Type.Object(
                  { role: Type.String(), namespaces: Type.Array(Type.String()) },
                  strict,
                ),
              },
              strict,
            ),
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) =>
        wrap(request, await input.publications.publicationAccess(await actor(request, input.auth))),
    );
    routes.get(
      "/v1/admin/control/skill-namespaces",
      {
        schema: {
          response: {
            200: Type.Object(
              { version: Type.Literal("v1"), requestId: Type.String(), data: NamespaceList },
              strict,
            ),
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) =>
        wrap(request, await input.publications.listNamespaces(await actor(request, input.auth))),
    );
    routes.post<{ Body: { namespace: string } }>(
      "/v1/admin/control/skill-namespaces",
      {
        schema: {
          body: CreateNamespaceBody,
          response: {
            200: Type.Unknown(),
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            409: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const actorUserId = await actor(request, input.auth);
        await input.publications.createNamespace(actorUserId, request.body.namespace);
        return wrap(request, { namespace: request.body.namespace });
      },
    );
    routes.post<{ Params: Static<typeof NamespaceParams>; Body: { userId: string } }>(
      "/v1/admin/control/skill-namespaces/:namespace/publishers",
      {
        schema: {
          params: NamespaceParams,
          body: GrantPublisherBody,
          response: {
            200: Type.Unknown(),
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            409: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        await input.publications.grantNamespace(
          await actor(request, input.auth),
          request.params.namespace,
          userId(request.body.userId),
        );
        return wrap(request, { granted: true });
      },
    );
    routes.delete<{ Params: Static<typeof PublisherParams> }>(
      "/v1/admin/control/skill-namespaces/:namespace/publishers/:userId",
      {
        schema: {
          params: PublisherParams,
          response: {
            200: Type.Unknown(),
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            409: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        await input.publications.revokeNamespace(
          await actor(request, input.auth),
          request.params.namespace,
          userId(request.params.userId),
        );
        return wrap(request, { revoked: true });
      },
    );
  });
}

async function actor(request: FastifyRequest, auth: AuthContextResolver): Promise<UserId> {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") throw new NamespaceRouteFailure(401);
  const principal = await auth.resolve({ authorization, requestId: String(request.id) });
  if (principal === undefined) throw new NamespaceRouteFailure(401);
  return principal.userId;
}

function wrap<T>(request: FastifyRequest, data: T) {
  return { version: "v1" as const, requestId: String(request.id), data };
}

class NamespaceRouteFailure extends Error {
  constructor(readonly status: number) {
    super("Skill 命名空间请求失败");
  }
}

function routeStatus(error: unknown): number {
  if (error instanceof NamespaceRouteFailure) return error.status;
  if (error instanceof SkillServiceError) {
    switch (error.code) {
      case "INVALID_REQUEST":
        return 400;
      case "NOT_FOUND":
        return 404;
      case "CONFLICT":
        return 409;
      case "DEPENDENCY_UNAVAILABLE":
        return 503;
    }
  }
  return 500;
}

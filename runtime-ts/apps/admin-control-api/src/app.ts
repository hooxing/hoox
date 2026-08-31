import { randomUUID } from "node:crypto";
import {
  type AdminControlService,
  AdminControlServiceError,
  type ControlMutationContext,
  digestControlRequest,
  type MemoryProviderConfiguration,
  type ModelProviderConfiguration,
} from "@hoox/admin-control";
import type { AuthContextResolver } from "@hoox/api";
import {
  registerSkillAdminApiRoutes,
  type SkillAdminApiRouteDependencies,
} from "@hoox/skill-admin-api";
import {
  AdminControlOverviewSuccessEnvelopeSchema,
  ControlAuditListSuccessEnvelopeSchema,
  ControlRevisionPathSchema,
  CreateMemoryProviderDraftRequestSchema,
  CreateModelProviderDraftRequestSchema,
  CreateRuntimeSettingsDraftRequestSchema,
  createErrorEnvelope,
  ErrorEnvelopeSchema,
  IdentityAdminConfigurationSuccessEnvelopeSchema,
  MemoryProviderRevisionListSuccessEnvelopeSchema,
  MemoryProviderRevisionSuccessEnvelopeSchema,
  ModelProviderControlRevisionRequestSchema,
  ModelProviderRevisionListSuccessEnvelopeSchema,
  ModelProviderRevisionSuccessEnvelopeSchema,
  PiModelCatalogModelListSuccessEnvelopeSchema,
  PiModelCatalogProviderListSuccessEnvelopeSchema,
  PlatformUserPageSuccessEnvelopeSchema,
  PlatformUserPathSchema,
  PlatformUserQuerySchema,
  PlatformUserSummarySuccessEnvelopeSchema,
  ProbeControlRevisionRequestSchema,
  PublishControlRevisionRequestSchema,
  RuntimeSettingsRevisionListSuccessEnvelopeSchema,
  RuntimeSettingsRevisionSuccessEnvelopeSchema,
  UpdateIdentityAdminConfigurationRequestSchema,
  type UpdateIdentityAdminConfigurationRequest,
  UpdatePlatformUserStatusRequestSchema,
  type ControlRevisionPath,
  type CreateMemoryProviderDraftRequest,
  type CreateModelProviderDraftRequest,
  type CreateRuntimeSettingsDraftRequest,
  type ModelProviderControlRevisionRequest,
  type ProbeControlRevisionRequest,
  type PublishControlRevisionRequest,
  type PlatformUserPath,
  type UpdatePlatformUserStatusRequest,
} from "@hoox/protocol";
import { Type } from "@sinclair/typebox";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { IdentityAdminService } from "./identity-configuration.js";
import type { PiModelCatalogPort } from "./pi-model-catalog.js";

const strict = { additionalProperties: false } as const;
const AuditQuerySchema = Type.Object(
  { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 100 })) },
  strict,
);
const PiModelCatalogQuerySchema = Type.Object(
  {
    providerId: Type.Optional(
      Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,63}$", maxLength: 64 }),
    ),
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  },
  strict,
);

type ControlServiceContract = Pick<
  AdminControlService,
  | "overview"
  | "listModelProviders"
  | "listMemoryProviders"
  | "listRuntimeSettings"
  | "listAudits"
  | "listUsers"
  | "updateUserStatus"
  | "createModelDraft"
  | "createMemoryDraft"
  | "createRuntimeSettingsDraft"
  | "probe"
  | "publish"
>;

export interface AdminControlApiDependencies {
  readonly auth: AuthContextResolver;
  readonly control: ControlServiceContract;
  readonly identity: IdentityAdminService;
  readonly modelCatalog: PiModelCatalogPort;
  readonly skills: Omit<SkillAdminApiRouteDependencies, "auth">;
  readonly readiness: { probe(): Promise<void> };
  readonly now?: () => Date;
}

export interface AdminControlApiAppOptions {
  readonly logger?: boolean;
  readonly trustProxy?: false | ((address: string, hop: number) => boolean);
  readonly https?: Readonly<{
    readonly key: Buffer;
    readonly cert: Buffer;
    readonly minVersion: "TLSv1.2";
  }>;
}

export function createAdminControlApiApp(
  dependencies: AdminControlApiDependencies,
  options: AdminControlApiAppOptions = {},
): FastifyInstance {
  const app = Fastify({
    logger:
      options.logger === true
        ? {
            level: "info",
            redact: {
              paths: ["req.headers.authorization", "req.headers.cookie", "req.body"],
              censor: "[REDACTED]",
            },
          }
        : false,
    bodyLimit: 128 * 1024,
    requestTimeout: 60_000,
    handlerTimeout: 60_000,
    connectionTimeout: 5_000,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    trustProxy: options.trustProxy ?? false,
    ...(options.https === undefined ? {} : { https: options.https }),
    onProtoPoisoning: "error",
    onConstructorPoisoning: "error",
    ajv: {
      customOptions: { removeAdditional: false },
      onCreate: (ajv) => ajv.addFormat("hoox-iso-utc-timestamp-v1", true),
    },
    serializerOpts: { ajv: { formats: { "hoox-iso-utc-timestamp-v1": true } } },
  });
  const now = dependencies.now ?? (() => new Date());

  app.addHook("onSend", async (_request, reply) => {
    void reply
      .header("cache-control", "private, no-store, no-cache, must-revalidate")
      .header("pragma", "no-cache")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer");
  });

  app.setErrorHandler(async (error, request, reply) => {
    const failure = failureKind(error);
    request.log.warn({ failure, requestId: request.id }, "后台控制面请求失败");
    const response = failureResponse(
      String(request.id),
      failure,
      modelConfigurationValidationMessage(error, request, failure),
    );
    await reply.status(response.status).send(response.body);
  });

  app.get("/live", async (request) =>
    success(request, { status: "ok" as const, checkedAt: now().toISOString() }),
  );
  app.get("/ready", async (request) => {
    try {
      await dependencies.readiness.probe();
    } catch {
      throw new AdminControlApiFailure("dependency_unavailable");
    }
    return success(request, { status: "ok" as const, checkedAt: now().toISOString() });
  });

  app.get(
    "/v1/admin/control/overview",
    { schema: { response: responseSchemas(AdminControlOverviewSuccessEnvelopeSchema) } },
    async (request) => success(request, await dependencies.control.overview(await actor(request))),
  );
  app.get(
    "/v1/admin/control/identity",
    { schema: { response: responseSchemas(IdentityAdminConfigurationSuccessEnvelopeSchema) } },
    async (request) =>
      success(request, identityDto(await dependencies.identity.read(await actor(request)))),
  );
  app.put<{ Body: UpdateIdentityAdminConfigurationRequest }>(
    "/v1/admin/control/identity",
    {
      preValidation: async (request) => requireJson(request),
      schema: {
        body: UpdateIdentityAdminConfigurationRequestSchema,
        response: responseSchemas(IdentityAdminConfigurationSuccessEnvelopeSchema),
      },
    },
    async (request) => {
      const providers = Object.fromEntries(
        request.body.providers.map((provider) => [provider.key, provider]),
      ) as Record<"google" | "github" | "wechat" | "qq", (typeof request.body.providers)[number]>;
      if (
        ["google", "github", "wechat", "qq"].some(
          (key) => providers[key as keyof typeof providers] === undefined,
        )
      ) {
        throw new AdminControlApiFailure("bad_request");
      }
      return success(
        request,
        identityDto(
          await dependencies.identity.update(mutationContext(request, await actor(request)), {
            ...request.body,
            providers,
          }),
        ),
      );
    },
  );
  app.get(
    "/v1/admin/control/model-providers",
    { schema: { response: responseSchemas(ModelProviderRevisionListSuccessEnvelopeSchema) } },
    async (request) =>
      success(request, {
        items: await dependencies.control.listModelProviders(await actor(request)),
      }),
  );
  app.get(
    "/v1/admin/control/model-catalog/providers",
    { schema: { response: responseSchemas(PiModelCatalogProviderListSuccessEnvelopeSchema) } },
    async (request) => {
      const userId = await actor(request);
      await dependencies.control.listModelProviders(userId);
      return success(request, { items: dependencies.modelCatalog.listProviders() });
    },
  );
  app.get<{
    Querystring: { readonly providerId?: string; readonly query?: string; readonly limit?: number };
  }>(
    "/v1/admin/control/model-catalog/models",
    {
      schema: {
        querystring: PiModelCatalogQuerySchema,
        response: responseSchemas(PiModelCatalogModelListSuccessEnvelopeSchema),
      },
    },
    async (request) => {
      const userId = await actor(request);
      await dependencies.control.listModelProviders(userId);
      return success(request, {
        items: dependencies.modelCatalog.findModels({
          ...(request.query.providerId === undefined
            ? {}
            : { providerId: request.query.providerId }),
          ...(request.query.query === undefined ? {} : { query: request.query.query }),
          limit: request.query.limit ?? 50,
        }),
      });
    },
  );
  app.get(
    "/v1/admin/control/memory-providers",
    { schema: { response: responseSchemas(MemoryProviderRevisionListSuccessEnvelopeSchema) } },
    async (request) =>
      success(request, {
        items: await dependencies.control.listMemoryProviders(await actor(request)),
      }),
  );
  app.get(
    "/v1/admin/control/runtime-settings",
    { schema: { response: responseSchemas(RuntimeSettingsRevisionListSuccessEnvelopeSchema) } },
    async (request) =>
      success(request, {
        items: await dependencies.control.listRuntimeSettings(await actor(request)),
      }),
  );
  app.get<{ Querystring: { readonly limit?: number } }>(
    "/v1/admin/control/audits",
    {
      schema: {
        querystring: AuditQuerySchema,
        response: responseSchemas(ControlAuditListSuccessEnvelopeSchema),
      },
    },
    async (request) =>
      success(request, {
        items: await dependencies.control.listAudits(await actor(request), request.query.limit),
      }),
  );
  app.get<{
    Querystring: { readonly query?: string; readonly limit?: number };
  }>(
    "/v1/admin/control/users",
    {
      schema: {
        querystring: PlatformUserQuerySchema,
        response: responseSchemas(PlatformUserPageSuccessEnvelopeSchema),
      },
    },
    async (request) =>
      success(
        request,
        await dependencies.control.listUsers(
          await actor(request),
          request.query.query,
          request.query.limit,
        ),
      ),
  );

  app.post<{ Body: CreateModelProviderDraftRequest }>(
    "/v1/admin/control/model-providers",
    {
      schema: {
        body: CreateModelProviderDraftRequestSchema,
        response: responseSchemas(ModelProviderRevisionSuccessEnvelopeSchema),
      },
    },
    async (request) => {
      requireJson(request);
      const userId = await actor(request);
      return success(
        request,
        await dependencies.control.createModelDraft(mutationContext(request, userId), request.body),
      );
    },
  );
  app.post<{ Params: PlatformUserPath; Body: UpdatePlatformUserStatusRequest }>(
    "/v1/admin/control/users/:userId/status",
    {
      schema: {
        params: PlatformUserPathSchema,
        body: UpdatePlatformUserStatusRequestSchema,
        response: responseSchemas(PlatformUserSummarySuccessEnvelopeSchema),
      },
    },
    async (request) => {
      requireJson(request);
      const userId = await actor(request);
      return success(
        request,
        await dependencies.control.updateUserStatus(mutationContext(request, userId), {
          targetUserId: request.params.userId,
          status: request.body.status,
          reason: request.body.reason,
        }),
      );
    },
  );
  app.post<{ Body: CreateMemoryProviderDraftRequest }>(
    "/v1/admin/control/memory-providers",
    {
      schema: {
        body: CreateMemoryProviderDraftRequestSchema,
        response: responseSchemas(MemoryProviderRevisionSuccessEnvelopeSchema),
      },
    },
    async (request) => {
      requireJson(request);
      const userId = await actor(request);
      return success(
        request,
        await dependencies.control.createMemoryDraft(
          mutationContext(request, userId),
          request.body,
        ),
      );
    },
  );
  app.post<{ Body: CreateRuntimeSettingsDraftRequest }>(
    "/v1/admin/control/runtime-settings",
    {
      schema: {
        body: CreateRuntimeSettingsDraftRequestSchema,
        response: responseSchemas(RuntimeSettingsRevisionSuccessEnvelopeSchema),
      },
    },
    async (request) => {
      requireJson(request);
      const userId = await actor(request);
      return success(
        request,
        await dependencies.control.createRuntimeSettingsDraft(
          mutationContext(request, userId),
          request.body,
        ),
      );
    },
  );

  registerProviderActions(app, dependencies, "model_provider", "model-providers");
  registerProviderActions(app, dependencies, "memory_provider", "memory-providers");
  app.post<{ Params: ControlRevisionPath; Body: PublishControlRevisionRequest }>(
    "/v1/admin/control/runtime-settings/:providerKey/revisions/:revision/publish",
    {
      schema: {
        params: ControlRevisionPathSchema,
        body: PublishControlRevisionRequestSchema,
        response: responseSchemas(RuntimeSettingsRevisionSuccessEnvelopeSchema),
      },
    },
    async (request) => {
      requireJson(request);
      const userId = await actor(request);
      return success(
        request,
        await dependencies.control.publish(mutationContext(request, userId), {
          kind: "runtime_settings",
          objectKey: request.params.providerKey,
          revision: request.params.revision,
          command: request.body,
        }),
      );
    },
  );

  registerSkillAdminApiRoutes(app, { auth: dependencies.auth, ...dependencies.skills });

  async function actor(request: FastifyRequest): Promise<string> {
    const principal = await dependencies.auth.resolve({
      authorization: singleHeader(request, "authorization"),
      requestId: String(request.id),
    });
    if (principal === undefined) throw new AdminControlApiFailure("unauthorized");
    return principal.userId;
  }

  return app;
}

function registerProviderActions(
  app: FastifyInstance,
  dependencies: AdminControlApiDependencies,
  kind: "model_provider" | "memory_provider",
  route: "model-providers" | "memory-providers",
): void {
  const response =
    kind === "model_provider"
      ? ModelProviderRevisionSuccessEnvelopeSchema
      : MemoryProviderRevisionSuccessEnvelopeSchema;
  app.post<{
    Params: ControlRevisionPath;
    Body: ProbeControlRevisionRequest | ModelProviderControlRevisionRequest;
  }>(
    `/v1/admin/control/${route}/:providerKey/revisions/:revision/probe`,
    {
      schema: {
        params: ControlRevisionPathSchema,
        body:
          kind === "model_provider"
            ? ModelProviderControlRevisionRequestSchema
            : ProbeControlRevisionRequestSchema,
        response: responseSchemas(response),
      },
    },
    async (request) => {
      requireJson(request);
      const principal = await dependencies.auth.resolve({
        authorization: singleHeader(request, "authorization"),
        requestId: String(request.id),
      });
      if (principal === undefined) throw new AdminControlApiFailure("unauthorized");
      const revisions =
        kind === "model_provider"
          ? await dependencies.control.listModelProviders(principal.userId)
          : await dependencies.control.listMemoryProviders(principal.userId);
      const revision = revisions.find(
        (candidate) =>
          candidate.configuration.providerKey === request.params.providerKey &&
          candidate.revision === request.params.revision,
      );
      if (revision === undefined) throw new AdminControlApiFailure("not_found");
      return success(
        request,
        await dependencies.control.probe(mutationContext(request, principal.userId), {
          kind,
          revision: revision as typeof revision & {
            readonly configuration: ModelProviderConfiguration | MemoryProviderConfiguration;
          },
          expectedVersionToken: request.body.expectedVersionToken,
          ...(kind === "model_provider"
            ? {}
            : { reason: (request.body as ProbeControlRevisionRequest).reason }),
        }),
      );
    },
  );
  app.post<{
    Params: ControlRevisionPath;
    Body: PublishControlRevisionRequest | ModelProviderControlRevisionRequest;
  }>(
    `/v1/admin/control/${route}/:providerKey/revisions/:revision/publish`,
    {
      schema: {
        params: ControlRevisionPathSchema,
        body:
          kind === "model_provider"
            ? ModelProviderControlRevisionRequestSchema
            : PublishControlRevisionRequestSchema,
        response: responseSchemas(response),
      },
    },
    async (request) => {
      requireJson(request);
      const principal = await dependencies.auth.resolve({
        authorization: singleHeader(request, "authorization"),
        requestId: String(request.id),
      });
      if (principal === undefined) throw new AdminControlApiFailure("unauthorized");
      return success(
        request,
        await dependencies.control.publish(mutationContext(request, principal.userId), {
          kind,
          objectKey: request.params.providerKey,
          revision: request.params.revision,
          command:
            kind === "model_provider"
              ? {
                  expectedVersionToken: request.body.expectedVersionToken,
                  reason: "切换当前模型配置",
                }
              : (request.body as PublishControlRevisionRequest),
        }),
      );
    },
  );
}

function identityDto(configuration: import("@hoox/identity").IdentityConfiguration) {
  return {
    versionToken: configuration.versionToken,
    emailPasswordEnabled: configuration.emailPasswordEnabled,
    emailVerificationEnabled: configuration.emailVerificationEnabled,
    ...(configuration.emailFromAddress === undefined
      ? {}
      : { emailFromAddress: configuration.emailFromAddress }),
    ...(configuration.emailFromName === undefined
      ? {}
      : { emailFromName: configuration.emailFromName }),
    ...(configuration.smtpHost === undefined ? {} : { smtpHost: configuration.smtpHost }),
    smtpPort: configuration.smtpPort,
    smtpSecure: configuration.smtpSecure,
    ...(configuration.smtpUsername === undefined
      ? {}
      : { smtpUsername: configuration.smtpUsername }),
    smtpPasswordConfigured: configuration.smtpPasswordConfigured,
    registrationEnabled: configuration.registrationEnabled,
    phoneEnabled: configuration.phoneEnabled,
    ...(configuration.smsWebhookUrl === undefined
      ? {}
      : { smsWebhookUrl: configuration.smsWebhookUrl }),
    smsWebhookSecretConfigured: configuration.smsWebhookSecretConfigured,
    providers: (["google", "github", "wechat", "qq"] as const).map((key) => ({
      key,
      enabled: configuration.providers[key].enabled,
      clientId: configuration.providers[key].clientId,
      secretConfigured: configuration.providers[key].secretConfigured,
    })),
    ...(configuration.updatedAt === undefined ? {} : { updatedAt: configuration.updatedAt }),
    ...(configuration.updatedBy === undefined ? {} : { updatedBy: configuration.updatedBy }),
  };
}
type FailureKind =
  | "bad_request"
  | "unsupported_media_type"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "dependency_unavailable"
  | "internal";

class AdminControlApiFailure extends Error {
  constructor(readonly kind: FailureKind) {
    super(kind);
  }
}

function failureKind(error: unknown): FailureKind {
  if (error instanceof AdminControlApiFailure) return error.kind;
  if (error instanceof Error && error.message === "IDENTITY_ADMIN_NOT_AUTHORIZED")
    return "unauthorized";
  if (error instanceof Error && error.message === "IDENTITY_ADMIN_CONFLICT") return "conflict";
  if (error instanceof TypeError && error.message.startsWith("IDENTITY_")) return "bad_request";
  if (error instanceof TypeError) return "bad_request";
  if (error instanceof AdminControlServiceError) {
    if (error.code === "NOT_AUTHORIZED") return "unauthorized";
    if (error.code === "NOT_FOUND") return "not_found";
    if (error.code === "CONFLICT" || error.code === "KEY_CONFLICT") return "conflict";
    if (error.code === "PROBE_FAILED") return "dependency_unavailable";
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;
  if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") return "unsupported_media_type";
  if (
    (typeof error === "object" &&
      error !== null &&
      "validation" in error &&
      Array.isArray((error as { readonly validation?: unknown }).validation)) ||
    code === "FST_ERR_CTP_BODY_TOO_LARGE" ||
    code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
    code === "FST_ERR_CTP_EMPTY_JSON_BODY"
  ) {
    return "bad_request";
  }
  if (code === "FST_ERR_HANDLER_TIMEOUT") return "dependency_unavailable";
  return "internal";
}

function modelConfigurationValidationMessage(
  error: unknown,
  request: FastifyRequest,
  kind: FailureKind,
): string | undefined {
  if (kind !== "bad_request" || !request.url.includes("/model-providers")) return undefined;
  if (error instanceof TypeError) return error.message;
  return "模型配置字段不符合要求，请检查必填项、地址和数值范围";
}

function failureResponse(requestId: string, kind: FailureKind, message?: string) {
  const status = {
    bad_request: 400,
    unsupported_media_type: 415,
    unauthorized: 401,
    not_found: 404,
    conflict: 409,
    dependency_unavailable: 503,
    internal: 500,
  }[kind];
  const protocolKind = kind === "unsupported_media_type" ? kind : kind;
  const envelope = createErrorEnvelope(requestId, {
    kind: protocolKind === "internal" ? "internal" : protocolKind,
  });
  return {
    status,
    body: message === undefined ? envelope : { ...envelope, error: { ...envelope.error, message } },
  } as const;
}

function responseSchemas(successSchema: object) {
  return {
    200: successSchema,
    201: successSchema,
    400: ErrorEnvelopeSchema,
    401: ErrorEnvelopeSchema,
    404: ErrorEnvelopeSchema,
    409: ErrorEnvelopeSchema,
    415: ErrorEnvelopeSchema,
    500: ErrorEnvelopeSchema,
    503: ErrorEnvelopeSchema,
  };
}

function success(request: FastifyRequest, data: unknown) {
  return { version: "v1" as const, requestId: String(request.id), data };
}

function singleHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) throw new AdminControlApiFailure("bad_request");
  return String(value);
}

function requireJson(request: FastifyRequest): void {
  const type = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new AdminControlApiFailure("unsupported_media_type");
}

function mutationContext(request: FastifyRequest, actorUserId: string): ControlMutationContext {
  const idempotencyKey = singleHeader(request, "idempotency-key");
  if (
    idempotencyKey === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(idempotencyKey)
  ) {
    throw new AdminControlApiFailure("bad_request");
  }
  return Object.freeze({
    actorUserId,
    idempotencyKey,
    requestDigest: digestControlRequest({
      method: request.method,
      url: request.url,
      body: request.body,
    }),
  });
}

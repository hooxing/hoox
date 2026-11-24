import { InstallationAttemptLimiter, installationAccessAllowed } from "@hoox/identity";
import {
  type LoginAccountRequest,
  LoginAccountRequestSchema,
  type RegisterAccountRequest,
  RegisterAccountRequestSchema,
} from "@hoox/protocol";
import type { FastifyInstance, FastifyRequest, FastifySchema } from "fastify";
import type { ApiDependencies } from "../dependencies.js";
import { requestId, requireJsonContentType, success } from "../http.js";
import type { LocalAccountAuthService } from "../local-account-auth.js";
import { authorization } from "../request-auth.js";
import { ApiFailure } from "../service.js";

export function registerInstallationRoutes(
  app: FastifyInstance,
  installation: NonNullable<ApiDependencies["installation"]>,
  localAccounts: LocalAccountAuthService,
  accountSessionResponses: FastifySchema["response"],
): void {
  const limiter = new InstallationAttemptLimiter();
  const accessAllowed = (request: FastifyRequest) =>
    installationAccessAllowed({
      runtimeEnvironment: installation.runtimeEnvironment,
      ...(installation.setupToken === undefined
        ? {}
        : { configuredToken: installation.setupToken }),
      ...(typeof request.headers["x-hoox-setup-token"] === "string"
        ? { suppliedToken: request.headers["x-hoox-setup-token"] }
        : {}),
      remoteAddress: request.raw.socket.remoteAddress ?? "",
      host: request.headers.host ?? "",
      ...(request.headers.origin === undefined ? {} : { origin: request.headers.origin }),
      forwarded:
        request.headers.forwarded !== undefined ||
        request.headers["x-forwarded-for"] !== undefined ||
        request.headers["x-forwarded-host"] !== undefined,
    });
  app.get("/v1/installation", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const initialized = await installation.repository.initialized();
    return success(request, {
      initialized,
      setupTokenRequired: !initialized && !accessAllowed(request),
    });
  });
  app.post<{ Body: RegisterAccountRequest }>(
    "/v1/installation/administrator",
    {
      preValidation: async (request) => requireJsonContentType(request),
      schema: { body: RegisterAccountRequestSchema, response: accountSessionResponses },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!limiter.accept(request.ip)) throw new ApiFailure("dependency_unavailable");
      if (await installation.repository.initialized()) throw new ApiFailure("conflict");
      if (!accessAllowed(request)) throw new ApiFailure("unauthorized");
      return success(request, await installation.administratorAccounts.register(request.body));
    },
  );
  app.post<{ Body: LoginAccountRequest }>(
    "/v1/installation/login",
    {
      preValidation: async (request) => requireJsonContentType(request),
      schema: { body: LoginAccountRequestSchema, response: accountSessionResponses },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!limiter.accept(request.ip)) throw new ApiFailure("dependency_unavailable");
      const session = await localAccounts.login(request.body);
      if (!(await installation.repository.canStartAdminSession(session.profile.id))) {
        await localAccounts.logout(`Bearer ${session.accessToken}`);
        throw new ApiFailure("unauthorized");
      }
      return success(request, session);
    },
  );
  app.get("/v1/auth/admin-principal", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const principal = await localAccounts.resolve({
      authorization: authorization(request),
      requestId: requestId(request),
    });
    if (
      principal === undefined ||
      !(await installation.repository.canStartAdminSession(principal.userId))
    )
      throw new ApiFailure("unauthorized");
    return success(request, { userId: principal.userId });
  });
}

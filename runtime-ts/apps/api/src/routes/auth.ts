import { userId } from "@hoox/domain";
import {
  AccountProfileSuccessEnvelopeSchema,
  AccountSessionSuccessEnvelopeSchema,
  ErrorEnvelopeSchema,
  IdentityAuthConfigurationSuccessEnvelopeSchema,
  type LoginAccountRequest,
  LoginAccountRequestSchema,
  LogoutAccountSuccessEnvelopeSchema,
  type RegisterAccountRequest,
  RegisterAccountRequestSchema,
} from "@hoox/protocol";
import type { FastifyInstance } from "fastify";
import type { ApiDependencies } from "../dependencies.js";
import { requestId, requireJsonContentType, success } from "../http.js";
import { authorization } from "../request-auth.js";
import { ApiFailure } from "../service.js";
import { registerInstallationRoutes } from "./installation.js";

export function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: Pick<
    ApiDependencies,
    | "embeddedIdentity"
    | "localAccounts"
    | "installation"
    | "localAccountPasswordRoutes"
    | "demoAdminUserId"
  >,
): void {
  if (dependencies.embeddedIdentity !== undefined) {
    const identity = dependencies.embeddedIdentity;
    app.all("/api/auth/*", async (request, reply) => {
      const headers = new Headers();
      for (let index = 0; index + 1 < request.raw.rawHeaders.length; index += 2) {
        const name = request.raw.rawHeaders[index];
        const value = request.raw.rawHeaders[index + 1];
        if (name !== undefined && value !== undefined) headers.append(name, value);
      }
      headers.set("x-hoox-client-ip", request.ip);
      const response = await identity.handle({
        method: request.method,
        path: request.raw.url ?? request.url,
        headers,
        ...(request.body === undefined
          ? {}
          : {
              body: typeof request.body === "string" ? request.body : JSON.stringify(request.body),
            }),
      });
      const setCookies = response.headers.getSetCookie();
      for (const [name, value] of response.headers.entries()) {
        if (name.toLowerCase() !== "set-cookie") void reply.header(name, value);
      }
      if (setCookies.length > 0) void reply.header("set-cookie", setCookies);
      const payload = Buffer.from(await response.arrayBuffer());
      return reply.status(response.status).send(payload.length === 0 ? null : payload);
    });
    app.get(
      "/v1/auth/config",
      { schema: { response: { 200: IdentityAuthConfigurationSuccessEnvelopeSchema } } },
      async (request) => {
        const configuration = await identity.publicConfiguration();
        return success(request, {
          emailPasswordEnabled: configuration.emailPasswordEnabled,
          emailVerificationEnabled: configuration.emailVerificationEnabled,
          registrationEnabled: configuration.registrationEnabled,
          phoneEnabled: configuration.phoneEnabled,
          providers: ["google", "github", "wechat", "qq"].map((key) => ({
            key,
            enabled: configuration.providers[key as keyof typeof configuration.providers].enabled,
          })),
        });
      },
    );
    app.post(
      "/v1/auth/exchange",
      {
        schema: {
          response: { 200: AccountSessionSuccessEnvelopeSchema, 401: ErrorEnvelopeSchema },
        },
      },
      async (request) => {
        const headers = new Headers();
        for (let index = 0; index + 1 < request.raw.rawHeaders.length; index += 2) {
          const name = request.raw.rawHeaders[index];
          const value = request.raw.rawHeaders[index + 1];
          if (name !== undefined && value !== undefined) headers.append(name, value);
        }
        return success(request, await identity.exchange(headers));
      },
    );
  }
  if (dependencies.localAccounts !== undefined) {
    const localAccounts = dependencies.localAccounts;
    const accountSessionResponses = {
      200: AccountSessionSuccessEnvelopeSchema,
      400: ErrorEnvelopeSchema,
      401: ErrorEnvelopeSchema,
      409: ErrorEnvelopeSchema,
      415: ErrorEnvelopeSchema,
      500: ErrorEnvelopeSchema,
      503: ErrorEnvelopeSchema,
    } as const;

    if (dependencies.installation !== undefined) {
      registerInstallationRoutes(
        app,
        dependencies.installation,
        localAccounts,
        accountSessionResponses,
      );
    }

    if (dependencies.localAccountPasswordRoutes ?? dependencies.embeddedIdentity === undefined) {
      app.post<{ Body: RegisterAccountRequest }>(
        "/v1/auth/register",
        {
          preValidation: async (request) => requireJsonContentType(request),
          schema: { body: RegisterAccountRequestSchema, response: accountSessionResponses },
        },
        async (request) => success(request, await localAccounts.register(request.body)),
      );

      app.post<{ Body: LoginAccountRequest }>(
        "/v1/auth/login",
        {
          preValidation: async (request) => requireJsonContentType(request),
          schema: { body: LoginAccountRequestSchema, response: accountSessionResponses },
        },
        async (request) => success(request, await localAccounts.login(request.body)),
      );
    }

    if (dependencies.demoAdminUserId !== undefined) {
      const demoAdminUserId = userId(dependencies.demoAdminUserId);
      app.get("/v1/auth/demo-admin-access", async (request, reply) => {
        const principal = await localAccounts.resolve({
          authorization: authorization(request),
          requestId: requestId(request),
        });
        if (principal?.userId !== demoAdminUserId) throw new ApiFailure("unauthorized");
        return reply.status(204).send();
      });
    }

    app.get(
      "/v1/auth/me",
      {
        schema: {
          response: {
            200: AccountProfileSuccessEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const principal = await localAccounts.resolve({
          authorization: authorization(request),
          requestId: requestId(request),
        });
        if (principal === undefined) throw new ApiFailure("unauthorized");
        const accountProfile = await localAccounts.getProfile(principal);
        if (accountProfile === undefined) throw new ApiFailure("unauthorized");
        return success(request, accountProfile);
      },
    );

    app.post(
      "/v1/auth/logout",
      {
        schema: {
          response: {
            200: LogoutAccountSuccessEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        await localAccounts.logout(authorization(request));
        return success(request, { loggedOut: true as const });
      },
    );
  }
}

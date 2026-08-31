import {
  createEmbeddedBetterAuth,
  emptyIdentityConfiguration,
  type EmbeddedBetterAuth,
  type IdentityConfiguration,
} from "@hoox/identity";
import type { AccountSessionDto } from "@hoox/protocol";
import type { IdentityConfigurationRepository, Pool } from "@hoox/persistence";
import type { LocalAccountAuthService } from "./local-account-auth.js";
import { ApiFailure } from "./service.js";

export interface EmbeddedIdentityAuthService {
  handle(input: {
    readonly method: string;
    readonly path: string;
    readonly headers: Headers;
    readonly body?: string;
  }): Promise<Response>;
  publicConfiguration(): Promise<IdentityConfiguration>;
  exchange(headers: Headers): Promise<AccountSessionDto>;
}

export function createEmbeddedIdentityAuthService(input: {
  readonly database: Pool;
  readonly configurations: IdentityConfigurationRepository;
  readonly localAccounts: LocalAccountAuthService;
  readonly baseURL: string;
  readonly secret: string;
  readonly trustedOrigins?: readonly string[];
}): EmbeddedIdentityAuthService {
  let cached:
    | Readonly<{
        readonly versionToken: number;
        readonly auth: EmbeddedBetterAuth;
        readonly configuration: IdentityConfiguration;
      }>
    | undefined;

  const resolve = async () => {
    const persisted = await input.configurations.read(input.secret);
    const configuration = persisted?.configuration ?? emptyIdentityConfiguration();
    if (cached?.versionToken === configuration.versionToken) return cached;
    const auth = createEmbeddedBetterAuth({
      database: input.database,
      baseURL: input.baseURL,
      secret: input.secret,
      configuration,
      secrets: persisted?.secrets ?? { providerSecrets: {} },
      ...(input.trustedOrigins === undefined ? {} : { trustedOrigins: input.trustedOrigins }),
    });
    cached = Object.freeze({ versionToken: configuration.versionToken, auth, configuration });
    return cached;
  };

  return Object.freeze({
    async handle(request: {
      readonly method: string;
      readonly path: string;
      readonly headers: Headers;
      readonly body?: string;
    }) {
      const method = request.method.toUpperCase();
      const path = new URL(request.path, input.baseURL).pathname;
      const restrictedEmailOtpRoute =
        path === "/api/auth/sign-in/email-otp" ||
        path === "/api/auth/forget-password/email-otp" ||
        path === "/api/auth/send-verification-email" ||
        path === "/api/auth/verify-email" ||
        (path.startsWith("/api/auth/email-otp/") &&
          path !== "/api/auth/email-otp/verify-email" &&
          path !== "/api/auth/email-otp/send-verification-otp");
      if (restrictedEmailOtpRoute) {
        return Response.json({ code: "NOT_FOUND", message: "Not Found" }, { status: 404 });
      }
      if (path === "/api/auth/email-otp/send-verification-otp") {
        let body: unknown;
        try {
          body = request.body === undefined ? undefined : JSON.parse(request.body);
        } catch {
          return Response.json({ code: "BAD_REQUEST", message: "Invalid body" }, { status: 400 });
        }
        if (
          typeof body !== "object" ||
          body === null ||
          !("type" in body) ||
          body.type !== "email-verification"
        ) {
          return Response.json(
            { code: "BAD_REQUEST", message: "Invalid purpose" },
            { status: 400 },
          );
        }
      }
      return (await resolve()).auth.handler(
        new Request(new URL(request.path, input.baseURL), {
          method,
          headers: request.headers,
          ...(method === "GET" || method === "HEAD" || request.body === undefined
            ? {}
            : { body: request.body }),
        }),
      );
    },
    async publicConfiguration() {
      return (await resolve()).configuration;
    },
    async exchange(headers: Headers) {
      const current = await resolve();
      const session = await current.auth.api.getSession({ headers });
      if (session === null) throw new ApiFailure("unauthorized");
      if (current.configuration.emailVerificationEnabled && !session.user.emailVerified) {
        const credential = await input.database.query(
          "SELECT 1 FROM better_auth_accounts WHERE user_id=$1 AND provider_id='credential' LIMIT 1",
          [session.user.id],
        );
        if (credential.rowCount === 1) throw new ApiFailure("unauthorized");
      }
      return input.localAccounts.exchangeBetterAuthIdentity({
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      });
    },
  });
}

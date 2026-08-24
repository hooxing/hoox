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
      const session = await (await resolve()).auth.api.getSession({ headers });
      if (session === null) throw new ApiFailure("unauthorized");
      return input.localAccounts.exchangeBetterAuthIdentity({
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      });
    },
  });
}

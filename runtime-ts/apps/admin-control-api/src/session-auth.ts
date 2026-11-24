import type { AuthContextResolver } from "@hoox/identity/auth";
import { userId } from "@hoox/domain";
import { isAdminAccessToken, type PgAdminAccessTokenRepository } from "@hoox/persistence/admin";

export function createAdminAccessTokenAuthResolver(
  tokens: PgAdminAccessTokenRepository,
  fallback: AuthContextResolver,
): AuthContextResolver {
  return {
    async resolve(request) {
      const authorization = request.authorization;
      if (!authorization?.startsWith("Bearer hoox_at_")) return fallback.resolve(request);
      const token = authorization.slice("Bearer ".length);
      if (!isAdminAccessToken(token)) return undefined;
      const credential = await tokens.authenticate(
        token,
        `${request.route?.method ?? "UNKNOWN"} ${request.route?.path ?? "UNKNOWN"}`,
      );
      if (request.route === undefined) {
        if (credential !== undefined) await tokens.finishUse(credential, false);
        return undefined;
      }
      return credential === undefined
        ? undefined
        : {
            userId: userId(credential.creatorUserId),
            kind: "human",
            adminAccessToken: {
              id: credential.id,
              scopes: credential.scopes,
              auditId: credential.auditId,
              route: credential.route,
            },
          };
    },
  };
}

export function createAdminSessionAuthResolver(
  apiOrigin: string,
  fallback?: AuthContextResolver,
  fetcher: typeof fetch = fetch,
): AuthContextResolver {
  return {
    async resolve(request) {
      if (!request.authorization?.startsWith("Bearer hoox_session_"))
        return fallback?.resolve(request);
      const response = await fetcher(new URL("/v1/auth/admin-principal", apiOrigin), {
        headers: { authorization: request.authorization },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 401 || response.status === 403) return undefined;
      if (!response.ok) throw new Error("ADMIN_IDENTITY_UNAVAILABLE");
      if (response.body === null) throw new Error("ADMIN_IDENTITY_INVALID");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4096) {
            await reader.cancel();
            throw new Error("ADMIN_IDENTITY_INVALID");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const result = JSON.parse(text) as { data?: { userId?: unknown } };
      if (
        typeof result.data?.userId !== "string" ||
        !/^[A-Za-z0-9_-]{3,128}$/.test(result.data.userId)
      )
        throw new Error("ADMIN_IDENTITY_INVALID");
      return { userId: userId(result.data.userId) };
    },
  };
}

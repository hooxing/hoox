import { userId } from "@hoox/domain";
import type { AuthContextResolver } from "@hoox/identity/auth";

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

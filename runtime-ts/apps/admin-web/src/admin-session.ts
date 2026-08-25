const SESSION_STORAGE_KEY = "hoox.auth-session.v2";

type StoredSession = {
  readonly accessToken?: unknown;
  readonly expiresAt?: unknown;
};

export function readAdminAccessToken(
  storage: Pick<Storage, "getItem"> = globalThis.localStorage,
  now: () => number = Date.now,
): string | undefined {
  try {
    const serialized = storage.getItem(SESSION_STORAGE_KEY);
    if (serialized === null) return undefined;
    const session = JSON.parse(serialized) as StoredSession;
    if (
      typeof session.accessToken !== "string" ||
      !session.accessToken.startsWith("hoox_session_") ||
      typeof session.expiresAt !== "string"
    ) {
      return undefined;
    }
    const expiresAt = Date.parse(session.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > now() ? session.accessToken : undefined;
  } catch {
    return undefined;
  }
}

export function adminAuthorizationHeader(): string | undefined {
  const accessToken = readAdminAccessToken();
  return accessToken === undefined ? undefined : `Bearer ${accessToken}`;
}

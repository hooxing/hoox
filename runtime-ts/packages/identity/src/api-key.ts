import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiKeyScope, TenantId, UserId } from "@hoox/domain";

export type AuthPrincipalKind = "human" | "integration";

export const API_KEY_PREFIX = "hoox_sk_";
const secretBytes = 32;
const bearerPattern = /^hoox_sk_[A-Za-z0-9_-]{43}$/u;

export interface ApiKeyPrincipal {
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly apiKeyId: string;
  readonly scopes: readonly ApiKeyScope[];
}

export interface ApiKeyAuthenticationPort {
  authenticateKey(input: {
    readonly token: string;
    readonly now: string;
  }): Promise<ApiKeyPrincipal | undefined>;
}

export function createApiKeyToken(): string {
  return `${API_KEY_PREFIX}${randomBytes(secretBytes).toString("base64url")}`;
}

export function isApiKeyToken(value: string): boolean {
  return bearerPattern.test(value);
}

export function hashApiKey(token: string): Buffer {
  if (!isApiKeyToken(token)) throw new TypeError("API Key 格式无效");
  return createHash("sha256").update(token, "utf8").digest();
}

export function apiKeyHashesMatch(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

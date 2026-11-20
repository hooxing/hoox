import { domainInvariant } from "./errors.js";
import type { IsoTimestamp } from "./ids.js";

export const apiKeyScopes = [
  "threads:read",
  "runs:read",
  "threads:create",
  "runs:create",
  "tool-results:submit",
  "webhooks:manage",
] as const;
export type ApiKeyScope = (typeof apiKeyScopes)[number];

export function apiKeyScope(value: string): ApiKeyScope {
  domainInvariant(
    (apiKeyScopes as readonly string[]).includes(value),
    "INVALID_ARGUMENT",
    "API Key 作用域无效",
  );
  return value as ApiKeyScope;
}

export interface ApiKeyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly integrationUserId: string;
  readonly prefix: string;
  readonly name: string;
  readonly note?: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly createdBy: string;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly revokedAt?: IsoTimestamp;
  readonly lastUsedAt?: IsoTimestamp;
}

export interface ApiKeyAttributes {
  readonly name: string;
  readonly note?: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly createdAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
}

export function apiKeyAttributes(input: ApiKeyAttributes): ApiKeyAttributes {
  domainInvariant(
    input.name.trim().length > 0 && input.name.length <= 120,
    "INVALID_ARGUMENT",
    "API Key 名称无效",
  );
  domainInvariant(
    input.note === undefined || input.note.length <= 500,
    "INVALID_ARGUMENT",
    "API Key 备注过长",
  );
  domainInvariant(
    input.scopes.length > 0 && new Set(input.scopes).size === input.scopes.length,
    "INVALID_ARGUMENT",
    "API Key 作用域无效",
  );
  if (input.expiresAt !== undefined) {
    domainInvariant(
      Date.parse(input.expiresAt) > Date.parse(input.createdAt),
      "INVALID_ARGUMENT",
      "API Key 到期时间必须晚于创建时间",
    );
  }
  return Object.freeze({
    ...input,
    name: input.name.trim(),
    scopes: Object.freeze([...input.scopes]),
  });
}

export function apiKeyMetadata(input: ApiKeyRecord): ApiKeyRecord {
  return Object.freeze({ ...input, ...apiKeyAttributes(input) });
}

export function apiKeyIsActive(
  input: Pick<ApiKeyRecord, "revokedAt" | "expiresAt">,
  now: IsoTimestamp,
): boolean {
  return (
    input.revokedAt === undefined &&
    (input.expiresAt === undefined || Date.parse(input.expiresAt) > Date.parse(now))
  );
}

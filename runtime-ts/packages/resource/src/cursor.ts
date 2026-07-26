import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type IsoTimestamp,
  isoTimestamp,
  resourceId,
  tenantId,
  userId,
} from "@cube-runtime/domain";
import type { ResourceCursorCodec } from "./contracts.js";
import { ResourceServiceError, resourceInvariant } from "./errors.js";

export interface ResourceCursorKey {
  readonly kid: string;
  readonly secret: Uint8Array;
}

export interface ResourceCursorKeyRing {
  readonly activeKid: string;
  readonly keys: readonly ResourceCursorKey[];
  readonly ttlSeconds: number;
  readonly maxTtlSeconds?: number;
  readonly now?: () => Date;
}

interface CursorPayload {
  readonly v: 1;
  readonly kid: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly queryHash: string;
  readonly updatedAt: string;
  readonly resourceId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

const MAX_CURSOR_LENGTH = 2_048;
const KID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export function createResourceCursorCodec(config: ResourceCursorKeyRing): ResourceCursorCodec {
  const maxTtlSeconds = config.maxTtlSeconds ?? 86_400;
  resourceInvariant(
    Number.isSafeInteger(config.ttlSeconds) &&
      config.ttlSeconds >= 1 &&
      config.ttlSeconds <= maxTtlSeconds,
    "INVALID_REQUEST",
    "Resource 游标 TTL 配置无效",
  );
  resourceInvariant(
    Number.isSafeInteger(maxTtlSeconds) && maxTtlSeconds >= 1 && maxTtlSeconds <= 604_800,
    "INVALID_REQUEST",
    "Resource 游标最大 TTL 配置无效",
  );
  const keys = new Map<string, Uint8Array>();
  for (const key of config.keys) {
    resourceInvariant(KID_PATTERN.test(key.kid), "INVALID_REQUEST", "Resource 游标 kid 格式无效");
    resourceInvariant(
      key.secret.byteLength >= 32 && key.secret.byteLength <= 64,
      "INVALID_REQUEST",
      "Resource 游标签名密钥长度无效",
    );
    resourceInvariant(!keys.has(key.kid), "INVALID_REQUEST", "Resource 游标 kid 重复");
    keys.set(key.kid, new Uint8Array(key.secret));
  }
  const activeSecret = keys.get(config.activeKid);
  resourceInvariant(
    activeSecret !== undefined,
    "INVALID_REQUEST",
    "Resource 游标 activeKid 不存在",
  );
  const unknownKidSecret = randomBytes(32);
  const now = config.now ?? (() => new Date());

  return Object.freeze({
    encode(input: Parameters<ResourceCursorCodec["encode"]>[0]) {
      const issuedAt = now();
      assertValidClock(issuedAt);
      const expiresAt = new Date(issuedAt.getTime() + config.ttlSeconds * 1_000);
      const payload: CursorPayload = {
        v: 1,
        kid: config.activeKid,
        tenantId: input.scope.tenantId,
        userId: input.scope.userId,
        queryHash: hashQuery(input.normalizedQuery),
        updatedAt: input.position.updatedAt,
        resourceId: input.position.resourceId,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      const signature = sign(encodedPayload, activeSecret).toString("base64url");
      const cursor = `${encodedPayload}.${signature}`;
      resourceInvariant(cursor.length <= MAX_CURSOR_LENGTH, "INVALID_REQUEST", "Resource 游标过长");
      return cursor;
    },
    decode(input: Parameters<ResourceCursorCodec["decode"]>[0]) {
      try {
        resourceInvariant(
          input.cursor.length > 0 && input.cursor.length <= MAX_CURSOR_LENGTH,
          "INVALID_REQUEST",
          "Resource 游标格式无效",
        );
        const parts = input.cursor.split(".");
        resourceInvariant(parts.length === 2, "INVALID_REQUEST", "Resource 游标格式无效");
        const encodedPayload = parts[0] ?? "";
        const encodedSignature = parts[1] ?? "";
        assertCanonicalBase64Url(encodedPayload);
        assertCanonicalBase64Url(encodedSignature);
        const payload = parsePayload(Buffer.from(encodedPayload, "base64url").toString("utf8"));
        const secret = keys.get(payload.kid) ?? unknownKidSecret;
        const actual = Buffer.from(encodedSignature, "base64url");
        const expected = sign(encodedPayload, secret);
        const signatureMatches =
          actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
        resourceInvariant(
          signatureMatches && keys.has(payload.kid),
          "INVALID_REQUEST",
          "Resource 游标无效",
        );
        resourceInvariant(
          payload.tenantId === input.scope.tenantId &&
            payload.userId === input.scope.userId &&
            payload.queryHash === hashQuery(input.normalizedQuery),
          "INVALID_REQUEST",
          "Resource 游标无效",
        );
        const issuedAt = parseExactIso(payload.issuedAt);
        const expiresAt = parseExactIso(payload.expiresAt);
        const current = now();
        assertValidClock(current);
        resourceInvariant(
          issuedAt.getTime() <= current.getTime() &&
            expiresAt.getTime() > current.getTime() &&
            expiresAt.getTime() > issuedAt.getTime() &&
            expiresAt.getTime() - issuedAt.getTime() <= maxTtlSeconds * 1_000,
          "INVALID_REQUEST",
          "Resource 游标已失效",
        );
        return Object.freeze({
          updatedAt: isoTimestamp(payload.updatedAt),
          resourceId: resourceId(payload.resourceId),
        });
      } catch (error) {
        if (error instanceof ResourceServiceError) throw error;
        throw new ResourceServiceError("INVALID_REQUEST", "Resource 游标无效");
      }
    },
  });
}

function parsePayload(json: string): CursorPayload {
  const parsed: unknown = JSON.parse(json);
  resourceInvariant(
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
    "INVALID_REQUEST",
    "Resource 游标无效",
  );
  const record = parsed as Record<string, unknown>;
  const expectedKeys = [
    "v",
    "kid",
    "tenantId",
    "userId",
    "queryHash",
    "updatedAt",
    "resourceId",
    "issuedAt",
    "expiresAt",
  ];
  resourceInvariant(
    Object.keys(record).length === expectedKeys.length &&
      expectedKeys.every((key) => Object.hasOwn(record, key)),
    "INVALID_REQUEST",
    "Resource 游标无效",
  );
  resourceInvariant(record.v === 1, "INVALID_REQUEST", "Resource 游标版本无效");
  for (const field of expectedKeys.slice(1)) {
    resourceInvariant(typeof record[field] === "string", "INVALID_REQUEST", "Resource 游标无效");
  }
  const payload = record as unknown as CursorPayload;
  resourceInvariant(KID_PATTERN.test(payload.kid), "INVALID_REQUEST", "Resource 游标无效");
  resourceInvariant(
    /^[a-f0-9]{64}$/u.test(payload.queryHash),
    "INVALID_REQUEST",
    "Resource 游标无效",
  );
  tenantId(payload.tenantId);
  userId(payload.userId);
  resourceId(payload.resourceId);
  isoTimestamp(payload.updatedAt);
  return payload;
}

function assertCanonicalBase64Url(value: string): void {
  resourceInvariant(BASE64URL_PATTERN.test(value), "INVALID_REQUEST", "Resource 游标格式无效");
  const decoded = Buffer.from(value, "base64url");
  resourceInvariant(
    decoded.toString("base64url") === value,
    "INVALID_REQUEST",
    "Resource 游标格式无效",
  );
}

function sign(payload: string, secret: Uint8Array): Buffer {
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

function hashQuery(query: string): string {
  return createHash("sha256").update(query, "utf8").digest("hex");
}

function parseExactIso(value: string): Date {
  const branded: IsoTimestamp = isoTimestamp(value);
  const date = new Date(branded);
  resourceInvariant(date.toISOString() === value, "INVALID_REQUEST", "Resource 游标时间无效");
  return date;
}

function assertValidClock(value: Date): void {
  resourceInvariant(!Number.isNaN(value.getTime()), "INVALID_REQUEST", "Resource 游标时钟无效");
}

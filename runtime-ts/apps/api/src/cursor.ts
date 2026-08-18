import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  isoTimestamp,
  threadId,
  type IsoTimestamp,
  type TenantId,
  type UserId,
} from "@hoox/domain";
import type { ThreadListCursor } from "@hoox/persistence";
import type { ThreadCursorCodec } from "./ports.js";

const kidPattern = /^[A-Za-z0-9_-]{3,32}$/u;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const maximumIdLength = 128;
const maximumKidLength = 32;
const maximumIsoTimestampLength = 24;
const maximumSignatureLength = 43;
const maximumCursorPayloadBytes = Buffer.byteLength(
  JSON.stringify({
    v: 1,
    kid: "k".repeat(maximumKidLength),
    tenantId: "t".repeat(maximumIdLength),
    userId: "u".repeat(maximumIdLength),
    issuedAt: "0".repeat(maximumIsoTimestampLength),
    expiresAt: "0".repeat(maximumIsoTimestampLength),
    updatedAt: "0".repeat(maximumIsoTimestampLength),
    id: "i".repeat(maximumIdLength),
  }),
  "utf8",
);
const maximumEncodedPayloadLength = Math.ceil(maximumCursorPayloadBytes / 3) * 4;
const maximumCursorLength = maximumEncodedPayloadLength + 1 + maximumSignatureLength;
const absoluteMaximumTtlMilliseconds = 30 * 24 * 60 * 60 * 1_000;

export interface ThreadCursorSigningKey {
  readonly kid: string;
  /** 不少于 32 字节的规范 base64url 密钥。 */
  readonly secret: string;
}

export interface ThreadCursorKeyRing {
  readonly activeKid: string;
  readonly keys: readonly ThreadCursorSigningKey[];
  readonly clock: { now(): IsoTimestamp };
  readonly ttlMilliseconds: number;
  readonly maximumTtlMilliseconds: number;
}

/**
 * 环境密钥环使用 `kid:base64url,kid:base64url`。这里只拆分结构；密钥长度、重复 kid 与
 * 规范编码仍由 createThreadCursorCodec 统一验证，避免 development/production 解析语义漂移。
 */
export function parseThreadCursorSigningKeys(value: string): readonly ThreadCursorSigningKey[] {
  const entries = value.split(",");
  if (entries.length === 0) throw new TypeError("分页游标签名密钥环无效");
  return Object.freeze(
    entries.map((entry) => {
      const separator = entry.indexOf(":");
      if (
        separator < 1 ||
        separator === entry.length - 1 ||
        entry.indexOf(":", separator + 1) >= 0
      ) {
        throw new TypeError("分页游标签名密钥环无效");
      }
      return Object.freeze({ kid: entry.slice(0, separator), secret: entry.slice(separator + 1) });
    }),
  );
}

interface CursorPayload {
  readonly v: 1;
  readonly kid: string;
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly updatedAt: ThreadListCursor["updatedAt"];
  readonly id: ThreadListCursor["id"];
}

/** 对外只暴露同一种失败，避免把密钥轮换状态变成探测接口。 */
export class InvalidThreadCursorError extends Error {
  constructor() {
    super("任务分页游标无效");
    this.name = "InvalidThreadCursorError";
  }
}

function decodeSecret(secret: string): Buffer {
  if (!base64UrlPattern.test(secret)) throw new TypeError("分页游标签名密钥必须是规范 base64url");
  const decoded = Buffer.from(secret, "base64url");
  if (decoded.length < 32 || decoded.length > 64 || decoded.toString("base64url") !== secret) {
    throw new TypeError("分页游标签名密钥必须为 32 到 64 字节");
  }
  return decoded;
}

function sign(encodedPayload: string, secret: Buffer): Buffer {
  return createHmac("sha256", secret).update(encodedPayload, "utf8").digest();
}

function invalidCursor(): never {
  throw new InvalidThreadCursorError();
}

function parsePayload(raw: unknown): CursorPayload {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) invalidCursor();
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !==
      "expiresAt,id,issuedAt,kid,tenantId,updatedAt,userId,v" ||
    value.v !== 1 ||
    typeof value.kid !== "string" ||
    typeof value.tenantId !== "string" ||
    typeof value.userId !== "string" ||
    typeof value.issuedAt !== "string" ||
    typeof value.expiresAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.id !== "string"
  ) {
    invalidCursor();
  }
  try {
    return {
      v: 1,
      kid: value.kid,
      tenantId: value.tenantId as TenantId,
      userId: value.userId as UserId,
      issuedAt: isoTimestamp(value.issuedAt),
      expiresAt: isoTimestamp(value.expiresAt),
      updatedAt: isoTimestamp(value.updatedAt),
      id: threadId(value.id),
    };
  } catch {
    return invalidCursor();
  }
}

export function createThreadCursorCodec(config: ThreadCursorKeyRing): ThreadCursorCodec {
  if (!kidPattern.test(config.activeKid) || config.keys.length === 0) {
    throw new TypeError("分页游标签名密钥配置无效");
  }
  const keys = new Map<string, Buffer>();
  for (const key of config.keys) {
    if (!kidPattern.test(key.kid) || keys.has(key.kid)) {
      throw new TypeError("分页游标签名密钥标识无效或重复");
    }
    keys.set(key.kid, decodeSecret(key.secret));
  }
  const activeSecret = keys.get(config.activeKid);
  if (activeSecret === undefined) throw new TypeError("分页游标当前签名密钥不存在");
  if (
    !Number.isSafeInteger(config.ttlMilliseconds) ||
    !Number.isSafeInteger(config.maximumTtlMilliseconds) ||
    config.ttlMilliseconds < 1 ||
    config.maximumTtlMilliseconds < 1 ||
    config.maximumTtlMilliseconds > absoluteMaximumTtlMilliseconds ||
    config.ttlMilliseconds > config.maximumTtlMilliseconds
  ) {
    throw new TypeError("分页游标 TTL 配置无效");
  }
  // 未知 kid 仍完成一次同长度 HMAC，公开响应和主要验签路径不形成密钥枚举接口。
  const rejectionSecret = randomBytes(32);

  return {
    encode(scope, cursor) {
      const issuedAt = config.clock.now();
      const expiresAt = isoTimestamp(
        new Date(Date.parse(issuedAt) + config.ttlMilliseconds).toISOString(),
      );
      const payload: CursorPayload = {
        v: 1,
        kid: config.activeKid,
        tenantId: scope.tenantId,
        userId: scope.userId,
        issuedAt,
        expiresAt,
        updatedAt: cursor.updatedAt,
        id: cursor.id,
      };
      const payloadBuffer = Buffer.from(JSON.stringify(payload), "utf8");
      if (payloadBuffer.length > maximumCursorPayloadBytes) invalidCursor();
      const encodedPayload = payloadBuffer.toString("base64url");
      const signature = sign(encodedPayload, activeSecret);
      return `${encodedPayload}.${signature.toString("base64url")}`;
    },
    decode(scope, token) {
      if (token.length === 0 || token.length > maximumCursorLength) invalidCursor();
      const parts = token.split(".");
      if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) invalidCursor();
      const [encodedPayload, encodedSignature] = parts;
      if (!base64UrlPattern.test(encodedPayload) || !base64UrlPattern.test(encodedSignature)) {
        invalidCursor();
      }
      let payload: CursorPayload;
      let actualSignature: Buffer;
      try {
        const payloadBuffer = Buffer.from(encodedPayload, "base64url");
        if (payloadBuffer.toString("base64url") !== encodedPayload) invalidCursor();
        if (payloadBuffer.length > maximumCursorPayloadBytes) invalidCursor();
        payload = parsePayload(JSON.parse(payloadBuffer.toString("utf8")));
        actualSignature = Buffer.from(encodedSignature, "base64url");
        if (actualSignature.toString("base64url") !== encodedSignature) invalidCursor();
      } catch (error) {
        if (error instanceof InvalidThreadCursorError) throw error;
        return invalidCursor();
      }
      const secret = keys.get(payload.kid);
      const expectedSignature = sign(encodedPayload, secret ?? rejectionSecret);
      if (
        secret === undefined ||
        actualSignature.length !== expectedSignature.length ||
        !timingSafeEqual(actualSignature, expectedSignature)
      ) {
        invalidCursor();
      }
      if (payload.tenantId !== scope.tenantId || payload.userId !== scope.userId) invalidCursor();
      const nowMilliseconds = Date.parse(config.clock.now());
      const issuedMilliseconds = Date.parse(payload.issuedAt);
      const expiresMilliseconds = Date.parse(payload.expiresAt);
      if (
        issuedMilliseconds > nowMilliseconds ||
        expiresMilliseconds <= nowMilliseconds ||
        expiresMilliseconds <= issuedMilliseconds ||
        expiresMilliseconds - issuedMilliseconds > config.maximumTtlMilliseconds
      ) {
        invalidCursor();
      }
      return { updatedAt: payload.updatedAt, id: payload.id };
    },
  };
}

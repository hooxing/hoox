import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { userId, type UserId } from "@cube-runtime/domain";
import type { AuthContextResolver, AuthPrincipal } from "./ports.js";

const keyIdPattern = /^[A-Za-z0-9_-]{3,64}$/u;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const maximumAuthorizationLength = 8_200;
const maximumTokenLength = 8_192;
const maximumHeaderBytes = 1_024;
const maximumPayloadBytes = 4_096;
const maximumClockSkewSeconds = 300;
const maximumNumericDate = 8_640_000_000_000;

export interface ProductionJwtVerificationKey {
  readonly kid: string;
  /** 已解码的 HS256 密钥；调用方不得记录、序列化或复用其原始字节。 */
  readonly secret: Uint8Array;
}

export interface ProductionJwtAuthResolverConfiguration {
  readonly issuer: string;
  readonly audience: string;
  readonly keys: readonly ProductionJwtVerificationKey[];
  readonly clockSkewSeconds: number;
  readonly now?: () => Date;
}

interface ParsedJwt {
  readonly signingInput: string;
  readonly kid: string;
  readonly signature: Buffer;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * 生产密钥环只接受显式 kid 与规范 base64url 原始密钥。重复 kid 会让轮换语义不确定，
 * 因而在进程监听前失败关闭；错误消息绝不包含密钥原文。
 */
export function parseProductionJwtSigningKeys(
  value: string,
): readonly ProductionJwtVerificationKey[] {
  const entries = value.split(",");
  if (entries.length === 0 || entries.length > 16) {
    throw new TypeError("生产 JWT 密钥环无效");
  }
  const identifiers = new Set<string>();
  const keys: ProductionJwtVerificationKey[] = [];
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    if (separator < 1 || separator === entry.length - 1 || entry.indexOf(":", separator + 1) >= 0) {
      throw new TypeError("生产 JWT 密钥环无效");
    }
    const kid = entry.slice(0, separator);
    const encodedSecret = entry.slice(separator + 1);
    if (!keyIdPattern.test(kid) || identifiers.has(kid)) {
      throw new TypeError("生产 JWT 密钥环无效");
    }
    const secret = decodeCanonicalBase64Url(encodedSecret, 64);
    if (secret === undefined || secret.length < 32 || secret.length > 64) {
      throw new TypeError("生产 JWT 密钥环无效");
    }
    identifiers.add(kid);
    // Buffer 是可变对象，复制后只由 resolver 闭包持有，避免配置调用方再修改验签密钥。
    keys.push(Object.freeze({ kid, secret: Buffer.from(secret) }));
  }
  return Object.freeze(keys);
}

function validateResolverConfiguration(
  configuration: ProductionJwtAuthResolverConfiguration,
): Readonly<{
  readonly issuer: string;
  readonly audience: string;
  readonly clockSkewSeconds: number;
  readonly keys: ReadonlyMap<string, Buffer>;
}> {
  if (
    typeof configuration.issuer !== "string" ||
    typeof configuration.audience !== "string" ||
    configuration.issuer.length === 0 ||
    configuration.audience.length === 0 ||
    configuration.issuer.length > 512 ||
    configuration.audience.length > 512 ||
    configuration.issuer.trim() !== configuration.issuer ||
    configuration.audience.trim() !== configuration.audience ||
    !Number.isSafeInteger(configuration.clockSkewSeconds) ||
    configuration.clockSkewSeconds < 1 ||
    configuration.clockSkewSeconds > maximumClockSkewSeconds ||
    !Array.isArray(configuration.keys) ||
    configuration.keys.length === 0 ||
    configuration.keys.length > 16
  ) {
    throw new TypeError("生产 JWT 认证配置无效");
  }
  const keys = new Map<string, Buffer>();
  for (const key of configuration.keys) {
    if (
      typeof key !== "object" ||
      key === null ||
      !keyIdPattern.test(key.kid) ||
      keys.has(key.kid) ||
      !(key.secret instanceof Uint8Array)
    ) {
      throw new TypeError("生产 JWT 认证配置无效");
    }
    const secret = Buffer.from(key.secret);
    if (secret.length < 32 || secret.length > 64) {
      throw new TypeError("生产 JWT 认证配置无效");
    }
    keys.set(key.kid, secret);
  }
  return Object.freeze({
    issuer: configuration.issuer,
    audience: configuration.audience,
    clockSkewSeconds: configuration.clockSkewSeconds,
    keys,
  });
}

function decodeCanonicalBase64Url(value: string, maximumBytes: number): Buffer | undefined {
  if (value.length === 0 || !base64UrlPattern.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length === 0 ||
    decoded.length > maximumBytes ||
    decoded.toString("base64url") !== value
  ) {
    return undefined;
  }
  return decoded;
}

function consumeJsonString(value: string, start: number): number | undefined {
  if (value[start] !== '"') return undefined;
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === undefined || character.charCodeAt(0) < 0x20) return undefined;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') return index + 1;
  }
  return undefined;
}

function skipJsonWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const character = value[index];
    if (character !== " " && character !== "\t" && character !== "\n" && character !== "\r") {
      break;
    }
    index += 1;
  }
  return index;
}

/** 找到顶层对象中一个 value 的结束位置；完整 JSON 合法性仍由 JSON.parse 负责。 */
function consumeJsonValue(value: string, start: number): number | undefined {
  let nested = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (character === undefined) return undefined;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      nested += 1;
    } else if (character === "}" || character === "]") {
      if (nested === 0) return character === "}" ? index : undefined;
      nested -= 1;
    } else if (character === "," && nested === 0) {
      return index;
    }
  }
  return undefined;
}

/** JSON.parse 会静默保留重复键的最后一个值；认证声明不能接受这种歧义。 */
function hasUniqueTopLevelJsonKeys(value: string): boolean {
  let index = skipJsonWhitespace(value, 0);
  if (value[index] !== "{") return false;
  index = skipJsonWhitespace(value, index + 1);
  if (value[index] === "}") return skipJsonWhitespace(value, index + 1) === value.length;
  const keys = new Set<string>();
  while (index < value.length) {
    const keyStart = index;
    const keyEnd = consumeJsonString(value, keyStart);
    if (keyEnd === undefined) return false;
    let key: unknown;
    try {
      key = JSON.parse(value.slice(keyStart, keyEnd));
    } catch {
      return false;
    }
    if (typeof key !== "string" || keys.has(key)) return false;
    keys.add(key);
    index = skipJsonWhitespace(value, keyEnd);
    if (value[index] !== ":") return false;
    index = skipJsonWhitespace(value, index + 1);
    const valueEnd = consumeJsonValue(value, index);
    if (valueEnd === undefined || valueEnd === index) return false;
    index = skipJsonWhitespace(value, valueEnd);
    if (value[index] === "}") return skipJsonWhitespace(value, index + 1) === value.length;
    if (value[index] !== ",") return false;
    index = skipJsonWhitespace(value, index + 1);
  }
  return false;
}

function decodeJsonObject(
  encoded: string,
  maximumBytes: number,
): Readonly<Record<string, unknown>> | undefined {
  const bytes = decodeCanonicalBase64Url(encoded, maximumBytes);
  if (bytes === undefined) return undefined;
  const value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes) || !hasUniqueTopLevelJsonKeys(value)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype
    ) {
      return undefined;
    }
    return Object.freeze(parsed as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

function ownValue(value: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function parseHeader(value: Readonly<Record<string, unknown>>): string | undefined {
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "alg" && key !== "kid" && key !== "typ")) return undefined;
  if (ownValue(value, "alg") !== "HS256") return undefined;
  const kid = ownValue(value, "kid");
  if (typeof kid !== "string" || !keyIdPattern.test(kid)) return undefined;
  const typ = ownValue(value, "typ");
  if (typ !== undefined && typ !== "JWT") return undefined;
  return kid;
}

function numericDate(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximumNumericDate
    ? value
    : undefined;
}

function parsePayload(
  value: Readonly<Record<string, unknown>>,
  configuration: Readonly<{ readonly issuer: string; readonly audience: string }>,
): UserId | undefined {
  const issuer = ownValue(value, "iss");
  const audience = ownValue(value, "aud");
  const subject = ownValue(value, "sub");
  const issuedAt = numericDate(ownValue(value, "iat"));
  const notBefore = numericDate(ownValue(value, "nbf"));
  const expiresAt = numericDate(ownValue(value, "exp"));
  if (
    issuer !== configuration.issuer ||
    audience !== configuration.audience ||
    typeof subject !== "string" ||
    issuedAt === undefined ||
    notBefore === undefined ||
    expiresAt === undefined ||
    issuedAt > notBefore ||
    notBefore >= expiresAt
  ) {
    return undefined;
  }
  try {
    return userId(subject);
  } catch {
    return undefined;
  }
}

function parseCompactJwt(token: string): ParsedJwt | undefined {
  if (token.length === 0 || token.length > maximumTokenLength) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) {
    return undefined;
  }
  const header = decodeJsonObject(encodedHeader, maximumHeaderBytes);
  const payload = decodeJsonObject(encodedPayload, maximumPayloadBytes);
  const signature = decodeCanonicalBase64Url(encodedSignature, 64);
  if (header === undefined || payload === undefined || signature === undefined) return undefined;
  const kid = parseHeader(header);
  if (kid === undefined) return undefined;
  return Object.freeze({
    signingInput: `${encodedHeader}.${encodedPayload}`,
    kid,
    signature,
    payload,
  });
}

function nowSeconds(now: () => Date): number | undefined {
  const instant = now();
  const milliseconds = instant.getTime();
  if (!Number.isFinite(milliseconds)) return undefined;
  const seconds = Math.floor(milliseconds / 1_000);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

function signatureFor(signingInput: string, secret: Buffer): Buffer {
  return createHmac("sha256", secret).update(signingInput, "utf8").digest();
}

/**
 * 创建生产 Bearer JWT 验证器。它仅从已经验签的 `sub` 构造 user principal；
 * `X-Tenant-Id` 只是随后交给 PostgreSQL Membership/RLS 复核的不可信选择器，绝不读取 token 租户声明。
 */
export function createProductionJwtAuthResolver(
  configuration: ProductionJwtAuthResolverConfiguration,
): AuthContextResolver {
  const normalized = validateResolverConfiguration(configuration);
  const currentTime = configuration.now ?? (() => new Date());
  // 未知 kid 同样计算一遍固定长度 HMAC，避免用验签主路径枚举正在轮换的密钥标识。
  const rejectionSecret = randomBytes(32);
  return Object.freeze({
    async resolve(
      input: Parameters<AuthContextResolver["resolve"]>[0],
    ): Promise<AuthPrincipal | undefined> {
      const authorization = input.authorization;
      if (
        authorization === undefined ||
        authorization.length > maximumAuthorizationLength ||
        !authorization.startsWith("Bearer ")
      ) {
        return undefined;
      }
      const token = authorization.slice("Bearer ".length);
      const parsed = parseCompactJwt(token);
      if (parsed === undefined) return undefined;

      const configuredSecret = normalized.keys.get(parsed.kid);
      const expected = signatureFor(parsed.signingInput, configuredSecret ?? rejectionSecret);
      const comparable =
        parsed.signature.length === expected.length
          ? parsed.signature
          : Buffer.alloc(expected.length);
      const signatureValid = timingSafeEqual(comparable, expected);
      if (
        configuredSecret === undefined ||
        parsed.signature.length !== expected.length ||
        !signatureValid
      ) {
        return undefined;
      }

      const subject = parsePayload(parsed.payload, normalized);
      const current = nowSeconds(currentTime);
      if (subject === undefined || current === undefined) return undefined;
      const issuedAt = numericDate(ownValue(parsed.payload, "iat"));
      const notBefore = numericDate(ownValue(parsed.payload, "nbf"));
      const expiresAt = numericDate(ownValue(parsed.payload, "exp"));
      if (
        issuedAt === undefined ||
        notBefore === undefined ||
        expiresAt === undefined ||
        issuedAt > current + normalized.clockSkewSeconds ||
        notBefore > current + normalized.clockSkewSeconds ||
        expiresAt + normalized.clockSkewSeconds <= current
      ) {
        return undefined;
      }
      // 不把任何 token 中的 tenant / role / scope 映射为 principal，授权只能落到数据库事实。
      return Object.freeze({ userId: subject });
    },
  });
}

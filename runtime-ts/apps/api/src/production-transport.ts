import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, posix, win32 } from "node:path";
import { createSecureContext } from "node:tls";

const maximumTrustedProxies = 16;
const maximumPemBytes = 1_024 * 1_024;

interface ParsedIpAddress {
  readonly family: 4 | 6;
  readonly value: bigint;
}

interface TrustedProxyRange extends ParsedIpAddress {
  readonly prefix: number;
}

export type ProductionApiTransport =
  | Readonly<{
      readonly mode: "direct";
      readonly certificatePath: string;
      readonly privateKeyPath: string;
    }>
  | Readonly<{
      readonly mode: "proxy";
      readonly trustedProxies: readonly TrustedProxyRange[];
    }>;

export interface ProductionTlsCredentials {
  readonly key: Buffer;
  readonly cert: Buffer;
  readonly minVersion: "TLSv1.2";
}

function parseIpv4(value: string): ParsedIpAddress | undefined {
  if (isIP(value) !== 4) return undefined;
  const octets = value.split(".");
  if (octets.length !== 4) return undefined;
  let result = 0n;
  for (const octet of octets) {
    if (!/^(0|[1-9][0-9]{0,2})$/u.test(octet)) return undefined;
    const number = Number(octet);
    if (!Number.isInteger(number) || number < 0 || number > 255) return undefined;
    result = (result << 8n) | BigInt(number);
  }
  return Object.freeze({ family: 4, value: result });
}

function parseIpv6(value: string): ParsedIpAddress | undefined {
  if (isIP(value) !== 6 || value.includes(".")) return undefined;
  const split = value.split("::");
  if (split.length > 2) return undefined;
  const left = split[0] === "" ? [] : split[0]?.split(":");
  const right = split.length === 1 || split[1] === "" ? [] : split[1]?.split(":");
  if (left === undefined || right === undefined || left.length + right.length > 8) return undefined;
  if (split.length === 1 && left.length !== 8) return undefined;
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/u.test(group)) return undefined;
    result = (result << 16n) | BigInt(`0x${group}`);
  }
  return Object.freeze({ family: 6, value: result });
}

function parseIpAddress(value: string): ParsedIpAddress | undefined {
  return parseIpv4(value) ?? parseIpv6(value);
}

function networkMask(bits: number, prefix: number): bigint {
  if (prefix === 0) return 0n;
  return ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
}

function parseTrustedProxyRange(value: string): TrustedProxyRange | undefined {
  const parts = value.split("/");
  if (parts.length > 2 || parts[0] === undefined || parts[0].length === 0) return undefined;
  const address = parseIpAddress(parts[0]);
  if (address === undefined) return undefined;
  const bits = address.family === 4 ? 32 : 128;
  const prefixRaw = parts[1];
  const prefix =
    prefixRaw === undefined
      ? bits
      : /^(0|[1-9][0-9]{0,2})$/u.test(prefixRaw)
        ? Number(prefixRaw)
        : Number.NaN;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return undefined;
  const mask = networkMask(bits, prefix);
  // 只接受规范网络地址，避免相同范围的多种写法让审核和部署清单产生歧义。
  if ((address.value & mask) !== address.value) return undefined;
  return Object.freeze({ ...address, prefix });
}

function parseTrustedProxyRanges(value: string): readonly TrustedProxyRange[] {
  const entries = value.split(",");
  if (entries.length === 0 || entries.length > maximumTrustedProxies) {
    throw new TypeError("生产反向代理信任边界无效");
  }
  const seen = new Set<string>();
  const ranges: TrustedProxyRange[] = [];
  for (const entry of entries) {
    const range = parseTrustedProxyRange(entry);
    if (range === undefined) throw new TypeError("生产反向代理信任边界无效");
    const identity = `${range.family}:${range.value}:${range.prefix}`;
    if (seen.has(identity)) throw new TypeError("生产反向代理信任边界无效");
    seen.add(identity);
    ranges.push(range);
  }
  return Object.freeze(ranges);
}

function isAbsoluteCredentialPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\u0000") &&
    (isAbsolute(value) || posix.isAbsolute(value) || win32.isAbsolute(value))
  );
}

/** 生产明文 HTTP 只允许在固定 loopback listener 后由明确 CIDR 的反向代理转入。 */
export function parseProductionApiTransport(input: {
  readonly listenHost: string;
  readonly tlsMode: string;
  readonly certificatePath?: string;
  readonly privateKeyPath?: string;
  readonly trustedProxyCidrs?: string;
}): ProductionApiTransport {
  if (input.tlsMode === "direct") {
    if (
      input.certificatePath === undefined ||
      input.privateKeyPath === undefined ||
      input.trustedProxyCidrs !== undefined ||
      !isAbsoluteCredentialPath(input.certificatePath) ||
      !isAbsoluteCredentialPath(input.privateKeyPath) ||
      input.certificatePath === input.privateKeyPath
    ) {
      throw new TypeError("生产 API 直接 TLS 配置无效");
    }
    return Object.freeze({
      mode: "direct",
      certificatePath: input.certificatePath,
      privateKeyPath: input.privateKeyPath,
    });
  }
  if (input.tlsMode === "proxy") {
    if (
      input.certificatePath !== undefined ||
      input.privateKeyPath !== undefined ||
      input.trustedProxyCidrs === undefined ||
      (input.listenHost !== "127.0.0.1" && input.listenHost !== "::1")
    ) {
      throw new TypeError("生产 API 反向代理 TLS 配置无效");
    }
    return Object.freeze({
      mode: "proxy",
      trustedProxies: parseTrustedProxyRanges(input.trustedProxyCidrs),
    });
  }
  throw new TypeError("API_TLS_MODE 只能是 direct 或 proxy");
}

function belongsToRange(address: ParsedIpAddress, range: TrustedProxyRange): boolean {
  if (address.family !== range.family) return false;
  const bits = address.family === 4 ? 32 : 128;
  return (address.value & networkMask(bits, range.prefix)) === range.value;
}

/** Fastify 只信任显式 CIDR 的连接对端，永不接受布尔 trustProxy 或客户端自报转发链。 */
export function productionTrustProxy(
  transport: ProductionApiTransport,
): false | ((address: string, _hop: number) => boolean) {
  if (transport.mode === "direct") return false;
  return (address) => {
    const parsed = parseIpAddress(address);
    return (
      parsed !== undefined &&
      transport.trustedProxies.some((range) => belongsToRange(parsed, range))
    );
  };
}

async function readPem(path: string, privateKey: boolean): Promise<Buffer> {
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size < 1 ||
      metadata.size > maximumPemBytes ||
      (privateKey && (metadata.mode & 0o007) !== 0)
    ) {
      throw new Error("TLS_CREDENTIAL_FILE_INVALID");
    }
    return await readFile(path);
  } catch {
    // 路径、权限和 PEM 内容都可能是敏感部署细节，装配边界只保留稳定失败语义。
    throw new Error("PRODUCTION_TLS_CREDENTIALS_UNAVAILABLE");
  }
}

export async function loadProductionTlsCredentials(
  transport: ProductionApiTransport,
): Promise<ProductionTlsCredentials | undefined> {
  if (transport.mode === "proxy") return undefined;
  const [cert, key] = await Promise.all([
    readPem(transport.certificatePath, false),
    readPem(transport.privateKeyPath, true),
  ]);
  try {
    // 在 listen 前解析并匹配证书与私钥，错误不会降级为明文 HTTP listener。
    void createSecureContext({ cert, key, minVersion: "TLSv1.2" });
  } catch {
    throw new Error("PRODUCTION_TLS_CREDENTIALS_UNAVAILABLE");
  }
  return Object.freeze({ key, cert, minVersion: "TLSv1.2" });
}

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createProductionJwtAuthResolver,
  parseProductionJwtSigningKeys,
} from "./production-auth.js";

const encodedKey = Buffer.alloc(32, 17).toString("base64url");
const nowSeconds = 1_800_000_000;

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sign(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key = encodedKey,
): string {
  const signingInput = `${encoded(header)}.${encoded(payload)}`;
  const signature = createHmac("sha256", Buffer.from(key, "base64url"))
    .update(signingInput, "utf8")
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

function tamperSignature(token: string): string {
  const [header, body, signature] = token.split(".");
  if (header === undefined || body === undefined || signature === undefined || signature === "") {
    throw new TypeError("测试 JWT 形状无效");
  }
  // 修改首个有效 sextet，避免只改变 base64url 尾部未使用位而仍解码为同一签名字节。
  const replacement = signature.startsWith("A") ? "B" : "A";
  return `${header}.${body}.${replacement}${signature.slice(1)}`;
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://issuer.example.invalid/runtime",
    aud: "aisay-runtime-api",
    sub: "user_production_001",
    iat: nowSeconds - 30,
    nbf: nowSeconds - 30,
    exp: nowSeconds + 300,
    ...overrides,
  };
}

function resolver(
  input: { readonly skew?: number; readonly now?: number; readonly keys?: string } = {},
) {
  return createProductionJwtAuthResolver({
    issuer: "https://issuer.example.invalid/runtime",
    audience: "aisay-runtime-api",
    keys: parseProductionJwtSigningKeys(input.keys ?? `current-key:${encodedKey}`),
    clockSkewSeconds: input.skew ?? 60,
    maxTokenLifetimeSeconds: 3_600,
    now: () => new Date((input.now ?? nowSeconds) * 1_000),
  });
}

async function resolve(token: string, input: Parameters<typeof resolver>[0] = {}) {
  return resolver(input).resolve({ authorization: `Bearer ${token}`, requestId: "request-test" });
}

describe("生产 HS256 Bearer JWT 认证", () => {
  it("只从验签 sub 构造 user principal，忽略 token 的租户等附加声明", async () => {
    const token = sign(
      { alg: "HS256", typ: "JWT", kid: "current-key" },
      payload({ tenantId: "tenant_not_authoritative", roles: ["owner"] }),
    );
    await expect(resolve(token)).resolves.toEqual({ userId: "user_production_001" });
  });

  it("拒绝错误算法、kid、签名、规范 base64url 和 Bearer 格式", async () => {
    const validHeader = { alg: "HS256", kid: "current-key" };
    const validPayload = payload();
    const token = sign(validHeader, validPayload);
    const malformedPadding = `${token.split(".")[0]}.${token.split(".")[1]}=.signature`;
    const cases = [
      sign({ alg: "none", kid: "current-key" }, validPayload),
      sign({ alg: "HS384", kid: "current-key" }, validPayload),
      sign({ alg: "HS256", kid: "unknown-key" }, validPayload),
      tamperSignature(token),
      malformedPadding,
    ];
    for (const candidate of cases) {
      await expect(resolve(candidate)).resolves.toBeUndefined();
    }
    await expect(
      resolver().resolve({ authorization: `bearer ${token}`, requestId: "request-test" }),
    ).resolves.toBeUndefined();
    await expect(
      resolver().resolve({ authorization: `Bearer  ${token}`, requestId: "request-test" }),
    ).resolves.toBeUndefined();
  });

  it("严格验证 iss、aud、sub、iat、nbf 与 exp 的类型和顺序", async () => {
    const header = { alg: "HS256", kid: "current-key" };
    const cases = [
      payload({ iss: "https://other.example.invalid" }),
      payload({ aud: ["aisay-runtime-api"] }),
      payload({ sub: "not a valid user id" }),
      payload({ iat: nowSeconds - 30.5 }),
      payload({ nbf: nowSeconds - 31, iat: nowSeconds - 30 }),
      payload({ exp: nowSeconds - 30, nbf: nowSeconds - 30 }),
      (() => {
        const invalid = payload();
        delete invalid.exp;
        return invalid;
      })(),
    ];
    for (const invalid of cases) {
      await expect(resolve(sign(header, invalid))).resolves.toBeUndefined();
    }
  });

  it("有界 clock skew 在 exp 边界 fail closed，并拒绝超前 iat/nbf", async () => {
    const header = { alg: "HS256", kid: "current-key" };
    const expBoundary = nowSeconds - 60;
    const nearExpiry = payload({
      iat: nowSeconds - 90,
      nbf: nowSeconds - 90,
      exp: expBoundary,
    });
    await expect(resolve(sign(header, nearExpiry), { skew: 60 })).resolves.toBeUndefined();
    await expect(
      resolve(sign(header, nearExpiry), { skew: 60, now: nowSeconds - 1 }),
    ).resolves.toEqual({ userId: "user_production_001" });
    await expect(
      resolve(
        sign(
          header,
          payload({ iat: nowSeconds + 61, nbf: nowSeconds + 61, exp: nowSeconds + 600 }),
        ),
        {
          skew: 60,
        },
      ),
    ).resolves.toBeUndefined();
    await expect(
      resolve(
        sign(header, payload({ iat: nowSeconds, nbf: nowSeconds + 61, exp: nowSeconds + 600 })),
        {
          skew: 60,
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("拒绝超过配置上限的 token lifetime，限制旧 kid 必须保留的轮换窗口", async () => {
    await expect(
      resolve(
        sign(
          { alg: "HS256", kid: "current-key" },
          payload({ iat: nowSeconds - 30, nbf: nowSeconds - 30, exp: nowSeconds + 3_571 }),
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("密钥环拒绝重复 kid、非规范编码与短密钥，且错误不泄漏原文", () => {
    const secret = "credential-canary-never-print";
    expect(() =>
      parseProductionJwtSigningKeys(`current-key:${encodedKey},current-key:${encodedKey}`),
    ).toThrow("生产 JWT 密钥环无效");
    expect(() =>
      parseProductionJwtSigningKeys("current-key:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
    ).toThrow("生产 JWT 密钥环无效");
    expect(() =>
      parseProductionJwtSigningKeys(`current-key:${Buffer.alloc(31).toString("base64url")}`),
    ).toThrow("生产 JWT 密钥环无效");
    try {
      parseProductionJwtSigningKeys(`current-key:${secret}`);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("拒绝重复 JSON 声明和超长 token", async () => {
    const header = encoded({ alg: "HS256", kid: "current-key" });
    const duplicatePayload = Buffer.from(
      `{"iss":"https://issuer.example.invalid/runtime","aud":"aisay-runtime-api","sub":"user_production_001","iat":${nowSeconds - 30},"nbf":${nowSeconds - 30},"exp":${nowSeconds + 300},"sub":"user_other_002"}`,
      "utf8",
    ).toString("base64url");
    const signingInput = `${header}.${duplicatePayload}`;
    const signature = createHmac("sha256", Buffer.from(encodedKey, "base64url"))
      .update(signingInput, "utf8")
      .digest("base64url");
    await expect(resolve(`${signingInput}.${signature}`)).resolves.toBeUndefined();
    await expect(resolve(`${"a".repeat(8_193)}.b.c`)).resolves.toBeUndefined();
  });
});

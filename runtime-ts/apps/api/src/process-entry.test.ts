import { describe, expect, it, vi } from "vitest";
import { parseThreadCursorSigningKeys } from "./development-assembly.js";
import { parseApiProcessEnvironment, startApiProcess } from "./process-entry.js";

function productionEnvironment(): Record<string, string> {
  return {
    RUNTIME_ENV: "production",
    DATABASE_URL: "postgresql://runtime:credential@database/runtime",
    DATABASE_SCHEMA: "runtime",
    DATABASE_RUNTIME_ROLE: "runtime",
    THREAD_CURSOR_ACTIVE_KID: "current",
    THREAD_CURSOR_SIGNING_KEYS: "current:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    API_JWT_ISSUER: "https://issuer.example.invalid/runtime",
    API_JWT_AUDIENCE: "cube-runtime-api",
    API_JWT_SIGNING_KEYS: "current-key:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    API_JWT_CLOCK_SKEW_SECONDS: "60",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
    API_LISTEN_HOST: "127.0.0.1",
    API_LISTEN_PORT: "3001",
    API_TLS_MODE: "proxy",
    API_TRUSTED_PROXY_CIDRS: "127.0.0.1",
    S3_ENDPOINT: "https://object-storage.example.invalid:9000",
    S3_PUBLIC_ENDPOINT: "https://objects.example.invalid",
    S3_BUCKET: "runtime-artifacts",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: "local-access-key",
    S3_SECRET_ACCESS_KEY: "opaque-test-value",
    S3_FORCE_PATH_STYLE: "true",
  };
}

function developmentEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...productionEnvironment(),
    RUNTIME_ENV: "development",
    DEV_AUTH_ENABLED: "true",
    DEV_AUTH_USER_A_ID: "user-a-local",
    DEV_AUTH_USER_A_TENANT_ID: "tenant-a-local",
    DEV_AUTH_USER_B_ID: "user-b-local",
    DEV_AUTH_USER_B_TENANT_ID: "tenant-b-local",
    S3_ENDPOINT: "http://object-storage:9000",
    S3_PUBLIC_ENDPOINT: "http://127.0.0.1:19000",
    ...overrides,
  };
}

describe("API 进程入口", () => {
  it("生产配置固定使用模块私有真实装配器，拒绝调用方注入 Fake", async () => {
    const assembler = Object.freeze({ assemble: vi.fn() });
    await expect(
      startApiProcess({ environment: productionEnvironment(), assembler }),
    ).rejects.toThrow("PRODUCTION_ASSEMBLY_UNAVAILABLE:api");
    expect(assembler.assemble).not.toHaveBeenCalled();
  });

  it("开发身份只有显式开启且字段完整时才启用", () => {
    const incomplete = {
      ...productionEnvironment(),
      RUNTIME_ENV: "development",
      DEV_AUTH_ENABLED: "true",
      API_LISTEN_HOST: "127.0.0.1",
      API_LISTEN_PORT: "3001",
      S3_ENDPOINT: "http://object-storage:9000",
      S3_PUBLIC_ENDPOINT: "http://127.0.0.1:19000",
    };
    expect(() => parseApiProcessEnvironment(incomplete)).toThrow("MISSING:DEV_AUTH_USER_A_ID");

    const parsed = parseApiProcessEnvironment({
      ...incomplete,
      DEV_AUTH_USER_A_ID: "user-a-local",
      DEV_AUTH_USER_A_TENANT_ID: "tenant-a-local",
      DEV_AUTH_USER_B_ID: "user-b-local",
      DEV_AUTH_USER_B_TENANT_ID: "tenant-b-local",
    });
    expect(parsed.developmentPrincipals?.[0].userId).toBe("user-a-local");
    expect(parsed.listenPort).toBe(3001);
    expect(parsed.objectStorage.bucket).toBe("runtime-artifacts");
  });

  it("开发监听地址显式配置，生产配置不会意外启用固定开发身份", () => {
    expect(() =>
      parseApiProcessEnvironment({
        ...productionEnvironment(),
        RUNTIME_ENV: "development",
        API_LISTEN_HOST: "127.0.0.1",
        API_LISTEN_PORT: "0",
      }),
    ).toThrow("INVALID:API_LISTEN_PORT");
  });

  it.each(["127.0.0.1", "::1", "localhost", "LOCALHOST"])(
    "固定开发身份接受字面回环监听地址 %s",
    (listenHost) => {
      expect(
        parseApiProcessEnvironment(developmentEnvironment({ API_LISTEN_HOST: listenHost }))
          .listenHost,
      ).toBe(listenHost === "::1" ? "::1" : "127.0.0.1");
    },
  );

  it.each(["0.0.0.0", "::", "192.168.53.128", "127.0.0.2", "localhost.example", "devbox"])(
    "固定开发身份拒绝非白名单监听地址 %s",
    async (listenHost) => {
      const assembler = Object.freeze({ assemble: vi.fn() });
      await expect(
        startApiProcess({
          environment: developmentEnvironment({ API_LISTEN_HOST: listenHost }),
          assembler,
        }),
      ).rejects.toThrow("DEVELOPMENT_API_REQUIRES_LOOPBACK_LISTENER");
      expect(assembler.assemble).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["http://127.0.0.1:3001", "DEVELOPMENT_S3_PUBLIC_ENDPOINT_MUST_BE_ISOLATED"],
    ["http://127.0.0.1:4173", "DEVELOPMENT_S3_PUBLIC_ENDPOINT_MUST_BE_ISOLATED"],
    ["http://192.168.53.128:19000", "DEVELOPMENT_S3_PUBLIC_ENDPOINT_REQUIRES_LOOPBACK_ORIGIN"],
    ["http://localhost:19000", "DEVELOPMENT_S3_PUBLIC_ENDPOINT_REQUIRES_LOOPBACK_ORIGIN"],
    ["http://127.1:19000", "DEVELOPMENT_S3_PUBLIC_ENDPOINT_REQUIRES_LOOPBACK_ORIGIN"],
    ["http://2130706433:19000", "DEVELOPMENT_S3_PUBLIC_ENDPOINT_REQUIRES_LOOPBACK_ORIGIN"],
    ["http://127.0.0.1:19000/minio", "DEVELOPMENT_S3_PUBLIC_ENDPOINT_REQUIRES_LOOPBACK_ORIGIN"],
  ])("固定开发身份拒绝不安全的对象存储公开 origin %s", (publicEndpoint, errorCode) => {
    expect(() =>
      parseApiProcessEnvironment(developmentEnvironment({ S3_PUBLIC_ENDPOINT: publicEndpoint })),
    ).toThrow(errorCode);
  });

  it("对象存储隔离按实际 API 和明确 Web origin 判断，不把端口当成隐式身份", () => {
    expect(
      parseApiProcessEnvironment(
        developmentEnvironment({
          API_LISTEN_PORT: "3301",
          S3_PUBLIC_ENDPOINT: "http://127.0.0.1:3001",
        }),
      ).objectStorage.publicEndpoint,
    ).toBe("http://127.0.0.1:3001");
    expect(
      parseApiProcessEnvironment(
        developmentEnvironment({ S3_PUBLIC_ENDPOINT: "http://[::1]:4173" }),
      ).objectStorage.publicEndpoint,
    ).toBe("http://[::1]:4173");
    expect(() =>
      parseApiProcessEnvironment(
        developmentEnvironment({
          API_LISTEN_PORT: "80",
          S3_PUBLIC_ENDPOINT: "http://127.0.0.1",
        }),
      ),
    ).toThrow("DEVELOPMENT_S3_PUBLIC_ENDPOINT_MUST_BE_ISOLATED");
  });

  it.each([
    { DEV_AUTH_USER_B_ID: "user-a-local" },
    { DEV_AUTH_USER_B_TENANT_ID: "tenant-a-local" },
  ])("API 启动在装配前拒绝未隔离的 A/B 身份：%o", async (overrides) => {
    const assembler = Object.freeze({ assemble: vi.fn() });
    await expect(
      startApiProcess({ environment: developmentEnvironment(overrides), assembler }),
    ).rejects.toThrow("DEVELOPMENT_IDENTITIES_MUST_BE_ISOLATED");
    expect(assembler.assemble).not.toHaveBeenCalled();
  });

  it("密钥环只接受不泄漏原值的明确结构", () => {
    expect(
      parseThreadCursorSigningKeys(
        "current:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA,old:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      ),
    ).toEqual([
      { kid: "current", secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      { kid: "old", secret: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
    ]);
    const sensitive = "malformed-secret-value";
    expect(() => parseThreadCursorSigningKeys(sensitive)).toThrow("分页游标签名密钥环无效");
    try {
      parseThreadCursorSigningKeys(sensitive);
    } catch (error) {
      expect(String(error)).not.toContain(sensitive);
    }
  });

  it("未知变量失败且错误不泄漏值", () => {
    const source = { ...productionEnvironment(), WRONG_SECRET: "must-not-appear" };
    expect(() => parseApiProcessEnvironment(source)).toThrow("UNKNOWN:WRONG_SECRET");
    try {
      parseApiProcessEnvironment(source);
    } catch (error) {
      expect(String(error)).not.toContain("must-not-appear");
    }
  });

  it("production 明确拒绝任何 DEV_AUTH 变量，并在解析期校验 JWT/PG/对象存储边界", () => {
    expect(() =>
      parseApiProcessEnvironment({ ...productionEnvironment(), DEV_AUTH_ENABLED: "false" }),
    ).toThrow("FORBIDDEN_IN_PRODUCTION:DEV_AUTH_ENABLED");
    expect(() =>
      parseApiProcessEnvironment({
        ...productionEnvironment(),
        DEV_AUTH_USER_A_ID: "copied-development-user",
      }),
    ).toThrow("FORBIDDEN_IN_PRODUCTION:DEV_AUTH_USER_A_ID");
    expect(() =>
      parseApiProcessEnvironment({
        ...productionEnvironment(),
        DATABASE_RUNTIME_ROLE: "Runtime-Owner",
      }),
    ).toThrow("DATABASE_RUNTIME_ROLE 格式无效");
    expect(() =>
      parseApiProcessEnvironment({
        ...productionEnvironment(),
        S3_PUBLIC_ENDPOINT: "http://objects",
      }),
    ).toThrow("S3_PUBLIC_ENDPOINT 在 production 必须为无凭据的 HTTPS URL");
    expect(() =>
      parseApiProcessEnvironment({ ...productionEnvironment(), API_JWT_CLOCK_SKEW_SECONDS: "0" }),
    ).toThrow("INVALID:API_JWT_CLOCK_SKEW_SECONDS");
  });
});

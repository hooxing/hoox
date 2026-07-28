import { describe, expect, it, vi } from "vitest";
import { parseThreadCursorSigningKeys } from "./development-assembly.js";
import { parseApiProcessEnvironment, startApiProcess } from "./process-entry.js";

function productionEnvironment(): Record<string, string> {
  return {
    RUNTIME_ENV: "production",
    DATABASE_URL: "postgresql://runtime:credential@database/runtime",
    DATABASE_SCHEMA: "runtime",
    THREAD_CURSOR_ACTIVE_KID: "current",
    THREAD_CURSOR_SIGNING_KEYS: "current:opaque-test-value",
    DEV_AUTH_ENABLED: "false",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
    S3_ENDPOINT: "http://object-storage:9000",
    S3_PUBLIC_ENDPOINT: "http://127.0.0.1:19000",
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
    ...overrides,
  };
}

describe("API 进程入口", () => {
  it("生产配置没有真实装配器时拒绝启动", async () => {
    await expect(startApiProcess({ environment: productionEnvironment() })).rejects.toThrow(
      "ASSEMBLER_MISSING:api",
    );
  });

  it("开发身份只有显式开启且字段完整时才启用", () => {
    const incomplete = {
      ...productionEnvironment(),
      RUNTIME_ENV: "development",
      DEV_AUTH_ENABLED: "true",
      API_LISTEN_HOST: "127.0.0.1",
      API_LISTEN_PORT: "3001",
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

  it("开发监听地址显式配置，生产配置不会意外启用默认开发装配", async () => {
    expect(() =>
      parseApiProcessEnvironment({
        ...productionEnvironment(),
        RUNTIME_ENV: "development",
        API_LISTEN_HOST: "127.0.0.1",
        API_LISTEN_PORT: "0",
      }),
    ).toThrow("INVALID:API_LISTEN_PORT");
    await expect(startApiProcess({ environment: productionEnvironment() })).rejects.toThrow(
      "ASSEMBLER_MISSING:api",
    );
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
});

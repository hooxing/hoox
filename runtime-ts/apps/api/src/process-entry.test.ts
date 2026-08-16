import { describe, expect, it, vi } from "vitest";
import { parseThreadCursorSigningKeys } from "./development-assembly.js";
import { parseApiProcessEnvironment, startApiProcess } from "./process-entry.js";

function productionEnvironment(): Record<string, string> {
  return {
    RUNTIME_ENV: "production",
    DATABASE_URL: "postgresql://runtime:credential@database:5432/runtime?sslmode=verify-full",
    DATABASE_SCHEMA: "runtime",
    DATABASE_RUNTIME_ROLE: "runtime",
    DATABASE_TEAM_COORDINATOR_URL:
      "postgresql://team_coordinator:credential@database:5432/runtime?sslmode=verify-full",
    DATABASE_TEAM_COORDINATOR_ROLE: "team_coordinator",
    THREAD_CURSOR_ACTIVE_KID: "current",
    THREAD_CURSOR_SIGNING_KEYS: "current:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    THREAD_SERIAL_QUEUE_V2_ENABLED: "true",
    API_JWT_ISSUER: "https://issuer.example.invalid/runtime",
    API_JWT_AUDIENCE: "aisay-runtime-api",
    API_JWT_SIGNING_KEYS: "current-key:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    API_JWT_CLOCK_SKEW_SECONDS: "60",
    API_JWT_MAX_LIFETIME_SECONDS: "3600",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
    API_LISTEN_HOST: "127.0.0.1",
    API_LISTEN_PORT: "3001",
    API_PUBLIC_ORIGIN: "https://app.example.invalid",
    API_TLS_MODE: "proxy",
    API_TRUSTED_PROXY_CIDRS: "127.0.0.1",
    S3_ENDPOINT: "https://object-storage.example.invalid:9000",
    S3_PUBLIC_ENDPOINT: "https://objects.example.invalid",
    S3_BUCKET: "runtime-artifacts",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: "local-access-key",
    S3_SECRET_ACCESS_KEY: "opaque-test-value",
    S3_FORCE_PATH_STYLE: "true",
    RESOURCE_FILESYSTEM_SIGNING_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
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
  it("Thread 串行队列开关缺省开启且允许显式关闭", () => {
    const defaultEnvironment = developmentEnvironment();
    delete defaultEnvironment.THREAD_SERIAL_QUEUE_V2_ENABLED;
    expect(parseApiProcessEnvironment(defaultEnvironment).serialQueueV2Enabled).toBe(true);
    expect(
      parseApiProcessEnvironment(
        developmentEnvironment({
          THREAD_SERIAL_QUEUE_V2_ENABLED: "false",
          THREAD_CONTEXT_V2_WRITE_ENABLED: "false",
          THREAD_CONTEXT_V2_SHADOW_READ_ENABLED: "false",
          THREAD_CONTEXT_V2_READ_ENABLED: "false",
          THREAD_INPUT_ROUTING_V2_ENABLED: "false",
        }),
      ).serialQueueV2Enabled,
    ).toBe(false);
  });

  it("统一输入开关默认开启并强制依赖完整 Thread Context read 链", () => {
    expect(parseApiProcessEnvironment(developmentEnvironment()).threadInputRoutingV2Enabled).toBe(
      true,
    );
    expect(() =>
      parseApiProcessEnvironment(
        developmentEnvironment({
          THREAD_INPUT_ROUTING_V2_ENABLED: "true",
          THREAD_CONTEXT_V2_READ_ENABLED: "false",
        }),
      ),
    ).toThrow("依赖串行队列与 V2 Context read");
    expect(
      parseApiProcessEnvironment(
        developmentEnvironment({
          THREAD_SERIAL_QUEUE_V2_ENABLED: "true",
          THREAD_CONTEXT_V2_WRITE_ENABLED: "true",
          THREAD_CONTEXT_V2_SHADOW_READ_ENABLED: "true",
          THREAD_CONTEXT_V2_READ_ENABLED: "true",
          THREAD_INPUT_ROUTING_V2_ENABLED: "true",
        }),
      ).threadInputRoutingV2Enabled,
    ).toBe(true);
  });

  it("production 在解析最早边界拒绝继承的 Node TLS/代理覆盖", () => {
    expect(() =>
      parseApiProcessEnvironment({
        ...productionEnvironment(),
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      }),
    ).toThrow("PRODUCTION_INHERITED_ENVIRONMENT_FORBIDDEN");
  });

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
        RESOURCEFS_PROXY_ENABLED: "false",
      }),
    ).toThrow("FORBIDDEN_IN_PRODUCTION:RESOURCEFS_PROXY_ENABLED");
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
        DATABASE_TEAM_COORDINATOR_ROLE: "Team-Coordinator",
      }),
    ).toThrow("DATABASE_TEAM_COORDINATOR_ROLE 格式无效");
    expect(() =>
      parseApiProcessEnvironment({
        ...productionEnvironment(),
        DATABASE_TEAM_COORDINATOR_ROLE: "runtime",
      }),
    ).toThrow("DATABASE_TEAM_COORDINATOR_ROLE 必须与 DATABASE_RUNTIME_ROLE 不同");
    expect(() =>
      parseApiProcessEnvironment({
        ...productionEnvironment(),
        S3_PUBLIC_ENDPOINT: "http://objects",
      }),
    ).toThrow("S3_PUBLIC_ENDPOINT 在 production 必须为无凭据的 HTTPS URL");
    expect(() =>
      parseApiProcessEnvironment({
        ...productionEnvironment(),
        S3_PUBLIC_ENDPOINT: "https://app.example.invalid",
      }),
    ).toThrow("S3_PUBLIC_ENDPOINT 必须与 API_PUBLIC_ORIGIN 使用独立 origin");
    expect(() =>
      parseApiProcessEnvironment({ ...productionEnvironment(), API_JWT_CLOCK_SKEW_SECONDS: "0" }),
    ).toThrow("INVALID:API_JWT_CLOCK_SKEW_SECONDS");
    expect(() =>
      parseApiProcessEnvironment({
        ...productionEnvironment(),
        API_JWT_MAX_LIFETIME_SECONDS: "86401",
      }),
    ).toThrow("INVALID:API_JWT_MAX_LIFETIME_SECONDS");
    expect(() =>
      parseApiProcessEnvironment({
        ...productionEnvironment(),
        DATABASE_URL: "postgresql://runtime:credential@database/runtime?sslmode=require",
      }),
    ).toThrow("PRODUCTION_DATABASE_TRANSPORT_INVALID");
  });

  it("ResourceFS Sidecar 仅在 development 显式完整配置时启用", () => {
    expect(parseApiProcessEnvironment(developmentEnvironment())).not.toHaveProperty(
      "developmentResourceFilesystemProxy",
    );
    expect(() =>
      parseApiProcessEnvironment(developmentEnvironment({ RESOURCEFS_PROXY_ENABLED: "true" })),
    ).toThrow("ResourceFS Sidecar 配置不完整");
    expect(() =>
      parseApiProcessEnvironment(
        developmentEnvironment({
          RESOURCEFS_PROXY_ENABLED: "false",
          RESOURCEFS_PROXY_LISTEN_HOST: "192.0.2.10",
        }),
      ),
    ).toThrow("不得配置 Sidecar 字段");
    expect(
      parseApiProcessEnvironment(
        developmentEnvironment({
          RESOURCEFS_PROXY_ENABLED: "true",
          RESOURCEFS_PROXY_LISTEN_HOST: "192.0.2.10",
          RESOURCEFS_PROXY_LISTEN_PORT: "13443",
          RESOURCEFS_PROXY_TLS_KEY_PATH: "C:/development/resourcefs/server.key",
          RESOURCEFS_PROXY_TLS_CERT_PATH: "C:/development/resourcefs/server.crt",
        }),
      ).developmentResourceFilesystemProxy,
    ).toEqual({
      listenHost: "192.0.2.10",
      listenPort: 13443,
      upstream: "http://127.0.0.1:3001",
      privateKeyPath: "C:/development/resourcefs/server.key",
      certificatePath: "C:/development/resourcefs/server.crt",
    });
  });

  it("个人历史文件系统默认关闭并校验固化目录时区", () => {
    expect(parseApiProcessEnvironment(developmentEnvironment()).historyFilesystemEnabled).toBe(
      false,
    );
    expect(parseApiProcessEnvironment(developmentEnvironment()).historyTitleGenerationEnabled).toBe(
      false,
    );
    expect(parseApiProcessEnvironment(developmentEnvironment()).historyDirectoryTimeZone).toBe(
      "Asia/Shanghai",
    );
    expect(
      parseApiProcessEnvironment(
        developmentEnvironment({
          HISTORY_FILESYSTEM_ENABLED: "true",
          HISTORY_DIRECTORY_TIME_ZONE: "America/Los_Angeles",
          HISTORY_TITLE_GENERATION_ENABLED: "true",
        }),
      ),
    ).toMatchObject({
      historyFilesystemEnabled: true,
      historyDirectoryTimeZone: "America/Los_Angeles",
      historyTitleGenerationEnabled: true,
    });
    expect(() =>
      parseApiProcessEnvironment(
        developmentEnvironment({ HISTORY_TITLE_GENERATION_ENABLED: "true" }),
      ),
    ).toThrow("HISTORY_TITLE_GENERATION_ENABLED 依赖");
    expect(() =>
      parseApiProcessEnvironment(developmentEnvironment({ HISTORY_DIRECTORY_TIME_ZONE: "Mars" })),
    ).toThrow("HISTORY_DIRECTORY_TIME_ZONE 无效");
  });
});

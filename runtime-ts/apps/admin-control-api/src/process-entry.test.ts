import { describe, expect, it, vi } from "vitest";

const assemblyMocks = vi.hoisted(() => ({
  startDevelopment: vi.fn(),
  startProduction: vi.fn(),
}));

vi.mock("./production-assembly.js", () => ({
  startDevelopmentAdminControlApiProcess: assemblyMocks.startDevelopment,
  startProductionAdminControlApiProcess: assemblyMocks.startProduction,
}));

import {
  parseAdminControlApiProcessEnvironment,
  selectAdminControlApiProcessEnvironment,
  startAdminControlApiProcess,
} from "./process-entry.js";

function productionEnvironment(): Record<string, string> {
  return {
    RUNTIME_ENV: "production",
    BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-thirty-two-bytes",
    ADMIN_CONTROL_DATABASE_URL:
      "postgresql://admin_control:credential@database:5432/runtime?sslmode=verify-full",
    SKILL_PUBLISHER_DATABASE_URL:
      "postgresql://skill_publisher:credential@database:5432/runtime?sslmode=verify-full",
    DATABASE_ADMIN_CONTROL_ROLE: "admin_control",
    DATABASE_SKILL_PUBLISHER_ROLE: "skill_publisher",
    DATABASE_SCHEMA: "runtime",
    ADMIN_CONTROL_LISTEN_HOST: "127.0.0.1",
    ADMIN_CONTROL_LISTEN_PORT: "3003",
    ADMIN_CONTROL_JWT_ISSUER: "https://issuer.example.invalid/runtime",
    ADMIN_CONTROL_JWT_AUDIENCE: "hoox-admin-control-api",
    ADMIN_CONTROL_JWT_SIGNING_KEYS:
      "admin-control-current:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ADMIN_CONTROL_JWT_CLOCK_SKEW_SECONDS: "60",
    ADMIN_CONTROL_JWT_MAX_LIFETIME_SECONDS: "1800",
    ADMIN_CONTROL_TLS_MODE: "proxy",
    ADMIN_CONTROL_TLS_TRUSTED_PROXY_CIDRS: "127.0.0.1",
    SKILL_PUBLISHER_S3_ENDPOINT: "https://skill-objects.example.invalid",
    SKILL_PUBLISHER_S3_BUCKET: "runtime-skill-publications",
    SKILL_PUBLISHER_S3_REGION: "us-east-1",
    SKILL_PUBLISHER_S3_ACCESS_KEY_ID: "skill-publisher-access-key",
    SKILL_PUBLISHER_S3_SECRET_ACCESS_KEY: "opaque-skill-publisher-secret",
    SKILL_PUBLISHER_S3_FORCE_PATH_STYLE: "true",
    S3_ENDPOINT: "https://objects.example.invalid",
    S3_BUCKET: "runtime-trajectories",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: "trajectory-read-access-key",
    S3_SECRET_ACCESS_KEY: "opaque-trajectory-secret",
    S3_FORCE_PATH_STYLE: "false",
    MODEL_API_KEY: "production-model-secret",
    MODEL_CREDENTIAL_ENCRYPTION_KEY: "production-model-credential-root-at-least-32-bytes",
    MEM0_API_KEY: "production-memory-secret",
    MEM0_SCOPE_HMAC_KEY: "production-memory-scope-key-at-least-32-bytes",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
  };
}

function developmentEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    RUNTIME_ENV: "development",
    BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-thirty-two-bytes",
    ADMIN_CONTROL_DATABASE_URL: "postgresql://admin_control:credential@127.0.0.1:5432/runtime",
    SKILL_PUBLISHER_DATABASE_URL: "postgresql://skill_publisher:credential@127.0.0.1:5432/runtime",
    DATABASE_SCHEMA: "runtime",
    ADMIN_CONTROL_LISTEN_HOST: "127.0.0.1",
    ADMIN_CONTROL_LISTEN_PORT: "3003",
    SKILL_PUBLISHER_S3_ENDPOINT: "http://127.0.0.1:19000",
    SKILL_PUBLISHER_S3_BUCKET: "runtime-skill-publications",
    SKILL_PUBLISHER_S3_REGION: "us-east-1",
    SKILL_PUBLISHER_S3_ACCESS_KEY_ID: "local-skill-publisher",
    SKILL_PUBLISHER_S3_SECRET_ACCESS_KEY: "local-skill-publisher-secret",
    SKILL_PUBLISHER_S3_FORCE_PATH_STYLE: "true",
    S3_ENDPOINT: "http://127.0.0.1:19000",
    S3_BUCKET: "runtime-trajectories",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: "local-trajectory-reader",
    S3_SECRET_ACCESS_KEY: "local-trajectory-secret",
    S3_FORCE_PATH_STYLE: "true",
    DEV_ADMIN_CONTROL_USER_ID: "user_admin_local",
    DEV_ADMIN_CONTROL_TOKEN: "local-admin-control-token",
    MODEL_API_KEY: "development-model-secret",
    MEM0_API_KEY: "development-memory-secret",
    MEM0_SCOPE_HMAC_KEY: "development-memory-scope-key-at-least-32-bytes",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
    ...overrides,
  };
}

describe("后台控制 API 进程入口", () => {
  it("接入管理读取独立 Webhook 根密钥，并拒绝过短配置", () => {
    const root = "webhook-root-placeholder-at-least-32-bytes";
    expect(
      parseAdminControlApiProcessEnvironment(
        developmentEnvironment({ WEBHOOK_SECRET_ENCRYPTION_KEY: root }),
      ).providerSecrets.webhookSecretEncryptionKey === root,
    ).toBe(true);
    expect(
      parseAdminControlApiProcessEnvironment(developmentEnvironment()).providerSecrets
        .webhookSecretEncryptionKey,
    ).toBeUndefined();
    expect(() =>
      parseAdminControlApiProcessEnvironment(
        developmentEnvironment({ WEBHOOK_SECRET_ENCRYPTION_KEY: "short-placeholder" }),
      ),
    ).toThrow("WEBHOOK_SECRET_ENCRYPTION_KEY");
  });
  it("空安装可同时省略开发管理员令牌与模型密钥，保留稳定加密根", () => {
    const environment = developmentEnvironment({
      MODEL_CREDENTIAL_ENCRYPTION_KEY: "installation-root-at-least-thirty-two-bytes",
    });
    delete environment.DEV_ADMIN_CONTROL_USER_ID;
    delete environment.DEV_ADMIN_CONTROL_TOKEN;
    delete environment.MODEL_API_KEY;
    const configuration = parseAdminControlApiProcessEnvironment(environment);
    expect(configuration.developmentAuth).toBeUndefined();
    expect(configuration.providerSecrets.modelApiKey).toBe("");
    expect(configuration.identityApiUrl).toBe("http://127.0.0.1:3001");
    expect(() =>
      parseAdminControlApiProcessEnvironment({
        ...environment,
        DEV_ADMIN_CONTROL_TOKEN: "unpaired-test-token",
      }),
    ).toThrow("MISSING:DEV_ADMIN_CONTROL_USER_ID");
  });

  it("只投影统一后台声明配置，不接收 Runtime 或 Migrator 凭据", () => {
    const selected = selectAdminControlApiProcessEnvironment({
      ...productionEnvironment(),
      DATABASE_URL: "postgresql://runtime:secret@database/runtime",
      MIGRATION_DATABASE_URL: "postgresql://migrator:secret@database/runtime",
    });
    expect(selected.ADMIN_CONTROL_DATABASE_URL).toContain("admin_control");
    expect(selected.SKILL_PUBLISHER_DATABASE_URL).toContain("skill_publisher");
    expect(selected).not.toHaveProperty("DATABASE_URL");
    expect(selected).not.toHaveProperty("MIGRATION_DATABASE_URL");
  });

  it("production 固定独立 PG、JWT、TLS 且不含开发身份", () => {
    const configuration = parseAdminControlApiProcessEnvironment(productionEnvironment());
    expect(configuration).toMatchObject({
      runtimeEnvironment: "production",
      databaseAdminControlRole: "admin_control",
      databaseSkillPublisherRole: "skill_publisher",
      databaseSsl: { rejectUnauthorized: true },
      skillPublisherDatabaseSsl: { rejectUnauthorized: true },
      listenPort: 3003,
      production: {
        jwt: { audience: "hoox-admin-control-api" },
        transport: { mode: "proxy" },
      },
      providerSecrets: {
        modelApiKey: "production-model-secret",
        memoryApiKey: "production-memory-secret",
      },
      runtimeDeploymentSettings: { memoryScopeKeyConfigured: true },
      objectStorage: {
        endpoint: "https://skill-objects.example.invalid",
        bucket: "runtime-skill-publications",
      },
    });
    expect(configuration).not.toHaveProperty("developmentAuth");
  });

  it("开发固定身份只允许回环监听，production 不允许注入 Fake", async () => {
    expect(() =>
      parseAdminControlApiProcessEnvironment(
        developmentEnvironment({ ADMIN_CONTROL_LISTEN_HOST: "0.0.0.0" }),
      ),
    ).toThrow("DEVELOPMENT_API_REQUIRES_LOOPBACK_LISTENER");
    const assembler = { assemble: vi.fn() };
    await expect(
      startAdminControlApiProcess({ environment: productionEnvironment(), assembler }),
    ).rejects.toThrow("PRODUCTION_ASSEMBLY_UNAVAILABLE:admin-control-api");
    expect(assembler.assemble).not.toHaveBeenCalled();
  });

  it("拒绝复用普通 API audience、未知变量与 production 开发 Token", () => {
    expect(() =>
      parseAdminControlApiProcessEnvironment({
        ...productionEnvironment(),
        ADMIN_CONTROL_JWT_AUDIENCE: "hoox-api",
      }),
    ).toThrow("必须使用独立 audience");
    expect(() =>
      parseAdminControlApiProcessEnvironment({ ...productionEnvironment(), WRONG_SECRET: "x" }),
    ).toThrow("UNKNOWN:WRONG_SECRET");
    expect(() =>
      parseAdminControlApiProcessEnvironment({
        ...productionEnvironment(),
        DEV_ADMIN_CONTROL_TOKEN: "development-only",
      }),
    ).toThrow("FORBIDDEN_IN_PRODUCTION:DEV_ADMIN_CONTROL_TOKEN");
  });
});

it("开发和生产管理探测沿用现有私网开关，默认关闭", () => {
  for (const env of [productionEnvironment(), developmentEnvironment()]) {
    expect(parseAdminControlApiProcessEnvironment(env).externalToolsAllowPrivateAddresses).toBe(
      false,
    );
    expect(
      parseAdminControlApiProcessEnvironment({
        ...env,
        EXTERNAL_TOOLS_ALLOW_PRIVATE_ADDRESSES: "true",
      }).externalToolsAllowPrivateAddresses,
    ).toBe(true);
    expect(() =>
      parseAdminControlApiProcessEnvironment({
        ...env,
        EXTERNAL_TOOLS_ALLOW_PRIVATE_ADDRESSES: "yes",
      }),
    ).toThrow();
  }
});

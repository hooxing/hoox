import { describe, expect, it, vi } from "vitest";

const assemblyMocks = vi.hoisted(() => ({
  startDevelopment: vi.fn(),
  startProduction: vi.fn(),
}));

vi.mock("./production-assembly.js", () => ({
  startDevelopmentSkillAdminApiProcess: assemblyMocks.startDevelopment,
  startProductionSkillAdminApiProcess: assemblyMocks.startProduction,
}));

import {
  parseSkillAdminApiProcessEnvironment,
  selectSkillAdminApiProcessEnvironment,
  startSkillAdminApiProcess,
} from "./process-entry.js";

function productionEnvironment(): Record<string, string> {
  return {
    RUNTIME_ENV: "production",
    SKILL_PUBLISHER_DATABASE_URL:
      "postgresql://skill_publisher:credential@database:5432/runtime?sslmode=verify-full",
    DATABASE_SKILL_PUBLISHER_ROLE: "skill_publisher",
    DATABASE_SCHEMA: "runtime",
    SKILL_ADMIN_JWT_ISSUER: "https://issuer.example.invalid/runtime",
    SKILL_ADMIN_JWT_AUDIENCE: "cube-runtime-skill-admin-api",
    SKILL_ADMIN_JWT_SIGNING_KEYS: "skill-admin-current:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    SKILL_ADMIN_JWT_CLOCK_SKEW_SECONDS: "60",
    SKILL_ADMIN_JWT_MAX_LIFETIME_SECONDS: "1800",
    SKILL_ADMIN_LISTEN_HOST: "127.0.0.1",
    SKILL_ADMIN_LISTEN_PORT: "3002",
    SKILL_ADMIN_TLS_MODE: "proxy",
    SKILL_ADMIN_TLS_TRUSTED_PROXY_CIDRS: "127.0.0.1",
    SKILL_PUBLISHER_S3_ENDPOINT: "https://skill-objects.example.invalid:9000",
    SKILL_PUBLISHER_S3_BUCKET: "runtime-skill-publications",
    SKILL_PUBLISHER_S3_REGION: "us-east-1",
    SKILL_PUBLISHER_S3_ACCESS_KEY_ID: "skill-publisher-access-key",
    SKILL_PUBLISHER_S3_SECRET_ACCESS_KEY: "opaque-skill-publisher-secret",
    SKILL_PUBLISHER_S3_FORCE_PATH_STYLE: "true",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
  };
}

function developmentEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    RUNTIME_ENV: "development",
    SKILL_PUBLISHER_DATABASE_URL: "postgresql://skill_publisher:credential@127.0.0.1:5432/runtime",
    DATABASE_SCHEMA: "runtime",
    SKILL_ADMIN_LISTEN_HOST: "127.0.0.1",
    SKILL_ADMIN_LISTEN_PORT: "3002",
    SKILL_PUBLISHER_S3_ENDPOINT: "http://127.0.0.1:19000",
    SKILL_PUBLISHER_S3_BUCKET: "runtime-skill-publications",
    SKILL_PUBLISHER_S3_REGION: "us-east-1",
    SKILL_PUBLISHER_S3_ACCESS_KEY_ID: "local-skill-publisher",
    SKILL_PUBLISHER_S3_SECRET_ACCESS_KEY: "local-skill-publisher-secret",
    SKILL_PUBLISHER_S3_FORCE_PATH_STYLE: "true",
    DEV_SKILL_ADMIN_USER_ID: "user_skill_admin_local",
    DEV_SKILL_ADMIN_TOKEN: "local-skill-admin-token",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
    ...overrides,
  };
}

describe("Skill 管理 API 进程入口", () => {
  it("只投影独立发布边界配置，不接收 Migrator、普通数据库/API/S3 凭据", () => {
    const selected = selectSkillAdminApiProcessEnvironment({
      ...productionEnvironment(),
      DATABASE_URL: "postgresql://ordinary:secret@database:5432/runtime",
      DATABASE_RUNTIME_ROLE: "runtime",
      MIGRATOR_DATABASE_URL: "postgresql://migrator:secret@database:5432/runtime",
      API_JWT_AUDIENCE: "cube-runtime-api",
      S3_ENDPOINT: "https://ordinary-objects.example.invalid",
      S3_ACCESS_KEY_ID: "ordinary-access-key",
      S3_SECRET_ACCESS_KEY: "ordinary-secret",
    });

    expect(selected.SKILL_PUBLISHER_DATABASE_URL).toContain("skill_publisher");
    expect(selected.DATABASE_SKILL_PUBLISHER_ROLE).toBe("skill_publisher");
    expect(selected.SKILL_ADMIN_JWT_AUDIENCE).toBe("cube-runtime-skill-admin-api");
    expect(selected.SKILL_PUBLISHER_S3_ACCESS_KEY_ID).toBe("skill-publisher-access-key");
    expect(selected).not.toHaveProperty("DATABASE_URL");
    expect(selected).not.toHaveProperty("DATABASE_RUNTIME_ROLE");
    expect(selected).not.toHaveProperty("MIGRATOR_DATABASE_URL");
    expect(selected).not.toHaveProperty("API_JWT_AUDIENCE");
    expect(selected).not.toHaveProperty("S3_ENDPOINT");
    expect(selected).not.toHaveProperty("S3_ACCESS_KEY_ID");
    expect(selected).not.toHaveProperty("S3_SECRET_ACCESS_KEY");
  });

  it("production 在解析期固定独立 PG、JWT、TLS 与对象存储配置", () => {
    const configuration = parseSkillAdminApiProcessEnvironment(productionEnvironment());

    expect(configuration).toMatchObject({
      runtimeEnvironment: "production",
      databaseUrl: "postgresql://skill_publisher:credential@database:5432/runtime",
      databaseSsl: { rejectUnauthorized: true },
      databaseSchema: "runtime",
      databaseSkillPublisherRole: "skill_publisher",
      listenHost: "127.0.0.1",
      listenPort: 3002,
      objectStorage: {
        endpoint: "https://skill-objects.example.invalid:9000",
        bucket: "runtime-skill-publications",
      },
      production: {
        jwt: {
          issuer: "https://issuer.example.invalid/runtime",
          audience: "cube-runtime-skill-admin-api",
          clockSkewSeconds: 60,
          maxTokenLifetimeSeconds: 1800,
        },
        transport: { mode: "proxy" },
      },
    });
    expect(configuration).not.toHaveProperty("developmentAuth");
  });

  it("production 固定使用真实装配并在装配前拒绝 Fake", async () => {
    const assembler = Object.freeze({ assemble: vi.fn() });
    await expect(
      startSkillAdminApiProcess({ environment: productionEnvironment(), assembler }),
    ).rejects.toThrow("PRODUCTION_ASSEMBLY_UNAVAILABLE:skill-admin-api");
    expect(assembler.assemble).not.toHaveBeenCalled();
    expect(assemblyMocks.startProduction).not.toHaveBeenCalled();
  });

  it.each(["development", "test"] as const)(
    "%s 固定开发凭据只允许绑定回环 listener",
    async (runtimeEnvironment) => {
      const environment = developmentEnvironment({ RUNTIME_ENV: runtimeEnvironment });
      const configuration = parseSkillAdminApiProcessEnvironment(environment);
      expect(configuration.listenHost).toBe("127.0.0.1");
      expect(configuration.developmentAuth).toEqual({
        userId: "user_skill_admin_local",
        token: "local-skill-admin-token",
      });

      const assembler = {
        async assemble() {
          return { stopAccepting: async () => undefined, resources: [], readiness: [] };
        },
      };
      const running = await startSkillAdminApiProcess({ environment, assembler });
      await expect(running.readiness()).resolves.toEqual({ status: "ready" });
      await running.close();
    },
  );

  it.each(["0.0.0.0", "::", "192.0.2.12", "devbox", "127.0.0.2"])(
    "开发固定凭据拒绝非白名单监听地址 %s",
    (listenHost) => {
      expect(() =>
        parseSkillAdminApiProcessEnvironment(
          developmentEnvironment({ SKILL_ADMIN_LISTEN_HOST: listenHost }),
        ),
      ).toThrow("DEVELOPMENT_API_REQUIRES_LOOPBACK_LISTENER");
    },
  );

  it("production 拒绝开发身份、普通凭据、普通 API audience 与不安全传输", () => {
    expect(() =>
      parseSkillAdminApiProcessEnvironment({
        ...productionEnvironment(),
        DEV_SKILL_ADMIN_USER_ID: "user_dev_admin",
        DEV_SKILL_ADMIN_TOKEN: "development-only-token",
      }),
    ).toThrow("FORBIDDEN_IN_PRODUCTION:DEV_SKILL_ADMIN_TOKEN");
    expect(() =>
      parseSkillAdminApiProcessEnvironment({
        ...productionEnvironment(),
        DATABASE_URL: "postgresql://ordinary:secret@database:5432/runtime",
      }),
    ).toThrow("UNKNOWN:DATABASE_URL");
    expect(() =>
      parseSkillAdminApiProcessEnvironment({
        ...productionEnvironment(),
        SKILL_ADMIN_JWT_AUDIENCE: "cube-runtime-api",
      }),
    ).toThrow("必须与普通 API audience 隔离");
    expect(() =>
      parseSkillAdminApiProcessEnvironment({
        ...productionEnvironment(),
        SKILL_PUBLISHER_DATABASE_URL:
          "postgresql://skill_publisher:credential@database:5432/runtime?sslmode=require",
      }),
    ).toThrow("PRODUCTION_DATABASE_TRANSPORT_INVALID");
    expect(() =>
      parseSkillAdminApiProcessEnvironment({
        ...productionEnvironment(),
        SKILL_PUBLISHER_S3_ENDPOINT: "http://skill-objects.internal:9000",
      }),
    ).toThrow("production 必须为无凭据的 HTTPS URL");
  });

  it("未知变量、继承 TLS 覆盖与秘密格式错误只暴露稳定键名", () => {
    const secret = "must-not-appear";
    const source = { ...productionEnvironment(), WRONG_SECRET: secret };
    expect(() => parseSkillAdminApiProcessEnvironment(source)).toThrow("UNKNOWN:WRONG_SECRET");
    try {
      parseSkillAdminApiProcessEnvironment(source);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    expect(() =>
      parseSkillAdminApiProcessEnvironment({
        ...productionEnvironment(),
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      }),
    ).toThrow("PRODUCTION_INHERITED_ENVIRONMENT_FORBIDDEN");
    expect(() =>
      parseSkillAdminApiProcessEnvironment({
        ...productionEnvironment(),
        SKILL_ADMIN_JWT_SIGNING_KEYS: "secret-canary",
      }),
    ).toThrow("生产 JWT 密钥环无效");
  });
});

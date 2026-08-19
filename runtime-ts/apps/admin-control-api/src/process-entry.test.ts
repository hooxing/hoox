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
    ADMIN_CONTROL_DATABASE_URL:
      "postgresql://admin_control:credential@database:5432/runtime?sslmode=verify-full",
    DATABASE_ADMIN_CONTROL_ROLE: "admin_control",
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
    ADMIN_CONTROL_PROVIDER_HOST_ALLOWLIST: "model.example.invalid,api.mem0.ai",
    MODEL_API_KEY: "production-model-secret",
    MEM0_API_KEY: "production-memory-secret",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
  };
}

function developmentEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    RUNTIME_ENV: "development",
    ADMIN_CONTROL_DATABASE_URL: "postgresql://admin_control:credential@127.0.0.1:5432/runtime",
    DATABASE_SCHEMA: "runtime",
    ADMIN_CONTROL_LISTEN_HOST: "127.0.0.1",
    ADMIN_CONTROL_LISTEN_PORT: "3003",
    ADMIN_CONTROL_PROVIDER_HOST_ALLOWLIST: "model.example.invalid,api.mem0.ai",
    DEV_ADMIN_CONTROL_USER_ID: "user_admin_local",
    DEV_ADMIN_CONTROL_TOKEN: "local-admin-control-token",
    MODEL_API_KEY: "development-model-secret",
    MEM0_API_KEY: "development-memory-secret",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
    ...overrides,
  };
}

describe("后台控制 API 进程入口", () => {
  it("只投影控制面声明配置，不接收 Runtime 或 Migrator 凭据", () => {
    const selected = selectAdminControlApiProcessEnvironment({
      ...productionEnvironment(),
      DATABASE_URL: "postgresql://runtime:secret@database/runtime",
      MIGRATION_DATABASE_URL: "postgresql://migrator:secret@database/runtime",
      SKILL_PUBLISHER_DATABASE_URL: "postgresql://publisher:secret@database/runtime",
    });
    expect(selected.ADMIN_CONTROL_DATABASE_URL).toContain("admin_control");
    expect(selected).not.toHaveProperty("DATABASE_URL");
    expect(selected).not.toHaveProperty("MIGRATION_DATABASE_URL");
    expect(selected).not.toHaveProperty("SKILL_PUBLISHER_DATABASE_URL");
  });

  it("production 固定独立 PG、JWT、TLS、Provider 白名单且不含开发身份", () => {
    const configuration = parseAdminControlApiProcessEnvironment(productionEnvironment());
    expect(configuration).toMatchObject({
      runtimeEnvironment: "production",
      databaseAdminControlRole: "admin_control",
      databaseSsl: { rejectUnauthorized: true },
      listenPort: 3003,
      production: {
        jwt: { audience: "hoox-admin-control-api" },
        transport: { mode: "proxy" },
      },
      providerSecrets: {
        modelApiKey: "production-model-secret",
        memoryApiKey: "production-memory-secret",
      },
    });
    expect(configuration.providerHostAllowlist).toEqual(
      new Set(["model.example.invalid", "api.mem0.ai"]),
    );
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

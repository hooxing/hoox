import { describe, expect, it } from "vitest";

import {
  parseSchedulerProcessEnvironment,
  selectSchedulerProcessEnvironment,
  startSchedulerProcess,
} from "./process-entry.js";

function productionEnvironment(): Record<string, string> {
  return {
    RUNTIME_ENV: "production",
    DATABASE_URL: "postgresql://runtime:credential@database:5432/runtime?sslmode=verify-full",
    DATABASE_RUNTIME_ROLE: "runtime",
    DATABASE_SCHEMA: "runtime",
    CUBESANDBOX_API_URL: "https://cube-api.invalid",
    CUBESANDBOX_PROXY_SCHEME: "https",
    SCHEDULER_TENANT_ID: "tenant-test",
    SCHEDULER_WORKER_ID: "scheduler-test",
    CLEANUP_POLL_INTERVAL_MS: "1000",
    CLEANUP_LEASE_MS: "210000",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
  };
}

function developmentEnvironment(): Record<string, string> {
  return {
    RUNTIME_ENV: "development",
    DATABASE_URL: "postgresql://runtime:credential@127.0.0.1:5432/runtime",
    DATABASE_RUNTIME_ROLE: "runtime",
    DATABASE_SCHEMA: "runtime",
    CUBESANDBOX_API_URL: "http://127.0.0.1:18080",
    SCHEDULER_TENANT_ID: "tenant-a",
    SCHEDULER_WORKER_ID: "scheduler-development",
    CLEANUP_POLL_INTERVAL_MS: "1000",
    CLEANUP_LEASE_MS: "210000",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
  };
}

describe("Scheduler 进程入口", () => {
  it("腾讯云 AGS 与 E2B 使用独立配置，缺少 AGS 凭据时失败关闭", () => {
    const env = {
      ...productionEnvironment(),
      SANDBOX_DEFAULT_PROVIDER: "tencent-ags",
      SANDBOX_ENABLED_PROVIDERS: "e2b,tencent-ags",
      E2B_API_KEY: "test-e2b",
      TENCENT_AGS_API_KEY: "test-ags",
      TENCENT_AGS_DOMAIN: "ags.example.invalid",
    };
    expect(parseSchedulerProcessEnvironment(env).sandbox).toMatchObject({
      defaultProviderKey: "tencent-ags",
      enabledProviderKeys: ["e2b", "tencent-ags"],
      tencentAgs: { apiKey: "test-ags", domain: "ags.example.invalid" },
      e2b: { apiKey: "test-e2b" },
    });
    const { TENCENT_AGS_API_KEY: _key, ...missingKey } = env;
    expect(() => parseSchedulerProcessEnvironment(missingKey)).toThrow("TENCENT_AGS_API_KEY");
    const { TENCENT_AGS_DOMAIN: _domain, ...missingDomain } = env;
    expect(() => parseSchedulerProcessEnvironment(missingDomain)).toThrow("TENCENT_AGS_DOMAIN");
  });

  it("development 允许使用受控装配启动常驻 Scheduler", async () => {
    const running = await startSchedulerProcess({
      environment: developmentEnvironment(),
      assembler: {
        async assemble() {
          return { stopAccepting: async () => undefined, resources: [], readiness: [] };
        },
      },
    });

    expect((await running.readiness()).status).toBe("ready");
    await running.close();
  });

  it("production 在解析最早边界拒绝继承的 Node TLS/代理覆盖", () => {
    expect(() =>
      parseSchedulerProcessEnvironment({
        ...productionEnvironment(),
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      }),
    ).toThrow("PRODUCTION_INHERITED_ENVIRONMENT_FORBIDDEN");
  });

  it("配置可验证，传入 Fake assembler 不能冒充受审生产装配", async () => {
    const configuration = parseSchedulerProcessEnvironment(productionEnvironment());
    expect(configuration.threadSandbox).toEqual({
      retentionSchedulerEnabled: true,
      lifecycleTimeoutMs: 90_000,
      pausedRetentionSeconds: 86_400,
    });
    expect(configuration.sandbox).toMatchObject({
      apiUrl: "https://cube-api.invalid",
      proxyNodeIp: "cube-api.invalid",
      proxyScheme: "https",
    });
    await expect(
      startSchedulerProcess({
        environment: productionEnvironment(),
        assembler: {
          async assemble() {
            return { stopAccepting: async () => undefined, resources: [], readiness: [] };
          },
        },
      }),
    ).rejects.toThrow("PRODUCTION_ASSEMBLY_UNAVAILABLE:scheduler");
  });

  it("retention scheduler 与 lifecycle 参数显式配置，关闭 retention 不关闭 effect 对账装配", () => {
    expect(
      parseSchedulerProcessEnvironment({
        ...productionEnvironment(),
        THREAD_SANDBOX_RETENTION_SCHEDULER_ENABLED: "true",
        THREAD_SANDBOX_LIFECYCLE_TIMEOUT_MS: "120000",
        THREAD_SANDBOX_PAUSED_RETENTION_SECONDS: "1800",
      }).threadSandbox,
    ).toEqual({
      retentionSchedulerEnabled: true,
      lifecycleTimeoutMs: 120_000,
      pausedRetentionSeconds: 1_800,
    });
  });
  it("低成本标题模型独立配置，并保证 claim lease 覆盖模型超时", () => {
    expect(
      parseSchedulerProcessEnvironment({
        ...productionEnvironment(),
        HISTORY_TITLE_GENERATION_ENABLED: "true",
        HISTORY_TITLE_MODEL_BASE_URL: "https://title-model.invalid/v1",
        HISTORY_TITLE_MODEL_API_KEY: "secret",
        HISTORY_TITLE_MODEL_ID: "cheap-title-model",
        HISTORY_TITLE_MODEL_TIMEOUT_MS: "20000",
        HISTORY_TITLE_INPUT_MAX_BYTES: "4096",
        HISTORY_TITLE_MAX_OUTPUT_TOKENS: "128",
        HISTORY_TITLE_MAX_ATTEMPTS: "3",
        HISTORY_TITLE_RETRY_BASE_MS: "5000",
        HISTORY_TITLE_POLL_INTERVAL_MS: "1000",
        HISTORY_TITLE_CLAIM_LEASE_MS: "60000",
      }).titleGeneration,
    ).toEqual({
      baseUrl: "https://title-model.invalid/v1",
      apiKey: "secret",
      modelId: "cheap-title-model",
      timeoutMs: 20_000,
      inputMaximumBytes: 4_096,
      maximumOutputTokens: 128,
      maximumAttempts: 3,
      retryBaseMs: 5_000,
      pollIntervalMs: 1_000,
      claimLeaseMs: 60_000,
    });
    expect(() =>
      parseSchedulerProcessEnvironment({
        ...developmentEnvironment(),
        HISTORY_TITLE_GENERATION_ENABLED: "true",
        HISTORY_TITLE_MODEL_BASE_URL: "http://127.0.0.1:18081/v1",
        HISTORY_TITLE_MODEL_API_KEY: "secret",
        HISTORY_TITLE_MODEL_ID: "cheap-title-model",
        HISTORY_TITLE_MODEL_TIMEOUT_MS: "20000",
        HISTORY_TITLE_CLAIM_LEASE_MS: "24000",
      }),
    ).toThrow("HISTORY_TITLE_CLAIM_LEASE_MS");
  });

  it("Scheduler 显式启用 E2B 时构造 Provider 路由配置", () => {
    const configuration = parseSchedulerProcessEnvironment({
      ...productionEnvironment(),
      SANDBOX_DEFAULT_PROVIDER: "e2b",
      SANDBOX_ENABLED_PROVIDERS: "cube,e2b",
      E2B_API_KEY: "opaque-e2b-test-key",
    });
    expect(configuration.sandbox).toMatchObject({
      defaultProviderKey: "e2b",
      enabledProviderKeys: ["cube", "e2b"],
      e2b: { apiKey: "opaque-e2b-test-key" },
    });
  });

  it("Scheduler 支持部分显式 Proxy 配置，显式 scheme 优先于 443 默认", () => {
    expect(
      parseSchedulerProcessEnvironment({
        ...productionEnvironment(),
        CUBESANDBOX_PROXY_NODE_IP: "10.0.0.10",
        CUBESANDBOX_PROXY_PORT: "443",
      }).sandbox,
    ).toMatchObject({
      proxyNodeIp: "10.0.0.10",
      proxyPort: 443,
      proxyScheme: "https",
    });
    expect(() =>
      parseSchedulerProcessEnvironment({
        ...productionEnvironment(),
        CUBESANDBOX_PROXY_PORT: "443",
        CUBESANDBOX_PROXY_SCHEME: "http",
      }),
    ).toThrow("CUBESANDBOX_PROXY_SCHEME 在 production 必须为 https");
  });

  it("未知变量严格失败", () => {
    expect(() =>
      parseSchedulerProcessEnvironment({ ...productionEnvironment(), UNUSED_FLAG: "true" }),
    ).toThrow("UNKNOWN:UNUSED_FLAG");
  });

  it("宿主 S3 密钥不属于 Scheduler 声明配置，也不会进入投影", () => {
    const selected = selectSchedulerProcessEnvironment({
      ...productionEnvironment(),
      S3_ENDPOINT: "https://object-storage.invalid",
      S3_ACCESS_KEY_ID: "must-not-enter-scheduler",
      S3_SECRET_ACCESS_KEY: "must-not-enter-scheduler",
    });
    expect(selected).not.toHaveProperty("S3_ENDPOINT");
    expect(selected).not.toHaveProperty("S3_ACCESS_KEY_ID");
    expect(selected).not.toHaveProperty("S3_SECRET_ACCESS_KEY");
  });

  it("按 UTF-8 与领域 Tenant ID 在启动前拒绝永久配置错误", () => {
    expect(() =>
      parseSchedulerProcessEnvironment({
        ...productionEnvironment(),
        SCHEDULER_WORKER_ID: "😀".repeat(51),
      }),
    ).toThrow("SCHEDULER_WORKER_ID UTF-8");
    expect(() =>
      parseSchedulerProcessEnvironment({
        ...productionEnvironment(),
        SCHEDULER_TENANT_ID: "bad tenant",
      }),
    ).toThrow("ID 格式无效");
    expect(() =>
      parseSchedulerProcessEnvironment({
        ...productionEnvironment(),
        CUBESANDBOX_PROXY_SCHEME: "ftp",
      }),
    ).toThrow("CUBESANDBOX_PROXY_SCHEME");
    expect(() =>
      parseSchedulerProcessEnvironment({
        ...productionEnvironment(),
        DATABASE_RUNTIME_ROLE: "Runtime-Owner",
      }),
    ).toThrow("DATABASE_RUNTIME_ROLE 格式无效");
    expect(() =>
      parseSchedulerProcessEnvironment({
        ...productionEnvironment(),
        DATABASE_URL: "postgresql://runtime:credential@database/runtime?sslmode=require",
      }),
    ).toThrow("PRODUCTION_DATABASE_TRANSPORT_INVALID");
    expect(() =>
      parseSchedulerProcessEnvironment({
        ...productionEnvironment(),
        CUBESANDBOX_API_URL: "http://cube-api.internal",
      }),
    ).toThrow("CUBESANDBOX_API_URL 在 production 必须为无凭据的 HTTPS URL");
  });
});

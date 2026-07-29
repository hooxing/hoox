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

describe("Scheduler 进程入口", () => {
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

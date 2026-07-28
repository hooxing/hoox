import { describe, expect, it } from "vitest";

import { parseSchedulerProcessEnvironment, startSchedulerProcess } from "./process-entry.js";

function productionEnvironment(): Record<string, string> {
  return {
    RUNTIME_ENV: "production",
    DATABASE_URL: "postgresql://runtime:credential@database/runtime",
    DATABASE_SCHEMA: "runtime",
    S3_ENDPOINT: "http://object-storage:9000",
    S3_BUCKET: "runtime-artifacts",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: "local-access-key",
    S3_SECRET_ACCESS_KEY: "opaque-test-value",
    S3_FORCE_PATH_STYLE: "true",
    CUBESANDBOX_API_URL: "http://cube-api:3000",
    SCHEDULER_TENANT_ID: "tenant-test",
    SCHEDULER_WORKER_ID: "scheduler-test",
    CLEANUP_POLL_INTERVAL_MS: "1000",
    CLEANUP_LEASE_MS: "210000",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
  };
}

describe("Scheduler 进程入口", () => {
  it("配置可验证，传入 Fake assembler 不能冒充受审生产装配", async () => {
    const configuration = parseSchedulerProcessEnvironment(productionEnvironment());
    expect(configuration.objectStorage.bucket).toBe("runtime-artifacts");
    expect(configuration.sandbox).toMatchObject({
      apiUrl: "http://cube-api:3000",
      proxyNodeIp: "cube-api",
      proxyScheme: "http",
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

  it("未知变量严格失败", () => {
    expect(() =>
      parseSchedulerProcessEnvironment({ ...productionEnvironment(), UNUSED_FLAG: "true" }),
    ).toThrow("UNKNOWN:UNUSED_FLAG");
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
  });
});

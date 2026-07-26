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
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
  };
}

describe("Scheduler 进程入口", () => {
  it("配置可验证，但不以空消费者伪装为生产进程", async () => {
    const configuration = parseSchedulerProcessEnvironment(productionEnvironment());
    expect(configuration.objectStorage.bucket).toBe("runtime-artifacts");
    await expect(startSchedulerProcess({ environment: productionEnvironment() })).rejects.toThrow(
      "ASSEMBLER_MISSING:scheduler",
    );
  });

  it("未知变量严格失败", () => {
    expect(() =>
      parseSchedulerProcessEnvironment({ ...productionEnvironment(), UNUSED_FLAG: "true" }),
    ).toThrow("UNKNOWN:UNUSED_FLAG");
  });
});

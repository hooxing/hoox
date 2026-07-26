import { describe, expect, it } from "vitest";

import { parseWorkerProcessEnvironment, startWorkerProcess } from "./process-entry.js";

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
    CUBESANDBOX_API_URL: "http://sandbox:3000",
    CUBESANDBOX_TEMPLATE_ID: "tpl-test",
    MODEL_BASE_URL: "https://model.invalid/v1",
    MODEL_API_KEY: "opaque-model-value",
    MODEL_ID: "test-model",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
  };
}

describe("Agent Worker 进程入口", () => {
  it("解析生产依赖，但没有真实装配器时拒绝启动", async () => {
    const configuration = parseWorkerProcessEnvironment(productionEnvironment());
    expect(configuration.sandbox.templateId).toBe("tpl-test");
    await expect(startWorkerProcess({ environment: productionEnvironment() })).rejects.toThrow(
      "ASSEMBLER_MISSING:agent-worker",
    );
  });

  it("缺少模型依赖时在装配前失败且不泄漏其他秘密", () => {
    const source = productionEnvironment();
    const secret = source.S3_SECRET_ACCESS_KEY;
    delete source.MODEL_API_KEY;
    try {
      parseWorkerProcessEnvironment(source);
      expect.fail("应当拒绝缺失的模型密钥");
    } catch (error) {
      expect(String(error)).toContain("MISSING:MODEL_API_KEY");
      expect(String(error)).not.toContain(secret);
    }
  });
});

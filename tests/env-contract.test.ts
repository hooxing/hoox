import { describe, expect, it } from "vitest";
import { expectedEnvironmentKeys, validateEnvironmentExample } from "../scripts/env-contract.mjs";

function validExample(): string {
  return expectedEnvironmentKeys
    .map((key) => {
      if (
        key === "DATABASE_URL" ||
        key === "DATABASE_BOOTSTRAP_URL" ||
        key === "MIGRATION_DATABASE_URL"
      ) {
        return `${key}=postgresql://user:replace-me@localhost/db`;
      }
      if (key === "DATABASE_DOCKER_URL") {
        return `${key}=postgresql://user:replace-me@database/db`;
      }
      if (key === "MODEL_BASE_URL") return `${key}=https://provider.example.invalid/v1`;
      if (
        key.endsWith("PASSWORD") ||
        key.endsWith("SECRET_ACCESS_KEY") ||
        key.endsWith("ACCESS_KEY_ID") ||
        key.endsWith("API_KEY") ||
        key.endsWith("SIGNING_KEY") ||
        key.endsWith("SIGNING_KEYS") ||
        key.endsWith("TEMPLATE_ID") ||
        key === "RESOURCEFS_PROXY_TLS_KEY_PATH" ||
        key === "RESOURCEFS_PROXY_TLS_CERT_PATH" ||
        key === "MINIO_ROOT_USER" ||
        key === "MODEL_ID"
      ) {
        return `${key}=replace-with-value`;
      }
      return `${key}=example`;
    })
    .join("\n");
}

describe("环境变量示例契约", () => {
  it("接受完整且只包含占位凭据的示例", () => {
    expect(expectedEnvironmentKeys).toEqual(
      expect.arrayContaining([
        "THREAD_SERIAL_QUEUE_V2_ENABLED",
        "THREAD_CONTEXT_V2_WRITE_ENABLED",
        "THREAD_CONTEXT_V2_SHADOW_READ_ENABLED",
        "THREAD_CONTEXT_V2_READ_ENABLED",
        "THREAD_INPUT_ROUTING_V2_ENABLED",
        "THREAD_CONTEXT_INLINE_BODY_MAX_BYTES",
        "THREAD_CONTEXT_COMPACTION_ENABLED",
        "THREAD_CONTEXT_COMPACTION_PATH",
        "THREAD_CONTEXT_COMPACTION_SOFT_LIMIT_PERCENT",
        "THREAD_CONTEXT_COMPACTION_TARGET_PERCENT",
        "THREAD_CONTEXT_COMPACTION_RECENT_USER_TOKENS",
        "THREAD_CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS",
        "THREAD_CONTEXT_COMPACTION_TIMEOUT_MS",
        "THREAD_SANDBOX_SESSION_REUSE_ENABLED",
        "THREAD_SANDBOX_RETENTION_SCHEDULER_ENABLED",
        "CUBESANDBOX_SESSION_TTL_SECONDS",
        "THREAD_SANDBOX_PAUSED_RETENTION_SECONDS",
        "THREAD_SANDBOX_LIFECYCLE_TIMEOUT_MS",
        "CUBESANDBOX_RESOURCE_VOLUME_DRIVER",
        "RESOURCE_FILESYSTEM_SIGNING_KEY",
        "RESOURCEFS_PROXY_TLS_KEY_PATH",
        "RESOURCEFS_PROXY_TLS_CERT_PATH",
        "MODEL_WIRE_TRACE_ENABLED",
        "MODEL_WIRE_TRACE_RETENTION_DAYS",
        "MODEL_WIRE_TRACE_MAX_BYTES",
      ]),
    );
    expect(validateEnvironmentExample(validExample())).toEqual([]);
  });

  it("同时报告缺失项和未登记项", () => {
    const source = validExample()
      .split("\n")
      .filter((line) => !line.startsWith("MODEL_ID="))
      .concat("UNKNOWN_KEY=example")
      .join("\n");

    expect(validateEnvironmentExample(source)).toEqual([
      "缺少环境变量：MODEL_ID",
      "未登记的环境变量：UNKNOWN_KEY",
    ]);
  });

  it("拒绝疑似真实密钥且错误信息不泄漏配置值", () => {
    const liveLikeValue = "sk-live-like-value-for-test";
    const source = validExample().replace(
      "MODEL_API_KEY=replace-with-value",
      `MODEL_API_KEY=${liveLikeValue}`,
    );
    const issues = validateEnvironmentExample(source);

    expect(issues).toContain("示例配置疑似包含真实凭据：MODEL_API_KEY");
    expect(issues.join(" ")).not.toContain(liveLikeValue);
  });

  it("CubeSandbox API Key 可以为空但不能在示例中填写真实值", () => {
    expect(
      validateEnvironmentExample(
        validExample().replace("CUBESANDBOX_API_KEY=replace-with-value", "CUBESANDBOX_API_KEY="),
      ),
    ).toEqual([]);
    expect(
      validateEnvironmentExample(
        validExample().replace(
          "CUBESANDBOX_API_KEY=replace-with-value",
          "CUBESANDBOX_API_KEY=live-cube-key",
        ),
      ),
    ).toContain("示例配置疑似包含真实凭据：CUBESANDBOX_API_KEY");
  });
});

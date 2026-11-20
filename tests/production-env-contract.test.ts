import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  expectedProductionEnvironmentKeys,
  optionalProductionEnvironmentKeys,
  validateProductionEnvironmentExample,
} from "../scripts/production-env-contract.mjs";

const example = readFileSync(new URL("../deploy/production.env.example", import.meta.url), "utf8");

describe("production 部署配置契约", () => {
  it("OTLP 样例拒绝带凭据的端点和请求头且不回显配置值", () => {
    const issues = validateProductionEnvironmentExample(
      example
        .replace(
          /^OTEL_EXPORT_ENDPOINT=.*$/mu,
          "OTEL_EXPORT_ENDPOINT=https://otel.example.invalid/?auth=secret-placeholder",
        )
        .replace(
          /^OTEL_EXPORT_HEADERS=.*$/mu,
          'OTEL_EXPORT_HEADERS={"authorization":"secret-placeholder"}',
        ),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("OTEL_EXPORT_ENDPOINT"),
        expect.stringContaining("OTEL_EXPORT_HEADERS"),
      ]),
    );
    expect(issues.join(" ")).not.toContain("secret-placeholder");
  });

  it("基础部署样例不要求供应商与后台运行参数，可选回退仍登记", () => {
    const source = example
      .split("\n")
      .filter(
        (line) => !optionalProductionEnvironmentKeys.some((key) => line.startsWith(`${key}=`)),
      )
      .join("\n");
    expect(validateProductionEnvironmentExample(source)).toEqual([]);
    for (const key of [
      "MODEL_API_KEY",
      "SANDBOX_ENABLED_PROVIDERS",
      "HISTORY_TITLE_MODEL_API_KEY",
      "MEM0_API_KEY",
      "AGENT_WORKER_MAX_CONCURRENT_RUNS",
      "THREAD_CONTEXT_COMPACTION_TIMEOUT_MS",
    ]) {
      expect(expectedProductionEnvironmentKeys).not.toContain(key);
      expect(optionalProductionEnvironmentKeys).toContain(key);
    }
    expect(expectedProductionEnvironmentKeys).toContain("MODEL_CREDENTIAL_ENCRYPTION_KEY");
  });

  it("AGS 示例凭据必须使用占位值且诊断不回显密钥", () => {
    const secret = "ags-private-canary";
    const issues = validateProductionEnvironmentExample(
      `${example}\nTENCENT_AGS_API_KEY=${secret}`,
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join(" ")).toContain("TENCENT_AGS_API_KEY");
    expect(issues.join(" ")).not.toContain(secret);
  });

  it("完整样例只使用占位凭据，且不包含 development 身份", () => {
    expect(expectedProductionEnvironmentKeys).not.toContain("DEV_AUTH_ENABLED");
    expect([...expectedProductionEnvironmentKeys, ...optionalProductionEnvironmentKeys]).toEqual(
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
        "SUBAGENTS_ENABLED",
        "THREAD_SANDBOX_RETENTION_SCHEDULER_ENABLED",
        "CUBESANDBOX_SESSION_TTL_SECONDS",
        "THREAD_SANDBOX_PAUSED_RETENTION_SECONDS",
        "THREAD_SANDBOX_LIFECYCLE_TIMEOUT_MS",
        "BETTER_AUTH_SECRET",
        "BETTER_AUTH_TRUSTED_ORIGINS",
        "RESOURCE_FILESYSTEM_SIGNING_KEY",
        "CUBESANDBOX_RESOURCE_VOLUME_DRIVER",
        "MODEL_WIRE_TRACE_ENABLED",
        "MODEL_WIRE_TRACE_RETENTION_DAYS",
        "MODEL_WIRE_TRACE_MAX_BYTES",
        "AGENT_WORKER_MAX_CONCURRENT_RUNS",
        "AGENT_WORKER_USER_MAX_CONCURRENT_RUNS_PER_TENANT",
        "DATABASE_WORKER_COORDINATOR_URL",
        "DATABASE_WORKER_COORDINATOR_ROLE",
        "DATABASE_TEAM_COORDINATOR_URL",
        "DATABASE_TEAM_COORDINATOR_ROLE",
      ]),
    );
    expect(validateProductionEnvironmentExample(example)).toEqual([]);
  });

  it("生产样例固定关闭尚未部署清理 consumer 的模型报文采集", () => {
    const enabled = example.replace(
      "MODEL_WIRE_TRACE_ENABLED=false",
      "MODEL_WIRE_TRACE_ENABLED=true",
    );
    expect(validateProductionEnvironmentExample(enabled)).toContain(
      "生产样例 MODEL_WIRE_TRACE_ENABLED 必须为 false",
    );
  });

  it("生产样例默认开启 Thread 连续性能力", () => {
    const disabled = example.replace(
      "THREAD_SERIAL_QUEUE_V2_ENABLED=true",
      "THREAD_SERIAL_QUEUE_V2_ENABLED=false",
    );
    expect(validateProductionEnvironmentExample(disabled)).toContain(
      "生产样例 THREAD_SERIAL_QUEUE_V2_ENABLED 必须为 true",
    );
  });

  it("development 身份、明文端点和真实样式密钥都会失败且不回显其值", () => {
    const secret = "live-production-secret-canary";
    const source = `${example}\nDEV_AUTH_ENABLED=false\nMODEL_API_KEY=${secret}`.replace(
      "S3_ENDPOINT=https://s3.internal.example.invalid",
      "S3_ENDPOINT=http://s3.internal",
    );
    const issues = validateProductionEnvironmentExample(source);
    expect(issues).toContain("未登记的生产环境变量：DEV_AUTH_ENABLED");
    expect(issues).toContain("生产配置禁止开发身份变量：DEV_AUTH_ENABLED");
    expect(issues).toContain("生产样例必须使用无凭据 HTTPS：S3_ENDPOINT");
    expect(issues).toContain("示例配置疑似包含真实凭据：MODEL_API_KEY");
    expect(issues.join(" ")).not.toContain(secret);
  });

  it("对象交付必须使用独立 origin，不能与浏览器/API 同源代理", () => {
    const source = example.replace(
      "S3_PUBLIC_ENDPOINT=https://downloads.example.invalid",
      "S3_PUBLIC_ENDPOINT=https://app.example.invalid",
    );
    expect(validateProductionEnvironmentExample(source)).toContain(
      "S3_PUBLIC_ENDPOINT 必须使用独立对象 origin",
    );
  });

  it("Better Auth 允许配置多个无凭据 HTTPS origin", () => {
    const multipleOrigins = example.replace(
      "BETTER_AUTH_TRUSTED_ORIGINS=https://app.example.invalid",
      "BETTER_AUTH_TRUSTED_ORIGINS=https://app.example.invalid,https://admin.example.invalid",
    );
    expect(validateProductionEnvironmentExample(multipleOrigins)).toEqual([]);

    const invalidOrigins = example.replace(
      "BETTER_AUTH_TRUSTED_ORIGINS=https://app.example.invalid",
      "BETTER_AUTH_TRUSTED_ORIGINS=https://app.example.invalid/path,http://admin.example.invalid",
    );
    expect(validateProductionEnvironmentExample(invalidOrigins)).toContain(
      "生产样例 BETTER_AUTH_TRUSTED_ORIGINS 必须全部为无凭据 HTTPS origin",
    );
  });
});

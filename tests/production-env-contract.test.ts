import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  expectedProductionEnvironmentKeys,
  optionalProductionEnvironmentKeys,
  validateProductionEnvironmentExample,
} from "../scripts/production-env-contract.mjs";

const example = readFileSync(new URL("../deploy/production.env.example", import.meta.url), "utf8");

describe("production 部署配置契约", () => {
  it("按运行时 dotenv 解析带引号值、行尾注释和 CRLF", () => {
    const source = example
      .replace(
        "S3_ENDPOINT=https://s3.internal.example.invalid",
        'S3_ENDPOINT="https://s3.internal.example.invalid" # endpoint',
      )
      .replace("S3_BUCKET=agent-runtime-production", "S3_BUCKET=agent-runtime-production # bucket")
      .replace("S3_REGION=us-east-1", 'S3_REGION="us-east-1" # region')
      .replace(
        "S3_ACCESS_KEY_ID=replace-with-production-s3-access-key",
        'S3_ACCESS_KEY_ID="replace-with-access-key" # key',
      )
      .replace(
        "S3_SECRET_ACCESS_KEY=replace-with-production-s3-secret-key",
        'S3_SECRET_ACCESS_KEY="replace-with-secret-key" # secret',
      )
      .replace("S3_FORCE_PATH_STYLE=false", 'S3_FORCE_PATH_STYLE="false" # boolean')
      .replaceAll("\n", "\r\n");
    expect(validateProductionEnvironmentExample(source)).toEqual([]);
  });

  it.each([
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_REGION",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_FORCE_PATH_STYLE",
  ])("解析后的空串或纯空白 %s 会失败", (key) => {
    const line = new RegExp(`^${key}=.*$`, "mu");
    for (const value of ['""', '"   "', "   # comment"]) {
      expect(
        validateProductionEnvironmentExample(example.replace(line, `${key}=${value}`)),
      ).toContain(`环境变量不能为空：${key}`);
    }
  });

  it("S3 字符串拒绝非空的首尾空白", () => {
    const issues = validateProductionEnvironmentExample(
      example.replace("S3_BUCKET=agent-runtime-production", 'S3_BUCKET=" runtime-production "'),
    );
    expect(issues).toContain("环境变量不能包含首尾空白：S3_BUCKET");
  });

  it.each([
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_REGION",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_FORCE_PATH_STYLE",
  ])("Scheduler 与 Admin Control 也需要的 %s 必须声明且不能为空", (key) => {
    const pattern = new RegExp(`^${key}=.*$`, "mu");
    expect(validateProductionEnvironmentExample(example.replace(pattern, ""))).toContain(
      `缺少环境变量：${key}`,
    );
    expect(validateProductionEnvironmentExample(example.replace(pattern, `${key}=`))).toContain(
      `环境变量不能为空：${key}`,
    );
  });

  it("对象存储路径开关必须是布尔值且不回显非法配置", () => {
    const issues = validateProductionEnvironmentExample(
      example.replace("S3_FORCE_PATH_STYLE=false", "S3_FORCE_PATH_STYLE=invalid-placeholder"),
    );
    expect(issues).toContain("S3_FORCE_PATH_STYLE 必须为 true 或 false");
    expect(issues.join(" ")).not.toContain("invalid-placeholder");
  });

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

  it("生产样例必须提供占位身份根，拒绝非占位密钥且不回显", () => {
    const root = "EXTERNAL_TOOL_IDENTITY_ROOT_KEY";
    const withoutRoot = example
      .split("\n")
      .filter((line) => !line.startsWith(`${root}=`))
      .join("\n");
    expect(validateProductionEnvironmentExample(withoutRoot)).toEqual([`缺少环境变量：${root}`]);
    for (const placeholder of [
      "replace-with-production-external-tool-identity-root-key-at-least-32-bytes",
      "<external-tool-identity-root-key-placeholder>",
    ]) {
      expect(
        validateProductionEnvironmentExample(`${withoutRoot}\n${root}=${placeholder}`),
      ).toEqual([]);
    }
    const secret = "test-only-identity-root-canary-at-least-32-bytes";
    const issues = validateProductionEnvironmentExample(`${withoutRoot}\n${root}=${secret}`);
    expect(issues).toEqual([`示例配置疑似包含真实凭据：${root}`]);
    expect(JSON.stringify(issues).includes(secret)).toBe(false);
  });

  it("生产外部工具私网开关为可选布尔值", () => {
    const flag = "EXTERNAL_TOOLS_ALLOW_PRIVATE_ADDRESSES";
    const withoutFlag = example
      .split("\n")
      .filter((line) => !line.startsWith(`${flag}=`))
      .join("\n");
    expect(validateProductionEnvironmentExample(withoutFlag)).toEqual([]);
    for (const value of ["true", "false"]) {
      expect(validateProductionEnvironmentExample(`${withoutFlag}\n${flag}=${value}`)).toEqual([]);
    }
    expect(validateProductionEnvironmentExample(`${withoutFlag}\n${flag}=yes`)).toEqual([
      `${flag} 必须为 true 或 false`,
    ]);
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
        "DATABASE_TRAJECTORY_DIRECTORY_ROLE",
        "DATABASE_TRAJECTORY_DIRECTORY_URL",
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

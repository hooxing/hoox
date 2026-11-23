import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateComposePostgresBootstrap } from "../scripts/validate-env-example.mjs";
import {
  expectedEnvironmentKeys,
  optionalEnvironmentKeys,
  validateEnvironmentExample,
} from "../scripts/env-contract.mjs";

function validExample(): string {
  return [...expectedEnvironmentKeys, ...optionalEnvironmentKeys]
    .map((key) => {
      switch (key) {
        case "EXTERNAL_TOOLS_ALLOW_PRIVATE_ADDRESSES":
        case "S3_FORCE_PATH_STYLE":
        case "OTEL_EXPORT_ENABLED":
        case "OTEL_EXPORT_CONTENT_ENABLED":
          return `${key}=false`;
        case "OTEL_EXPORT_ENDPOINT":
          return `${key}=https://otel.example.invalid`;
        case "OTEL_EXPORT_HEADERS":
          return `${key}=`;
        case "OTEL_EXPORT_SAMPLE_RATE":
          return `${key}=1`;
      }
      if (
        key === "DATABASE_URL" ||
        key === "DATABASE_WORKER_COORDINATOR_URL" ||
        key === "DATABASE_TRAJECTORY_DIRECTORY_URL" ||
        key === "DATABASE_TEAM_COORDINATOR_URL" ||
        key === "WEBHOOK_DISPATCHER_DATABASE_URL" ||
        key === "DATABASE_BOOTSTRAP_URL" ||
        key === "MIGRATION_DATABASE_URL" ||
        key === "SKILL_PUBLISHER_DATABASE_URL" ||
        key === "ADMIN_CONTROL_DATABASE_URL"
      ) {
        return `${key}=postgresql://user:replace-me@localhost/db`;
      }
      if (key === "DATABASE_DOCKER_URL") {
        return `${key}=postgresql://user:replace-me@database/db`;
      }
      if (key === "MODEL_BASE_URL" || key === "HISTORY_TITLE_MODEL_BASE_URL") {
        return `${key}=https://provider.example.invalid/v1`;
      }
      if (
        key.endsWith("PASSWORD") ||
        key.endsWith("SECRET_ACCESS_KEY") ||
        key.endsWith("ACCESS_KEY_ID") ||
        key.endsWith("API_KEY") ||
        key.endsWith("SIGNING_KEY") ||
        key.endsWith("SIGNING_KEYS") ||
        key.endsWith("HMAC_KEY") ||
        key.endsWith("TOKEN") ||
        key.endsWith("TEMPLATE_ID") ||
        key === "MODEL_CREDENTIAL_ENCRYPTION_KEY" ||
        key === "EXTERNAL_TOOL_IDENTITY_ROOT_KEY" ||
        key === "WEBHOOK_SECRET_ENCRYPTION_KEY" ||
        key === "RESOURCEFS_PROXY_TLS_KEY_PATH" ||
        key === "RESOURCEFS_PROXY_TLS_CERT_PATH" ||
        key === "MINIO_ROOT_USER" ||
        key === "MODEL_ID" ||
        key === "HISTORY_TITLE_MODEL_ID"
      ) {
        return `${key}=replace-with-value`;
      }
      return `${key}=example`;
    })
    .join("\n");
}

describe("环境变量示例契约", () => {
  it("按运行时 dotenv 解析带引号值、行尾注释和 CRLF", () => {
    const source = validExample()
      .replace("S3_ENDPOINT=example", "S3_ENDPOINT=https://s3.example.invalid # endpoint")
      .replace("S3_BUCKET=example", 'S3_BUCKET="runtime-test" # bucket')
      .replace("S3_REGION=example", "S3_REGION=us-east-1 # region")
      .replace(
        "S3_ACCESS_KEY_ID=replace-with-value",
        'S3_ACCESS_KEY_ID="replace-with-access-key" # key',
      )
      .replace(
        "S3_SECRET_ACCESS_KEY=replace-with-value",
        'S3_SECRET_ACCESS_KEY="replace-with-secret-key" # secret',
      )
      .replace("S3_FORCE_PATH_STYLE=false", 'S3_FORCE_PATH_STYLE="false" # boolean')
      .replaceAll("\n", "\r\n");
    expect(validateEnvironmentExample(source)).toEqual([]);
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
      expect(validateEnvironmentExample(validExample().replace(line, `${key}=${value}`))).toContain(
        `环境变量不能为空：${key}`,
      );
    }
  });

  it("S3 字符串拒绝非空的首尾空白", () => {
    const issues = validateEnvironmentExample(
      validExample().replace("S3_BUCKET=example", 'S3_BUCKET=" runtime-test "'),
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
  ])("轨迹对象存储配置 %s 必须声明且不能为空", (key) => {
    const pattern = new RegExp(`^${key}=.*$`, "mu");
    expect(validateEnvironmentExample(validExample().replace(pattern, ""))).toContain(
      `缺少环境变量：${key}`,
    );
    expect(validateEnvironmentExample(validExample().replace(pattern, `${key}=`))).toContain(
      `环境变量不能为空：${key}`,
    );
  });

  it("对象存储路径开关必须是布尔值且不回显非法配置", () => {
    const issues = validateEnvironmentExample(
      validExample().replace(
        "S3_FORCE_PATH_STYLE=false",
        "S3_FORCE_PATH_STYLE=invalid-placeholder",
      ),
    );
    expect(issues).toContain("S3_FORCE_PATH_STYLE 必须为 true 或 false");
    expect(issues.join(" ")).not.toContain("invalid-placeholder");
  });

  it("各受限角色连接与 Bootstrap 指向同一开发数据库", async () => {
    const example = await readFile(new URL("../.env.example", import.meta.url), "utf8");
    const values = new Map(
      example.split(/\r?\n/u).map((line) => {
        const separator = line.indexOf("=");
        return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
      }),
    );
    const bootstrap = new URL(values.get("DATABASE_BOOTSTRAP_URL") ?? "");
    for (const [roleKey, urlKey] of [
      ["DATABASE_RUNTIME_ROLE", "DATABASE_URL"],
      ["DATABASE_RUNTIME_ROLE", "DATABASE_DOCKER_URL"],
      ["DATABASE_MIGRATOR_ROLE", "MIGRATION_DATABASE_URL"],
      ["DATABASE_SKILL_PUBLISHER_ROLE", "SKILL_PUBLISHER_DATABASE_URL"],
      ["DATABASE_WORKER_COORDINATOR_ROLE", "DATABASE_WORKER_COORDINATOR_URL"],
      ["DATABASE_TRAJECTORY_DIRECTORY_ROLE", "DATABASE_TRAJECTORY_DIRECTORY_URL"],
      ["DATABASE_TEAM_COORDINATOR_ROLE", "DATABASE_TEAM_COORDINATOR_URL"],
      ["DATABASE_ADMIN_CONTROL_ROLE", "ADMIN_CONTROL_DATABASE_URL"],
      ["DATABASE_WEBHOOK_DISPATCHER_ROLE", "WEBHOOK_DISPATCHER_DATABASE_URL"],
    ] as const) {
      const url = new URL(values.get(urlKey) ?? "");
      expect(url.protocol, urlKey).toBe(bootstrap.protocol);
      expect(url.port, urlKey).toBe(bootstrap.port);
      expect(url.pathname, urlKey).toBe(bootstrap.pathname);
      expect(url.hostname, urlKey).toBe(
        urlKey === "DATABASE_DOCKER_URL" ? "host.docker.internal" : bootstrap.hostname,
      );
      expect(decodeURIComponent(url.username), urlKey).toBe(values.get(roleKey));
    }
  });

  it("OTLP 样例拒绝带凭据的端点和请求头且不回显配置值", () => {
    const issues = validateEnvironmentExample(
      validExample()
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
    const source = validExample()
      .split("\n")
      .filter((line) => !optionalEnvironmentKeys.some((key) => line.startsWith(`${key}=`)))
      .join("\n");
    expect(validateEnvironmentExample(source)).toEqual([]);
    for (const key of [
      "MODEL_API_KEY",
      "SANDBOX_ENABLED_PROVIDERS",
      "HISTORY_TITLE_MODEL_API_KEY",
      "MEM0_API_KEY",
      "AGENT_WORKER_MAX_CONCURRENT_RUNS",
      "THREAD_CONTEXT_COMPACTION_TIMEOUT_MS",
      "EXTERNAL_TOOL_IDENTITY_ROOT_KEY",
      "EXTERNAL_TOOLS_ALLOW_PRIVATE_ADDRESSES",
    ]) {
      expect(expectedEnvironmentKeys).not.toContain(key);
      expect(optionalEnvironmentKeys).toContain(key);
    }
    expect(expectedEnvironmentKeys).toContain("MODEL_CREDENTIAL_ENCRYPTION_KEY");
    expect(optionalEnvironmentKeys).toEqual(
      expect.arrayContaining([
        "POSTGRES_HOST_PORT",
        "POSTGRES_BOOTSTRAP_USER",
        "POSTGRES_BOOTSTRAP_PASSWORD",
      ]),
    );
  });

  it("根样例身份根只允许占位值，拒绝非占位密钥且不回显", async () => {
    const source = await readFile(new URL("../.env.example", import.meta.url), "utf8");
    const root = "EXTERNAL_TOOL_IDENTITY_ROOT_KEY";
    for (const placeholder of [
      "replace-with-at-least-32-byte-external-tool-identity-root-key",
      "<external-tool-identity-root-key-placeholder>",
    ]) {
      expect(
        validateEnvironmentExample(
          source.replace(/^EXTERNAL_TOOL_IDENTITY_ROOT_KEY=.*$/mu, `${root}=${placeholder}`),
        ),
      ).toEqual([]);
    }
    const secret = "test-only-identity-root-canary-at-least-32-bytes";
    const issues = validateEnvironmentExample(
      source.replace(/^EXTERNAL_TOOL_IDENTITY_ROOT_KEY=.*$/mu, `${root}=${secret}`),
    );
    expect(issues).toEqual([`示例配置疑似包含真实凭据：${root}`]);
    expect(JSON.stringify(issues).includes(secret)).toBe(false);
  });

  it("外部工具私网开关按布尔值而非凭据校验", () => {
    const source = validExample();
    const flag = "EXTERNAL_TOOLS_ALLOW_PRIVATE_ADDRESSES";
    expect(validateEnvironmentExample(source.replace(`${flag}=false`, `${flag}=true`))).toEqual([]);
    expect(validateEnvironmentExample(source.replace(`${flag}=false`, `${flag}=yes`))).toEqual([
      `${flag} 必须为 true 或 false`,
    ]);
  });

  it("AGS 示例凭据必须使用占位值且诊断不回显密钥", () => {
    const secret = "ags-private-canary";
    const issues = validateEnvironmentExample(
      validExample().replace(
        "TENCENT_AGS_API_KEY=replace-with-value",
        `TENCENT_AGS_API_KEY=${secret}`,
      ),
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join(" ")).toContain("TENCENT_AGS_API_KEY");
    expect(issues.join(" ")).not.toContain(secret);
  });

  it("接受完整且只包含占位凭据的示例", () => {
    expect([...expectedEnvironmentKeys, ...optionalEnvironmentKeys]).toEqual(
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
        "CUBESANDBOX_RESOURCE_VOLUME_DRIVER",
        "RESOURCE_FILESYSTEM_SIGNING_KEY",
        "HISTORY_FILESYSTEM_ENABLED",
        "HISTORY_DIRECTORY_TIME_ZONE",
        "HISTORY_TITLE_GENERATION_ENABLED",
        "HISTORY_TITLE_MODEL_BASE_URL",
        "HISTORY_TITLE_MODEL_ID",
        "RESOURCEFS_PROXY_TLS_KEY_PATH",
        "RESOURCEFS_PROXY_TLS_CERT_PATH",
        "MODEL_WIRE_TRACE_ENABLED",
        "MODEL_WIRE_TRACE_RETENTION_DAYS",
        "MODEL_WIRE_TRACE_MAX_BYTES",
        "AGENT_WORKER_MAX_CONCURRENT_RUNS",
        "AGENT_WORKER_USER_MAX_CONCURRENT_RUNS_PER_TENANT",
        "DATABASE_SKILL_PUBLISHER_ROLE",
        "DATABASE_WORKER_COORDINATOR_URL",
        "DATABASE_TRAJECTORY_DIRECTORY_URL",
        "DATABASE_WORKER_COORDINATOR_ROLE",
        "DATABASE_TRAJECTORY_DIRECTORY_ROLE",
        "DATABASE_TEAM_COORDINATOR_URL",
        "DATABASE_TEAM_COORDINATOR_ROLE",
        "DATABASE_ADMIN_CONTROL_ROLE",
        "SKILL_PUBLISHER_DATABASE_URL",
        "ADMIN_CONTROL_DATABASE_URL",
        "DEV_ADMIN_CONTROL_TOKEN",
        "DEMO_PUBLIC_ACCESS_ENABLED",
      ]),
    );
    expect(validateEnvironmentExample(validExample())).toEqual([]);
  });

  it("允许只在公开 Demo 中使用的可选 origin，不强迫本地样例开启该能力", () => {
    expect(optionalEnvironmentKeys).toContain("DEMO_PUBLIC_ORIGIN");
    expect(optionalEnvironmentKeys).toContain("DEMO_ADMIN_USER_ID");
    expect(
      validateEnvironmentExample(
        `${validExample()
          .split("\n")
          .filter(
            (line) =>
              !line.startsWith("DEMO_PUBLIC_ORIGIN=") && !line.startsWith("DEMO_ADMIN_USER_ID="),
          )
          .join(
            "\n",
          )}\nDEMO_PUBLIC_ORIGIN=https://demo.example.invalid\nDEMO_ADMIN_USER_ID=user_demo_admin`,
      ),
    ).toEqual([]);
  });

  it("同时报告缺失项和未登记项", () => {
    const source = validExample()
      .split("\n")
      .filter((line) => !line.startsWith("DATABASE_SCHEMA="))
      .concat("UNKNOWN_KEY=example")
      .join("\n");

    expect(validateEnvironmentExample(source)).toEqual([
      "缺少环境变量：DATABASE_SCHEMA",
      "未登记的环境变量：UNKNOWN_KEY",
    ]);
  });

  it("拒绝疑似真实密钥且错误信息不泄漏配置值", () => {
    const liveLikeValue = "sk-live-like-value-for-test";
    const source = validExample().replace(
      /^MODEL_API_KEY=replace-with-value$/mu,
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
  it("Compose PostgreSQL 仅由本地 profile 启动且缺少密码不会阻断其他服务", async () => {
    const compose = await readFile(new URL("../docker-compose.dev.yml", import.meta.url), "utf8");
    const postgres = compose.split("  minio:", 1)[0];
    expect(postgres).toContain('profiles: ["local-postgres"]');
    expect(postgres).not.toMatch(/\$\{[^}]+:\?[^}]+\}/u);
  });

  it("Compose PostgreSQL bootstrap 凭据与迁移连接保持一致", () => {
    const source = `${validExample().replace(
      "DATABASE_BOOTSTRAP_URL=postgresql://user:replace-me@localhost/db",
      "DATABASE_BOOTSTRAP_URL=postgresql://database_admin:replace-me@localhost/db",
    )}\nPOSTGRES_BOOTSTRAP_USER=database_admin\nPOSTGRES_BOOTSTRAP_PASSWORD=replace-me`;
    expect(validateComposePostgresBootstrap(source)).toEqual([]);
    expect(
      validateComposePostgresBootstrap(
        source.replace(
          "POSTGRES_BOOTSTRAP_PASSWORD=replace-me",
          "POSTGRES_BOOTSTRAP_PASSWORD=other",
        ),
      ),
    ).toEqual(["DATABASE_BOOTSTRAP_URL 与 Compose PostgreSQL bootstrap 用户配置不一致"]);
  });
});

import { parseEnv } from "node:util";

export const expectedEnvironmentKeys = Object.freeze([
  "DATABASE_URL",
  "DATABASE_DOCKER_URL",
  "DATABASE_BOOTSTRAP_URL",
  "MIGRATION_DATABASE_URL",
  "DATABASE_RUNTIME_ROLE",
  "DATABASE_WORKER_COORDINATOR_URL",
  "DATABASE_TRAJECTORY_DIRECTORY_URL",
  "DATABASE_WORKER_COORDINATOR_ROLE",
  "DATABASE_TRAJECTORY_DIRECTORY_ROLE",
  "DATABASE_TEAM_COORDINATOR_URL",
  "DATABASE_TEAM_COORDINATOR_ROLE",
  "DATABASE_MIGRATOR_ROLE",
  "DATABASE_SKILL_PUBLISHER_ROLE",
  "DATABASE_ADMIN_CONTROL_ROLE",
  "DATABASE_WEBHOOK_DISPATCHER_ROLE",
  "WEBHOOK_DISPATCHER_DATABASE_URL",
  "DATABASE_SCHEMA",
  "RUNTIME_ENV",
  "PROCESS_SHUTDOWN_TIMEOUT_MS",
  "THREAD_CURSOR_ACTIVE_KID",
  "THREAD_CURSOR_SIGNING_KEYS",
  "THREAD_SERIAL_QUEUE_V2_ENABLED",
  "THREAD_CONTEXT_V2_WRITE_ENABLED",
  "THREAD_CONTEXT_V2_SHADOW_READ_ENABLED",
  "THREAD_CONTEXT_V2_READ_ENABLED",
  "THREAD_INPUT_ROUTING_V2_ENABLED",
  "THREAD_CONTEXT_INLINE_BODY_MAX_BYTES",
  "THREAD_CONTEXT_COMPACTION_ENABLED",
  "THREAD_CONTEXT_COMPACTION_PATH",
  "THREAD_SANDBOX_SESSION_REUSE_ENABLED",
  "SUBAGENTS_ENABLED",
  "THREAD_SANDBOX_RETENTION_SCHEDULER_ENABLED",
  "THREAD_SANDBOX_PAUSED_RETENTION_SECONDS",
  "THREAD_SANDBOX_LIFECYCLE_TIMEOUT_MS",
  "API_LISTEN_HOST",
  "API_LISTEN_PORT",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "RESOURCEFS_PROXY_ENABLED",
  "RESOURCEFS_PROXY_LISTEN_HOST",
  "RESOURCEFS_PROXY_LISTEN_PORT",
  "RESOURCEFS_PROXY_TLS_KEY_PATH",
  "RESOURCEFS_PROXY_TLS_CERT_PATH",
  "MINIO_ROOT_USER",
  "MINIO_ROOT_PASSWORD",
  "MINIO_HOST_PORT",
  "MINIO_CONSOLE_HOST_PORT",
  "S3_ENDPOINT",
  "S3_DOCKER_ENDPOINT",
  "S3_PUBLIC_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_FORCE_PATH_STYLE",
  "SKILL_PUBLISHER_DATABASE_URL",
  "ADMIN_CONTROL_DATABASE_URL",
  "SKILL_PUBLISHER_S3_ENDPOINT",
  "SKILL_PUBLISHER_S3_BUCKET",
  "SKILL_PUBLISHER_S3_REGION",
  "SKILL_PUBLISHER_S3_ACCESS_KEY_ID",
  "SKILL_PUBLISHER_S3_SECRET_ACCESS_KEY",
  "SKILL_PUBLISHER_S3_FORCE_PATH_STYLE",
  "ADMIN_CONTROL_LISTEN_HOST",
  "ADMIN_CONTROL_LISTEN_PORT",
  "EVALUATION_POLL_MS",
  "EVALUATION_GLOBAL_CONCURRENCY",
  "DEV_ADMIN_CONTROL_USER_ID",
  "DEV_ADMIN_CONTROL_TOKEN",
  "RESOURCE_FILESYSTEM_SIGNING_KEY",
  "HISTORY_FILESYSTEM_ENABLED",
  "HISTORY_DIRECTORY_TIME_ZONE",
  "SCHEDULER_TENANT_ID",
  "SCHEDULER_WORKER_ID",
  "CLEANUP_POLL_INTERVAL_MS",
  "CLEANUP_LEASE_MS",
  "AGENT_WORKER_TENANT_ID",
  "AGENT_WORKER_ID",
  "AGENT_WORKER_POLL_INTERVAL_MS",
  "AGENT_WORKER_DISPATCH_LEASE_MS",
  "AGENT_WORKER_RUN_LEASE_MS",
  "AGENT_WORKER_RUN_TIMEOUT_MS",
  "MODEL_CREDENTIAL_ENCRYPTION_KEY",
  "WEBHOOK_SECRET_ENCRYPTION_KEY",
  "MODEL_WIRE_TRACE_ENABLED",
  "MODEL_WIRE_TRACE_RETENTION_DAYS",
  "MODEL_WIRE_TRACE_MAX_BYTES",
  "RUN_TRAJECTORY_RETENTION_DAYS",
  "DEMO_PUBLIC_ACCESS_ENABLED",
  "DEV_AUTH_ENABLED",
  "DEV_AUTH_USER_A_ID",
  "DEV_AUTH_USER_A_TENANT_ID",
  "DEV_AUTH_USER_B_ID",
  "DEV_AUTH_USER_B_TENANT_ID",
]);

export const optionalEnvironmentKeys = Object.freeze([
  "HOOX_URL",
  "HOOX_TOKEN",
  "OTEL_EXPORT_ENABLED",
  "OTEL_EXPORT_ENDPOINT",
  "OTEL_EXPORT_HEADERS",
  "OTEL_EXPORT_SAMPLE_RATE",
  "OTEL_EXPORT_CONTENT_ENABLED",
  "POSTGRES_HOST_PORT",
  "POSTGRES_BOOTSTRAP_USER",
  "POSTGRES_BOOTSTRAP_PASSWORD",
  "THREAD_CONTEXT_COMPACTION_SOFT_LIMIT_PERCENT",
  "THREAD_CONTEXT_COMPACTION_TARGET_PERCENT",
  "THREAD_CONTEXT_COMPACTION_RECENT_USER_TOKENS",
  "THREAD_CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS",
  "THREAD_CONTEXT_COMPACTION_TIMEOUT_MS",
  "CUBESANDBOX_SESSION_TTL_SECONDS",
  "SANDBOX_DEFAULT_PROVIDER",
  "SANDBOX_ENABLED_PROVIDERS",
  "CUBESANDBOX_API_URL",
  "CUBESANDBOX_WEB_URL",
  "CUBESANDBOX_TEMPLATE_ID",
  "CUBESANDBOX_API_KEY",
  "CUBESANDBOX_PROXY_NODE_IP",
  "CUBESANDBOX_PROXY_PORT",
  "CUBESANDBOX_PROXY_SCHEME",
  "CUBESANDBOX_RESOURCE_VOLUME_DRIVER",
  "E2B_API_KEY",
  "E2B_DOMAIN",
  "E2B_TEMPLATE_ID",
  "E2B_SESSION_TTL_SECONDS",
  "TENCENT_AGS_API_KEY",
  "TENCENT_AGS_DOMAIN",
  "TENCENT_AGS_TEMPLATE_ID",
  "TENCENT_AGS_SESSION_TTL_SECONDS",
  "HISTORY_TITLE_GENERATION_ENABLED",
  "HISTORY_TITLE_MODEL_BASE_URL",
  "HISTORY_TITLE_MODEL_API_KEY",
  "HISTORY_TITLE_MODEL_ID",
  "HISTORY_TITLE_MODEL_TIMEOUT_MS",
  "HISTORY_TITLE_INPUT_MAX_BYTES",
  "HISTORY_TITLE_MAX_OUTPUT_TOKENS",
  "HISTORY_TITLE_MAX_ATTEMPTS",
  "HISTORY_TITLE_RETRY_BASE_MS",
  "HISTORY_TITLE_POLL_INTERVAL_MS",
  "HISTORY_TITLE_CLAIM_LEASE_MS",
  "MEM0_MEMORY_ENABLED",
  "MEM0_API_BASE_URL",
  "MEM0_API_KEY",
  "MEM0_SCOPE_HMAC_KEY",
  "MEM0_REQUEST_TIMEOUT_MS",
  "AGENT_WORKER_MAX_CONCURRENT_RUNS",
  "AGENT_WORKER_USER_MAX_CONCURRENT_RUNS_PER_TENANT",
  "MODEL_BASE_URL",
  "MODEL_API_KEY",
  "MODEL_ID",
  "MODEL_SUPPORTS_IMAGES",
  "MODEL_CONTEXT_WINDOW",
  "MODEL_MAX_OUTPUT_TOKENS",

  "DEMO_PUBLIC_ORIGIN",
  "DEMO_ADMIN_USER_ID",
  "INSTALLATION_SETUP_TOKEN",
  "ADMIN_CONTROL_IDENTITY_API_URL",
  "EXTERNAL_TOOLS_ALLOW_PRIVATE_ADDRESSES",
  "EXTERNAL_TOOL_IDENTITY_ROOT_KEY",
]);

const placeholderOnlyKeys = new Set([
  "HOOX_TOKEN",
  "POSTGRES_BOOTSTRAP_PASSWORD",
  "DATABASE_URL",
  "DATABASE_WORKER_COORDINATOR_URL",
  "DATABASE_TRAJECTORY_DIRECTORY_URL",
  "DATABASE_TEAM_COORDINATOR_URL",
  "WEBHOOK_DISPATCHER_DATABASE_URL",
  "DATABASE_DOCKER_URL",
  "DATABASE_BOOTSTRAP_URL",
  "MIGRATION_DATABASE_URL",
  "HISTORY_TITLE_MODEL_BASE_URL",
  "HISTORY_TITLE_MODEL_API_KEY",
  "HISTORY_TITLE_MODEL_ID",
  "MEM0_API_KEY",
  "MEM0_SCOPE_HMAC_KEY",
  "SKILL_PUBLISHER_DATABASE_URL",
  "ADMIN_CONTROL_DATABASE_URL",
  "MINIO_ROOT_USER",
  "MINIO_ROOT_PASSWORD",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "SKILL_PUBLISHER_S3_ACCESS_KEY_ID",
  "SKILL_PUBLISHER_S3_SECRET_ACCESS_KEY",
  "CUBESANDBOX_TEMPLATE_ID",
  "CUBESANDBOX_API_KEY",
  "TENCENT_AGS_API_KEY",
  "TENCENT_AGS_TEMPLATE_ID",
  "MODEL_BASE_URL",
  "MODEL_API_KEY",
  "MODEL_CREDENTIAL_ENCRYPTION_KEY",
  "EXTERNAL_TOOL_IDENTITY_ROOT_KEY",
  "WEBHOOK_SECRET_ENCRYPTION_KEY",
  "MODEL_ID",
  "THREAD_CURSOR_SIGNING_KEYS",
  "RESOURCE_FILESYSTEM_SIGNING_KEY",
  "RESOURCEFS_PROXY_TLS_KEY_PATH",
  "RESOURCEFS_PROXY_TLS_CERT_PATH",
  "DEV_ADMIN_CONTROL_TOKEN",
  "INSTALLATION_SETUP_TOKEN",
]);
const nullablePlaceholderKeys = new Set([
  "HOOX_TOKEN",
  "CUBESANDBOX_API_KEY",
  "E2B_DOMAIN",
  "MODEL_BASE_URL",
  "MODEL_API_KEY",
  "MODEL_ID",
  "DEV_ADMIN_CONTROL_TOKEN",
]);

function looksLikePlaceholder(key, value) {
  if (
    key === "DATABASE_URL" ||
    key === "DATABASE_WORKER_COORDINATOR_URL" ||
    key === "DATABASE_TRAJECTORY_DIRECTORY_URL" ||
    key === "DATABASE_TEAM_COORDINATOR_URL" ||
    key === "WEBHOOK_DISPATCHER_DATABASE_URL" ||
    key === "DATABASE_DOCKER_URL" ||
    key === "DATABASE_BOOTSTRAP_URL" ||
    key === "MIGRATION_DATABASE_URL" ||
    key === "SKILL_PUBLISHER_DATABASE_URL" ||
    key === "ADMIN_CONTROL_DATABASE_URL"
  ) {
    try {
      return new URL(value).password.startsWith("replace-");
    } catch {
      return false;
    }
  }

  if (key === "MODEL_BASE_URL" || key === "HISTORY_TITLE_MODEL_BASE_URL") {
    try {
      return new URL(value).hostname.endsWith(".invalid");
    } catch {
      return false;
    }
  }

  return value.startsWith("replace-") || /^<[^>]+>$/.test(value);
}

/**
 * 只返回变量名级别的错误，绝不把配置值拼入异常或日志。
 */
export function validateEnvironmentExample(source) {
  const values = new Map(Object.entries(parseEnv(source)));
  const issues = [];
  const seen = new Set();

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const match = /^([A-Z][A-Z0-9_]*)\s*=/u.exec(line);
    if (!match) {
      issues.push("存在无法解析的配置行");
      continue;
    }

    const [, key] = match;
    if (seen.has(key)) {
      issues.push(`环境变量重复：${key}`);
    }
    seen.add(key);
  }

  const expected = new Set([...expectedEnvironmentKeys, ...optionalEnvironmentKeys]);
  for (const key of expectedEnvironmentKeys) {
    if (!values.has(key)) issues.push(`缺少环境变量：${key}`);
  }
  for (const key of values.keys()) {
    if (!expected.has(key)) issues.push(`未登记的环境变量：${key}`);
  }
  issues.push(...validateOtelEnvironmentExample(values));
  issues.push(...validateS3EnvironmentExample(values));
  issues.push(...validateExternalToolsPrivateAddressesExample(values));
  for (const key of placeholderOnlyKeys) {
    const value = values.get(key);
    if (
      value !== undefined &&
      !(nullablePlaceholderKeys.has(key) && value === "") &&
      !looksLikePlaceholder(key, value)
    ) {
      issues.push(`示例配置疑似包含真实凭据：${key}`);
    }
  }

  return issues;
}

export function validateS3EnvironmentExample(values) {
  const issues = [];
  for (const key of [
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_REGION",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_FORCE_PATH_STYLE",
  ]) {
    const value = values.get(key);
    if (value !== undefined && value.trim() === "") {
      issues.push(`环境变量不能为空：${key}`);
    } else if (value !== undefined && value.trim() !== value) {
      issues.push(`环境变量不能包含首尾空白：${key}`);
    }
  }
  const forcePathStyle = values.get("S3_FORCE_PATH_STYLE");
  if (forcePathStyle !== undefined && forcePathStyle !== "true" && forcePathStyle !== "false") {
    issues.push("S3_FORCE_PATH_STYLE 必须为 true 或 false");
  }
  return issues;
}

export function validateExternalToolsPrivateAddressesExample(values) {
  const value = values.get("EXTERNAL_TOOLS_ALLOW_PRIVATE_ADDRESSES");
  return value === undefined || value === "false" || value === "true"
    ? []
    : ["EXTERNAL_TOOLS_ALLOW_PRIVATE_ADDRESSES 必须为 true 或 false"];
}

export function validateOtelEnvironmentExample(values) {
  const issues = [];
  for (const key of ["OTEL_EXPORT_ENABLED", "OTEL_EXPORT_CONTENT_ENABLED"]) {
    if (values.has(key) && values.get(key) !== "false") issues.push(`样例 ${key} 必须为 false`);
  }
  if (values.has("OTEL_EXPORT_HEADERS") && values.get("OTEL_EXPORT_HEADERS") !== "") {
    issues.push("样例 OTEL_EXPORT_HEADERS 必须留空");
  }
  const otelEndpoint = values.get("OTEL_EXPORT_ENDPOINT");
  if (otelEndpoint !== undefined && otelEndpoint !== "") {
    try {
      const endpoint = new URL(otelEndpoint);
      if (
        endpoint.protocol !== "https:" ||
        !endpoint.hostname.endsWith(".invalid") ||
        endpoint.username ||
        endpoint.password ||
        /[?#]/u.test(otelEndpoint)
      )
        throw new Error();
    } catch {
      issues.push("样例 OTEL_EXPORT_ENDPOINT 必须使用无凭据的 HTTPS 占位地址");
    }
  }
  const otelSampleRate = values.get("OTEL_EXPORT_SAMPLE_RATE");
  if (otelSampleRate !== undefined && !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u.test(otelSampleRate)) {
    issues.push("样例 OTEL_EXPORT_SAMPLE_RATE 必须在 0 与 1 之间");
  }
  return issues;
}

export const expectedProductionEnvironmentKeys = Object.freeze([
  "RUNTIME_ENV",
  "DATABASE_URL",
  "DATABASE_RUNTIME_ROLE",
  "DATABASE_SCHEMA",
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
  "API_LISTEN_HOST",
  "API_LISTEN_PORT",
  "API_PUBLIC_ORIGIN",
  "API_TLS_MODE",
  "API_TRUSTED_PROXY_CIDRS",
  "API_JWT_ISSUER",
  "API_JWT_AUDIENCE",
  "API_JWT_SIGNING_KEYS",
  "API_JWT_CLOCK_SKEW_SECONDS",
  "API_JWT_MAX_LIFETIME_SECONDS",
  "S3_ENDPOINT",
  "S3_PUBLIC_ENDPOINT",
  "S3_BUCKET",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_FORCE_PATH_STYLE",
  "CUBESANDBOX_API_URL",
  "CUBESANDBOX_TEMPLATE_ID",
  "CUBESANDBOX_API_KEY",
  "CUBESANDBOX_PROXY_NODE_IP",
  "CUBESANDBOX_PROXY_PORT",
  "CUBESANDBOX_PROXY_SCHEME",
  "RESOURCE_FILESYSTEM_ENDPOINT",
  "RESOURCE_FILESYSTEM_SIGNING_KEY",
  "SCHEDULER_TENANT_ID",
  "SCHEDULER_WORKER_ID",
  "CLEANUP_POLL_INTERVAL_MS",
  "CLEANUP_LEASE_MS",
  "AGENT_WORKER_TENANT_ID",
  "AGENT_WORKER_ID",
  "AGENT_WORKER_POLL_INTERVAL_MS",
  "AGENT_WORKER_DISPATCH_LEASE_MS",
  "AGENT_WORKER_RUN_LEASE_MS",
  "MODEL_BASE_URL",
  "MODEL_API_KEY",
  "MODEL_ID",
  "MODEL_CONTEXT_WINDOW",
  "MODEL_MAX_OUTPUT_TOKENS",
  "MODEL_WIRE_TRACE_ENABLED",
  "MODEL_WIRE_TRACE_RETENTION_DAYS",
  "MODEL_WIRE_TRACE_MAX_BYTES",
]);

const secretKeys = new Set([
  "DATABASE_URL",
  "THREAD_CURSOR_SIGNING_KEYS",
  "API_JWT_SIGNING_KEYS",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "CUBESANDBOX_TEMPLATE_ID",
  "CUBESANDBOX_API_KEY",
  "MODEL_API_KEY",
  "MODEL_ID",
  "RESOURCE_FILESYSTEM_SIGNING_KEY",
]);

function parseLines(source) {
  const values = new Map();
  const issues = [];
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) {
      issues.push("存在无法解析的生产配置行");
      continue;
    }
    const [, key, value] = match;
    if (values.has(key)) {
      issues.push(`环境变量重复：${key}`);
      continue;
    }
    values.set(key, value);
  }
  return { values, issues };
}

function obviousPlaceholder(key, value) {
  if (key === "DATABASE_URL") {
    try {
      return new URL(value).password === "replace-me";
    } catch {
      return false;
    }
  }
  return value.startsWith("replace-") || /^<[^>]+>$/u.test(value);
}

/** 仅校验可提交的部署样例；错误只暴露变量名，绝不回显值。 */
export function validateProductionEnvironmentExample(source) {
  const { values, issues } = parseLines(source);
  const expected = new Set(expectedProductionEnvironmentKeys);
  for (const key of expectedProductionEnvironmentKeys) {
    if (!values.has(key)) issues.push(`缺少环境变量：${key}`);
  }
  for (const key of values.keys()) {
    if (!expected.has(key)) issues.push(`未登记的生产环境变量：${key}`);
    if (key.startsWith("DEV_AUTH_")) issues.push(`生产配置禁止开发身份变量：${key}`);
  }
  if (values.get("RUNTIME_ENV") !== "production") issues.push("RUNTIME_ENV 必须为 production");
  if (values.get("API_TLS_MODE") !== "proxy") {
    issues.push("生产样例 API_TLS_MODE 必须为 proxy");
  }
  if (values.get("MODEL_WIRE_TRACE_ENABLED") !== "false") {
    issues.push("生产样例 MODEL_WIRE_TRACE_ENABLED 必须为 false");
  }
  if (values.get("THREAD_SERIAL_QUEUE_V2_ENABLED") !== "true") {
    issues.push("生产样例 THREAD_SERIAL_QUEUE_V2_ENABLED 必须为 true");
  }
  for (const key of [
    "THREAD_CONTEXT_V2_WRITE_ENABLED",
    "THREAD_CONTEXT_V2_SHADOW_READ_ENABLED",
    "THREAD_CONTEXT_V2_READ_ENABLED",
    "THREAD_INPUT_ROUTING_V2_ENABLED",
    "THREAD_CONTEXT_COMPACTION_ENABLED",
    "THREAD_SANDBOX_SESSION_REUSE_ENABLED",
    "THREAD_SANDBOX_RETENTION_SCHEDULER_ENABLED",
  ]) {
    if (values.get(key) !== "true") issues.push(`生产样例 ${key} 必须为 true`);
  }
  for (const key of secretKeys) {
    const value = values.get(key);
    if (value !== undefined && !obviousPlaceholder(key, value)) {
      issues.push(`示例配置疑似包含真实凭据：${key}`);
    }
  }
  for (const key of [
    "API_JWT_ISSUER",
    "API_PUBLIC_ORIGIN",
    "S3_ENDPOINT",
    "S3_PUBLIC_ENDPOINT",
    "CUBESANDBOX_API_URL",
    "MODEL_BASE_URL",
  ]) {
    const value = values.get(key);
    try {
      const url = value === undefined ? undefined : new URL(value);
      if (
        url === undefined ||
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== ""
      ) {
        issues.push(`生产样例必须使用无凭据 HTTPS：${key}`);
      }
    } catch {
      issues.push(`生产样例 URL 无效：${key}`);
    }
  }
  if (values.get("CUBESANDBOX_PROXY_SCHEME") !== "https") {
    issues.push("CUBESANDBOX_PROXY_SCHEME 必须为 https");
  }
  try {
    const apiOrigin = new URL(values.get("API_PUBLIC_ORIGIN") ?? "");
    const objectOrigin = new URL(values.get("S3_PUBLIC_ENDPOINT") ?? "");
    if (
      apiOrigin.pathname !== "/" ||
      apiOrigin.search !== "" ||
      apiOrigin.hash !== "" ||
      objectOrigin.pathname !== "/" ||
      objectOrigin.search !== "" ||
      objectOrigin.hash !== ""
    ) {
      issues.push("API_PUBLIC_ORIGIN 与 S3_PUBLIC_ENDPOINT 必须为 origin");
    }
    if (apiOrigin.origin === objectOrigin.origin) {
      issues.push("S3_PUBLIC_ENDPOINT 必须使用独立对象 origin");
    }
  } catch {
    // 上面的 URL 校验已提供稳定变量名错误。
  }
  return issues;
}

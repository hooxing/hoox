export const expectedEnvironmentKeys = Object.freeze([
  "DATABASE_URL",
  "DATABASE_DOCKER_URL",
  "DATABASE_BOOTSTRAP_URL",
  "MIGRATION_DATABASE_URL",
  "DATABASE_RUNTIME_ROLE",
  "DATABASE_MIGRATOR_ROLE",
  "DATABASE_SCHEMA",
  "RUNTIME_ENV",
  "PROCESS_SHUTDOWN_TIMEOUT_MS",
  "THREAD_CURSOR_ACTIVE_KID",
  "THREAD_CURSOR_SIGNING_KEYS",
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
  "CUBESANDBOX_API_URL",
  "CUBESANDBOX_WEB_URL",
  "CUBESANDBOX_TEMPLATE_ID",
  "CUBESANDBOX_API_KEY",
  "CUBESANDBOX_PROXY_NODE_IP",
  "CUBESANDBOX_PROXY_PORT",
  "CUBESANDBOX_PROXY_SCHEME",
  "SCHEDULER_TENANT_ID",
  "SCHEDULER_WORKER_ID",
  "CLEANUP_POLL_INTERVAL_MS",
  "CLEANUP_LEASE_MS",
  "MODEL_BASE_URL",
  "MODEL_API_KEY",
  "MODEL_ID",
  "DEV_AUTH_ENABLED",
  "DEV_AUTH_USER_A_ID",
  "DEV_AUTH_USER_A_TENANT_ID",
  "DEV_AUTH_USER_B_ID",
  "DEV_AUTH_USER_B_TENANT_ID",
]);

const placeholderOnlyKeys = new Set([
  "DATABASE_URL",
  "DATABASE_DOCKER_URL",
  "DATABASE_BOOTSTRAP_URL",
  "MIGRATION_DATABASE_URL",
  "MINIO_ROOT_USER",
  "MINIO_ROOT_PASSWORD",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "CUBESANDBOX_TEMPLATE_ID",
  "MODEL_BASE_URL",
  "MODEL_API_KEY",
  "MODEL_ID",
  "THREAD_CURSOR_SIGNING_KEYS",
]);

function looksLikePlaceholder(key, value) {
  if (
    key === "DATABASE_URL" ||
    key === "DATABASE_DOCKER_URL" ||
    key === "DATABASE_BOOTSTRAP_URL" ||
    key === "MIGRATION_DATABASE_URL"
  ) {
    try {
      return new URL(value).password === "replace-me";
    } catch {
      return false;
    }
  }

  if (key === "MODEL_BASE_URL") {
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
  const values = new Map();
  const issues = [];

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) {
      issues.push("存在无法解析的配置行");
      continue;
    }

    const [, key, value] = match;
    if (values.has(key)) {
      issues.push(`环境变量重复：${key}`);
      continue;
    }
    values.set(key, value);
  }

  const expected = new Set(expectedEnvironmentKeys);
  for (const key of expectedEnvironmentKeys) {
    if (!values.has(key)) issues.push(`缺少环境变量：${key}`);
  }
  for (const key of values.keys()) {
    if (!expected.has(key)) issues.push(`未登记的环境变量：${key}`);
  }
  for (const key of placeholderOnlyKeys) {
    const value = values.get(key);
    if (value !== undefined && !looksLikePlaceholder(key, value)) {
      issues.push(`示例配置疑似包含真实凭据：${key}`);
    }
  }

  return issues;
}

import type { DatabaseRoleCredential } from "./database-role-bootstrap.js";

const rolePattern = /^[a-z_][a-z0-9_]{0,62}$/u;

interface RoleEnvironmentBinding {
  readonly roleKey: string;
  readonly urlKey: string;
}

const roleBindings: readonly RoleEnvironmentBinding[] = [
  { roleKey: "DATABASE_RUNTIME_ROLE", urlKey: "DATABASE_URL" },
  { roleKey: "DATABASE_MIGRATOR_ROLE", urlKey: "MIGRATION_DATABASE_URL" },
  { roleKey: "DATABASE_SKILL_PUBLISHER_ROLE", urlKey: "SKILL_PUBLISHER_DATABASE_URL" },
  {
    roleKey: "DATABASE_WORKER_COORDINATOR_ROLE",
    urlKey: "DATABASE_WORKER_COORDINATOR_URL",
  },
  { roleKey: "DATABASE_TEAM_COORDINATOR_ROLE", urlKey: "DATABASE_TEAM_COORDINATOR_URL" },
  { roleKey: "DATABASE_TRAJECTORY_DIRECTORY_ROLE", urlKey: "DATABASE_TRAJECTORY_DIRECTORY_URL" },
  { roleKey: "DATABASE_ADMIN_CONTROL_ROLE", urlKey: "ADMIN_CONTROL_DATABASE_URL" },
  { roleKey: "DATABASE_WEBHOOK_DISPATCHER_ROLE", urlKey: "WEBHOOK_DISPATCHER_DATABASE_URL" },
];

export interface DatabaseRoleBootstrapConfiguration {
  readonly bootstrapUrl: string;
  readonly credentials: readonly DatabaseRoleCredential[];
}

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key];
  if (value === undefined || value.length === 0) throw new TypeError(`缺少 ${key}`);
  return value;
}

function parseUrl(environment: NodeJS.ProcessEnv, key: string): URL {
  const value = required(environment, key);
  try {
    return new URL(value);
  } catch {
    throw new TypeError(`${key} 格式无效`);
  }
}

function normalizedDatabaseEndpoint(url: URL): string {
  const port =
    url.port || (url.protocol === "postgresql:" || url.protocol === "postgres:" ? "5432" : "");
  return `${url.protocol}//${url.hostname.toLowerCase()}:${port}${url.pathname}`;
}

function decodedUrlPart(value: string, key: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new TypeError(`${key} 格式无效`);
  }
}

export function readDatabaseRoleBootstrapConfiguration(
  environment: NodeJS.ProcessEnv,
): DatabaseRoleBootstrapConfiguration {
  if (environment.RUNTIME_ENV === "production") {
    throw new TypeError("生产环境禁止使用本地数据库角色 bootstrap 命令");
  }
  const bootstrapUrl = parseUrl(environment, "DATABASE_BOOTSTRAP_URL");
  const endpoint = normalizedDatabaseEndpoint(bootstrapUrl);
  const credentials = roleBindings.map(({ roleKey, urlKey }) => {
    const role = required(environment, roleKey);
    if (!rolePattern.test(role)) throw new TypeError(`${roleKey} 格式无效`);
    const url = parseUrl(environment, urlKey);
    if (normalizedDatabaseEndpoint(url) !== endpoint) {
      throw new TypeError(`${urlKey} 必须与 DATABASE_BOOTSTRAP_URL 指向同一个数据库`);
    }
    if (decodedUrlPart(url.username, urlKey) !== role) {
      throw new TypeError(`${urlKey} 用户名必须与 ${roleKey} 一致`);
    }
    const password = decodedUrlPart(url.password, urlKey);
    if (password.length === 0) throw new TypeError(`${urlKey} 必须包含数据库角色密码`);
    return { role, password };
  });
  if (new Set(credentials.map(({ role }) => role)).size !== credentials.length) {
    throw new TypeError("数据库应用角色必须互不相同");
  }
  return { bootstrapUrl: bootstrapUrl.toString(), credentials };
}

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const deployScript = fileURLToPath(new URL("../../deploy/demo/remote-deploy.sh", import.meta.url));
const mockScript = fileURLToPath(new URL("./fixtures/demo-deploy-mocks.sh", import.meta.url));

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const webhookKey = "webhook-root-placeholder-at-least-32-bytes";
const webhookFiles = {
  infra:
    "DATABASE_WEBHOOK_DISPATCHER_ROLE=hoox_demo_webhook_dispatcher\nDATABASE_WEBHOOK_DISPATCHER_PASSWORD=placeholder-password\nDATABASE_TRAJECTORY_DIRECTORY_ROLE=trajectory_directory\nDATABASE_TRAJECTORY_DIRECTORY_PASSWORD=directory-placeholder\n",
  migration:
    "DATABASE_WEBHOOK_DISPATCHER_ROLE=hoox_demo_webhook_dispatcher\nDATABASE_TRAJECTORY_DIRECTORY_ROLE=trajectory_directory\n",
  api: `WEBHOOK_SECRET_ENCRYPTION_KEY=${webhookKey}\n`,
  scheduler: [
    `WEBHOOK_SECRET_ENCRYPTION_KEY=${webhookKey}`,
    "DATABASE_WEBHOOK_DISPATCHER_ROLE=hoox_demo_webhook_dispatcher",
    "WEBHOOK_DISPATCHER_DATABASE_URL=postgresql://hoox_demo_webhook_dispatcher:placeholder-password@127.0.0.1:15432/test_db",
    "DATABASE_TRAJECTORY_DIRECTORY_ROLE=trajectory_directory",
    "DATABASE_TRAJECTORY_DIRECTORY_URL=postgresql://trajectory_directory:directory-placeholder@127.0.0.1:15432/test_db",
    "",
  ].join("\n"),
};

function deploy(
  mode: string,
  prepare?: (root: string) => void,
  overrides: Readonly<Record<string, string>> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "hoox-demo-deploy-test-"));
  temporaryRoots.push(root);
  for (const directory of ["releases/candidate", "releases/previous", "shared", "tmp"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  const schedulerPackage = join(root, "runtime-ts/apps/scheduler");
  mkdirSync(join(schedulerPackage, "node_modules/pg"), { recursive: true });
  writeFileSync(join(schedulerPackage, "package.json"), "{}");
  writeFileSync(
    join(schedulerPackage, "node_modules/pg/index.js"),
    `const { appendFileSync } = require("node:fs");
exports.Client = class {
  constructor(options) {
    this.options = options;
  }
  async connect() {
    appendFileSync(process.env.MOCK_LOG, "dispatcher connect\\n");
    if (![process.env.WEBHOOK_DISPATCHER_DATABASE_URL,process.env.DATABASE_TRAJECTORY_DIRECTORY_URL].includes(this.options.connectionString) ||
        !this.options.connectionString || !this.options.connectionTimeoutMillis) {
      throw new Error("探针必须使用 Scheduler DSN 和有限连接超时");
    }
    if (process.env.MOCK_MODE === "dispatcher-auth-failure" || (process.env.MOCK_MODE === "directory-auth-failure" && this.options.connectionString === process.env.DATABASE_TRAJECTORY_DIRECTORY_URL)) {
      throw new Error(this.options.connectionString);
    }
  }
  async query(sql) {
    appendFileSync(process.env.MOCK_LOG, "dispatcher query " + sql + "\\n");
    if (sql !== "SELECT 1" || !this.options.query_timeout ||
        process.env.MOCK_MODE === "dispatcher-query-failure") {
      throw new Error(this.options.connectionString);
    }
  }
  async end() {
    appendFileSync(process.env.MOCK_LOG, "dispatcher end\\n");
  }
};\n`,
  );
  for (const file of ["docker-compose.yml", "postgres-init.sh", "nginx.conf.template"]) {
    writeFileSync(join(root, "releases/candidate", file), "");
    writeFileSync(join(root, "releases/previous", file), "");
  }
  symlinkSync(
    join(root, "releases/previous"),
    join(root, "current"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const files: Record<string, string> = {
    "infra.env": `POSTGRES_USER=test_user\nPOSTGRES_DB=test_db\nDATABASE_SCHEMA=test_schema\n${webhookFiles.infra}`,
    "migration.env": webhookFiles.migration,
    "api.env": webhookFiles.api,
    "admin-control.env":
      "DEV_ADMIN_CONTROL_TOKEN=test-placeholder-token-with-at-least-32-characters\n",
    "scheduler.env": webhookFiles.scheduler,
    "worker.env": "",
    "demo-account.env": "DEMO_ACCOUNT_EMAIL=demo@example.invalid\n",
    "compose.env": "HOOX_DEMO_IMAGE=test/previous@sha256:previous\n",
    ...overrides,
  };
  for (const [file, value] of Object.entries(files)) {
    if (mode !== "missing-config" || file !== "api.env") {
      writeFileSync(join(root, "shared", file), value);
    }
  }
  prepare?.(root);
  const log = join(root, "commands.log");
  const result = spawnSync(bash, [mockScript], {
    env: {
      ...process.env,
      FIXTURE_ROOT: root,
      DEPLOY_SCRIPT: deployScript,
      RELEASE_ID: "candidate",
      HOOX_DEMO_IMAGE: "test/candidate@sha256:candidate",
      MOCK_MODE: mode,
      MOCK_LOG: log,
    },
    encoding: "utf8",
    timeout: mode === "worker-never-started" ? 60_000 : 15_000,
  });
  if (result.error) throw result.error;
  return {
    ...result,
    root,
    log: existsSync(log) ? readFileSync(log, "utf8") : "",
    composeEnv: readFileSync(join(root, "shared/compose.env"), "utf8"),
  };
}

// Git Bash 的 60 轮启动探测在并发负载下较慢；不启动场景受 60 秒硬超时约束，其余场景为 15 秒。
describe("Demo 远端发布失败恢复", { timeout: 70_000 }, () => {
  it("共享配置缺失时不启动或回滚应用，也不改发布配置", () => {
    const result = deploy("missing-config");
    expect(result.status, result.stderr).toBe(2);
    expect(result.log).toBe("");
    expect(result.composeEnv).toBe("HOOX_DEMO_IMAGE=test/previous@sha256:previous\n");
  });

  it.each([
    ["infra.env", "POSTGRES_DB=test_db\n", "infra.env"],
    ["migration.env", "", "migration.env"],
    [
      "scheduler.env",
      webhookFiles.scheduler.replace(/^DATABASE_TRAJECTORY_DIRECTORY_URL=.*$/mu, ""),
      "scheduler.env",
    ],
    [
      "scheduler.env",
      `${webhookFiles.scheduler}DATABASE_WORKER_COORDINATOR_URL=forbidden\n`,
      "scheduler.env",
    ],
    ["migration.env", "DATABASE_WEBHOOK_DISPATCHER_ROLE=other_role\n", "migration.env"],
    [
      "scheduler.env",
      webhookFiles.scheduler.replace(
        "DATABASE_WEBHOOK_DISPATCHER_ROLE=hoox_demo_webhook_dispatcher",
        "DATABASE_WEBHOOK_DISPATCHER_ROLE=other_role",
      ),
      "scheduler.env",
    ],
    [
      "scheduler.env",
      webhookFiles.scheduler.replace(/^WEBHOOK_DISPATCHER_DATABASE_URL=.*$/mu, ""),
      "scheduler.env",
    ],
    [
      "scheduler.env",
      webhookFiles.scheduler.replace(
        "postgresql://hoox_demo_webhook_dispatcher:",
        "postgresql://other_role:",
      ),
      "scheduler.env",
    ],
    [
      "scheduler.env",
      webhookFiles.scheduler.replace("127.0.0.1:15432", "other.example.invalid"),
      "scheduler.env",
    ],
    [
      "scheduler.env",
      webhookFiles.scheduler.replace("placeholder-password@", "wrong-placeholder@"),
      "scheduler.env",
    ],
    ["scheduler.env", webhookFiles.scheduler.replace("/test_db", "/other_db"), "scheduler.env"],
    [
      "api.env",
      "WEBHOOK_SECRET_ENCRYPTION_KEY=different-key-placeholder-at-least-32-bytes\n",
      "api.env",
    ],
  ])("Scheduler 配置 %s 缺失或不一致时在任何发布动作前失败", (file, value, message) => {
    const result = deploy("success", undefined, { [file]: value });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.log).toBe("");
    expect(result.composeEnv).toBe("HOOX_DEMO_IMAGE=test/previous@sha256:previous\n");
  });

  it.each(["dispatcher-auth-failure", "dispatcher-query-failure", "directory-auth-failure"])(
    "%s 时关闭 Scheduler 探针连接、隐藏凭据并在迁移前停止",
    (mode) => {
      const result = deploy(mode);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("数据库认证探针失败，已停止迁移");
      expect(result.log).toContain("--entrypoint node scheduler --input-type=module -e");
      expect(result.log).toContain("dispatcher connect");
      expect(result.log).toContain("dispatcher end");
      expect(result.log).not.toContain("run --rm migrate");
      expect(result.stdout + result.stderr + result.log).not.toContain("placeholder-password");
      expect(result.stdout).not.toContain("Hoox Demo 发布完成");
      expect(result.composeEnv).toContain("HOOX_DEMO_IMAGE=test/previous@sha256:previous");
    },
  );

  it("数据库初始化脚本可在已有数据卷上重复执行，并包含 Webhook Dispatcher 角色", () => {
    const script = readFileSync(
      fileURLToPath(new URL("../../deploy/demo/postgres-init.sh", import.meta.url)),
      "utf8",
    );
    // 已有角色或 Schema 时不能报错，也不得改写已有角色的密码。
    expect(script).not.toMatch(/^CREATE ROLE /mu);
    expect(script).not.toMatch(/ALTER ROLE/u);
    expect(script).toContain(
      "WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = wanted.role_name)",
    );
    expect(script).toContain("CREATE SCHEMA IF NOT EXISTS");
    expect(script).toContain("(:'webhook_role', :'webhook_password')");
  });

  it("认证探针复用真实 Scheduler 服务的环境文件和宿主网络，不注入连接覆盖值", () => {
    const compose = readFileSync(
      new URL("../../deploy/demo/docker-compose.yml", import.meta.url),
      "utf8",
    );
    const scheduler = compose.match(/^ {2}scheduler:\n([\s\S]*?)(?=^ {2}\w)/mu)?.[1];
    expect(compose).toMatch(/x-runtime: &runtime\n[\s\S]*?network_mode: host/u);
    expect(scheduler).toContain("<<: *runtime");
    expect(scheduler).toContain("/shared/scheduler.env");
    expect(scheduler).not.toMatch(/network_mode:|WEBHOOK_DISPATCHER_DATABASE_URL:/u);
    const script = readFileSync(deployScript, "utf8");
    const command = script.split("\n").find((line) => line.includes("--entrypoint node scheduler"));
    expect(command).toBe(
      "compose --profile ops run --rm --no-deps --entrypoint node scheduler --input-type=module -e '",
    );
  });

  it("保留数据卷升级时在迁移前幂等补齐数据库角色", () => {
    const result = deploy("success", undefined, {
      "scheduler.env": webhookFiles.scheduler.replace(
        "placeholder-password@",
        "placeholder%2Dpassword@",
      ),
    });
    expect(result.status, result.stderr).toBe(0);
    const started = result.log.indexOf("up -d --force-recreate postgres minio");
    const ready = result.log.indexOf("exec -T postgres sh -c pg_isready");
    const provisioned = result.log.indexOf(
      "exec -T postgres sh /docker-entrypoint-initdb.d/10-hoox-demo.sh",
    );
    expect(started).toBeGreaterThanOrEqual(0);
    expect(ready).toBeGreaterThan(started);
    expect(provisioned).toBeGreaterThan(ready);
    const probe = result.log.indexOf(
      "--no-deps --entrypoint node scheduler --input-type=module -e",
    );
    expect(probe).toBeGreaterThan(provisioned);
    expect(probe).toBeLessThan(result.log.indexOf("run --rm migrate"));
    expect(result.log).toContain("WEBHOOK_DISPATCHER_DATABASE_URL");
    expect(result.log.indexOf("dispatcher query SELECT 1")).toBeGreaterThan(probe);
    expect(result.log.indexOf("dispatcher end")).toBeLessThan(
      result.log.indexOf("run --rm migrate"),
    );
  });

  it.each([
    ["command-failure", 37],
    ["subshell-failure", 41],
    ["explicit-failure", 1],
    ["cleanup-failure", 1],
  ])("%s 保留原始退出码且只恢复一次", (mode, status) => {
    const result = deploy(String(mode));
    expect(result.status, result.stderr).toBe(status);
    expect(result.stderr.match(/已尝试恢复上一应用版本/gu)).toHaveLength(1);
    expect(result.log.match(/ stop api web scheduler worker/gu)).toHaveLength(1);
    expect(result.log).toContain(
      "up -d --force-recreate postgres minio api web scheduler worker admin-control admin-web",
    );
    expect(result.composeEnv).toContain("HOOX_DEMO_IMAGE=test/previous@sha256:previous");
    if (mode !== "cleanup-failure") {
      expect(readdirSync(join(result.root, "tmp"))).toEqual([]);
    }
  });

  it.each(["worker-restarting", "worker-never-started"])(
    "%s 即使 API 就绪也拒绝候选发布并恢复上一镜像",
    (mode) => {
      const result = deploy(mode);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("Demo Worker");
      expect(result.stdout).not.toContain("Hoox Demo 发布完成：candidate");
      expect(result.log.match(/ stop api web scheduler worker/gu)).toHaveLength(1);
      expect(result.composeEnv).toContain("HOOX_DEMO_IMAGE=test/previous@sha256:previous");
    },
  );

  it("发布成功时清理临时凭据且不触发回滚", () => {
    const result = deploy("success");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Hoox Demo 发布完成：candidate");
    expect(result.log).not.toContain(" stop ");
    expect(result.composeEnv).toContain("HOOX_DEMO_IMAGE=test/candidate@sha256:candidate");
    expect(readdirSync(join(result.root, "tmp"))).toEqual([]);
    expect(result.log).toContain("curl signup");
    expect(result.log).toContain("curl signin");
  });

  it("已有 Demo 账号跳过注册并继续验证登录，不受重复注册失败影响", () => {
    const result = deploy("existing-account");
    expect(result.status, result.stderr).toBe(0);
    expect(result.log).not.toContain("curl signup");
    expect(result.log).toContain("curl signin");
    expect(result.log).not.toContain(" stop ");
    expect(result.stdout).toContain("Hoox Demo 发布完成：candidate");
  });

  it("账号查询结果无效或已有凭据不能登录时失败关闭并回滚", () => {
    for (const mode of ["account-lookup-invalid", "existing-account-signin-failure"]) {
      const result = deploy(mode);
      expect(result.status, result.stderr).toBe(1);
      expect(result.log).not.toContain("curl signup");
      expect(result.log).toContain(" stop ");
      expect(result.stdout).not.toContain("Hoox Demo 发布完成：candidate");
      expect(result.composeEnv).toContain("HOOX_DEMO_IMAGE=test/previous@sha256:previous");
      expect(result.stderr).toContain(
        mode === "account-lookup-invalid" ? "账号存在性检查失败" : "HTTP 401",
      );
    }
  });

  it("发布前后备份已有运行配置，只保留完整快照且权限受限", () => {
    const result = deploy("config-export");
    expect(result.status, result.stderr).toBe(0);
    const directory = join(result.root, "shared/runtime-config");
    const latest = readFileSync(join(directory, "latest.sql"), "utf8");
    expect(latest).toBe(
      [
        "INSERT INTO test_schema.app_users VALUES (1);",
        "INSERT INTO test_schema.admin_control_config_revisions VALUES (1);",
        "UPDATE test_schema.admin_control_generation SET generation=5;",
        "",
      ].join("\n"),
    );
    expect(result.stdout).toContain("已备份 Demo 运行配置：before-deploy");
    expect(result.stdout).toContain("已备份 Demo 运行配置：after-deploy");
    expect(readdirSync(directory).filter((name) => name.startsWith(".candidate"))).toEqual([]);
    if (process.platform !== "win32") {
      expect(statSync(join(directory, "latest.sql")).mode & 0o777).toBe(0o600);
    }
    expect(result.log).not.toContain("config restore");
  });

  it("备份导出失败时告警并保留上一份备份，不阻断发布", () => {
    const result = deploy("config-export-dump-failure", (root) => {
      mkdirSync(join(root, "shared/runtime-config"));
      writeFileSync(join(root, "shared/runtime-config/latest.sql"), "previous\n");
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("运行配置备份失败");
    expect(readFileSync(join(result.root, "shared/runtime-config/latest.sql"), "utf8")).toBe(
      "previous\n",
    );
    expect(result.stdout).toContain("Hoox Demo 发布完成：candidate");
  });

  it("迁移后新库没有配置时在启动应用前单事务恢复备份", () => {
    const result = deploy("config-restore", (root) => {
      mkdirSync(join(root, "shared/runtime-config"));
      writeFileSync(join(root, "shared/runtime-config/latest.sql"), "SELECT 'restored';\n");
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("已从备份恢复 Demo 运行配置");
    const restore = result.log.indexOf("config restore SELECT 'restored';");
    expect(restore).toBeGreaterThan(result.log.indexOf("run --rm migrate"));
    expect(restore).toBeLessThan(result.log.indexOf("up -d api web"));
  });

  it("新库已有配置或没有备份时不执行恢复", () => {
    for (const mode of ["config-export", "success"]) {
      const result = deploy(mode, (root) => {
        mkdirSync(join(root, "shared/runtime-config"));
        writeFileSync(join(root, "shared/runtime-config/latest.sql"), "SELECT 1;\n");
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.log).not.toContain("config restore");
    }
  });

  it.each([0, 31])("远端 logout 返回 %i 后仍清理临时 Docker 配置与 Runner 私钥", (logoutStatus) => {
    const root = mkdtempSync(join(tmpdir(), "hoox-demo-cleanup-test-"));
    temporaryRoots.push(root);
    const sshDirectory = join(root, ".ssh");
    const dockerDirectory = join(root, "docker");
    mkdirSync(sshDirectory);
    mkdirSync(dockerDirectory);
    const key = join(sshDirectory, "hoox-demo");
    writeFileSync(key, "test-placeholder-key");
    writeFileSync(join(dockerDirectory, "config.json"), '{"auths":{"ghcr.io":{}}}');
    const workflow = readFileSync(
      new URL("../../.github/workflows/cd-demo.yml", import.meta.url),
      "utf8",
    );
    const cleanup = workflow
      .match(/ {6}- name: 清理发布凭据[\s\S]*? {8}run: \|\n([\s\S]*)$/u)?.[1]
      ?.replace(/^ {10}/gmu, "")
      .replaceAll("$HOME", "$FIXTURE_HOME");
    expect(cleanup).toBeDefined();
    const script = join(root, "cleanup.sh");
    writeFileSync(
      script,
      `docker() { return "$MOCK_LOGOUT_STATUS"; }
export -f docker
ssh() { shift 3; "$@"; }
${cleanup}`,
    );
    const result = spawnSync(bash, [script], {
      env: {
        ...process.env,
        FIXTURE_HOME: root,
        SSH_HOST: "example.invalid",
        SSH_USER: "test_user",
        REMOTE_DOCKER_CONFIG: dockerDirectory,
        MOCK_LOGOUT_STATUS: String(logoutStatus),
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(logoutStatus);
    expect(existsSync(key)).toBe(false);
    expect(existsSync(dockerDirectory)).toBe(false);
  });
});

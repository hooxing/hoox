import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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

function deploy(mode: string) {
  const root = mkdtempSync(join(tmpdir(), "hoox-demo-deploy-test-"));
  temporaryRoots.push(root);
  for (const directory of ["releases/candidate", "releases/previous", "shared", "tmp"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
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
    "infra.env": "POSTGRES_USER=test_user\nPOSTGRES_DB=test_db\nDATABASE_SCHEMA=test_schema\n",
    "migration.env": "",
    "api.env": "",
    "admin-control.env":
      "DEV_ADMIN_CONTROL_TOKEN=test-placeholder-token-with-at-least-32-characters\n",
    "scheduler.env": "",
    "worker.env": "",
    "demo-account.env": "DEMO_ACCOUNT_EMAIL=demo@example.invalid\n",
    "compose.env": "HOOX_DEMO_IMAGE=test/previous@sha256:previous\n",
  };
  for (const [file, value] of Object.entries(files)) {
    if (mode !== "missing-config" || file !== "api.env") {
      writeFileSync(join(root, "shared", file), value);
    }
  }
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
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  return {
    ...result,
    root,
    log: existsSync(log) ? readFileSync(log, "utf8") : "",
    composeEnv: readFileSync(join(root, "shared/compose.env"), "utf8"),
  };
}

// Git Bash 的多进程验收在全量并发时可能超过默认 5 秒；子进程仍受 15 秒硬超时约束。
describe("Demo 远端发布失败恢复", { timeout: 20_000 }, () => {
  it("共享配置缺失时不启动或回滚应用，也不改发布配置", () => {
    const result = deploy("missing-config");
    expect(result.status, result.stderr).toBe(2);
    expect(result.log).toBe("");
    expect(result.composeEnv).toBe("HOOX_DEMO_IMAGE=test/previous@sha256:previous\n");
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
      "up -d --force-recreate postgres minio api web scheduler worker admin-control admin-web trajectory",
    );
    expect(result.composeEnv).toContain("HOOX_DEMO_IMAGE=test/previous@sha256:previous");
    if (mode !== "cleanup-failure") {
      expect(readdirSync(join(result.root, "tmp"))).toEqual([]);
    }
  });

  it("发布成功时清理临时凭据且不触发回滚", () => {
    const result = deploy("success");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Hoox Demo 发布完成：candidate");
    expect(result.log).not.toContain(" stop ");
    expect(result.composeEnv).toContain("HOOX_DEMO_IMAGE=test/candidate@sha256:candidate");
    expect(readdirSync(join(result.root, "tmp"))).toEqual([]);
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

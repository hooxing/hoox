import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

function runDocker(arguments_, options = {}) {
  const result = spawnSync("docker", arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`DOCKER_COMMAND_FAILED:${arguments_[0] ?? "unknown"}`);
  return result.stdout?.trim() ?? "";
}

const canaryPath = join(process.cwd(), ".env.process-context-canary");
const canary = "PROCESS_CONTEXT_CANARY=must-not-enter-build-context-or-image\n";
let imageId;
let primaryFailure;
let cleanupFailure;

try {
  // 只创建此前不存在的临时 canary，绝不读取、改写或恢复用户的真实 .env.local。
  if (existsSync(canaryPath)) throw new Error("PROCESS_CONTEXT_CANARY_PATH_EXISTS");
  writeFileSync(canaryPath, canary);
  const contextProbe = spawnSync(
    "docker",
    ["build", "--file", "Dockerfile.process-context-probe", "."],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true,
    },
  );
  if (contextProbe.status === 0) throw new Error("DOCKER_BUILD_CONTEXT_CONTAINS_ENV_LOCAL");

  imageId = runDocker(["build", "--quiet", "--file", "Dockerfile.process-gate", "."], {
    capture: true,
  });
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) throw new Error("DOCKER_IMAGE_ID_INVALID");
  const configuredUser = runDocker(["image", "inspect", "--format", "{{.Config.User}}", imageId], {
    capture: true,
  });
  if (configuredUser !== "1000:1000") throw new Error("DOCKER_IMAGE_USER_CONFIG_INVALID");
  runDocker([
    "run",
    "--rm",
    imageId,
    "node",
    "--input-type=module",
    "--eval",
    "import { existsSync } from 'node:fs'; if (process.getuid() === 0 || existsSync('/opt/process-gate/.env.process-context-canary')) process.exit(73);",
  ]);
  const gateOutput = runDocker(
    [
      "run",
      "--rm",
      "--env",
      "RUNTIME_ENV=test",
      "--env",
      "PROCESS_SHUTDOWN_TIMEOUT_MS=1000",
      "--env",
      "PROCESS_GATE_SECRET_CANARY=must-not-appear-in-container-output",
      imageId,
    ],
    { capture: true },
  );
  if (gateOutput.includes("must-not-appear-in-container-output")) {
    throw new Error("DOCKER_CONTAINER_GATE_OUTPUT_LEAKED_SECRET");
  }
} catch (error) {
  primaryFailure = error;
} finally {
  rmSync(canaryPath, { force: true });
  // 只清理本次构建返回的精确镜像 ID，不使用标签、通配符或目录级删除。
  if (imageId !== undefined) {
    try {
      runDocker(["image", "rm", imageId]);
    } catch (cleanupError) {
      cleanupFailure = cleanupError;
    }
  }
}

// 主门禁失败优先于镜像清理失败，清理错误仅在主流程成功时才成为最终错误。
if (primaryFailure !== undefined) throw primaryFailure;
if (cleanupFailure !== undefined) throw cleanupFailure;

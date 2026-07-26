import { spawnSync } from "node:child_process";
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

const imageId = runDocker(["build", "--quiet", "--file", "Dockerfile.process-gate", "."], {
  capture: true,
});
if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) throw new Error("DOCKER_IMAGE_ID_INVALID");

try {
  runDocker([
    "run",
    "--rm",
    "--env",
    "RUNTIME_ENV=test",
    "--env",
    "PROCESS_SHUTDOWN_TIMEOUT_MS=1000",
    imageId,
  ]);
} finally {
  // 只清理本次构建返回的精确镜像 ID，不使用标签、通配符或目录级删除。
  runDocker(["image", "rm", imageId]);
}

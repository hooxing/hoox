import { spawnSync } from "node:child_process";

function runDocker(arguments_, capture = false) {
  const result = spawnSync("docker", arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PI_PROMPT_DOCKER_FAILED:${arguments_[0] ?? "unknown"}`);
  return result.stdout?.trim() ?? "";
}

let imageId;
let primaryFailure;
let cleanupFailure;

try {
  imageId = runDocker(["build", "--quiet", "--file", "Dockerfile.pi-prompt-gate", "."], true);
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) throw new Error("PI_PROMPT_IMAGE_ID_INVALID");
  const configuredUser = runDocker(
    ["image", "inspect", "--format", "{{.Config.User}}", imageId],
    true,
  );
  if (configuredUser !== "1000:1000") throw new Error("PI_PROMPT_IMAGE_USER_INVALID");
  runDocker(["run", "--rm", "--network", "none", imageId]);
} catch (error) {
  primaryFailure = error;
} finally {
  if (imageId !== undefined) {
    try {
      // 只删除本次 build 返回的精确镜像 ID，不使用标签或模糊匹配。
      runDocker(["image", "rm", imageId]);
    } catch (error) {
      cleanupFailure = error;
    }
  }
}

if (primaryFailure !== undefined) throw primaryFailure;
if (cleanupFailure !== undefined) throw cleanupFailure;

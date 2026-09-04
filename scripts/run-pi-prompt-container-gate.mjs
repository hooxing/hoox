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

const prebuiltImage = process.env.PI_PROMPT_GATE_IMAGE?.trim();
let imageId;
let removeImage = false;
let primaryFailure;
let cleanupFailure;

try {
  if (prebuiltImage === undefined || prebuiltImage.length === 0) {
    imageId = runDocker(["build", "--quiet", "--file", "Dockerfile.pi-prompt-gate", "."], true);
    removeImage = true;
  } else {
    imageId = runDocker(["image", "inspect", "--format", "{{.Id}}", prebuiltImage], true);
  }
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
  if (removeImage && imageId !== undefined) {
    try {
      runDocker(["image", "rm", imageId]);
    } catch (error) {
      cleanupFailure = error;
    }
  }
}

if (primaryFailure !== undefined) throw primaryFailure;
if (cleanupFailure !== undefined) throw cleanupFailure;

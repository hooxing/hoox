import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  validateProductionReleaseContract,
  validateProductionReleaseInputs,
} from "../scripts/production-release-contract.mjs";

function repositoryInputs() {
  const scriptsDirectory = new URL("../scripts/", import.meta.url);
  return {
    dockerignore: readFileSync(new URL("../.dockerignore", import.meta.url), "utf8"),
    apiDockerfile: readFileSync(
      new URL("../Dockerfile.production-api-gate", import.meta.url),
      "utf8",
    ),
    schedulerDockerfile: readFileSync(
      new URL("../Dockerfile.production-scheduler-gate", import.meta.url),
      "utf8",
    ),
    workerDockerfile: readFileSync(
      new URL("../Dockerfile.production-worker-gate", import.meta.url),
      "utf8",
    ),
    manifest: JSON.parse(
      readFileSync(
        new URL("../deploy/production-release-manifest.example.json", import.meta.url),
        "utf8",
      ),
    ),
    checklist: readFileSync(
      new URL("../deploy/production-release-checklist.md", import.meta.url),
      "utf8",
    ),
    packageJson: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
    scripts: readdirSync(scriptsDirectory)
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => readFileSync(new URL(name, scriptsDirectory), "utf8"))
      .join("\n"),
  };
}

describe("生产发布与回滚契约", () => {
  it("固定镜像、必需 Gate 与回滚记录完整", () => {
    expect(validateProductionReleaseContract()).toEqual([]);
  });

  it("tag-only 镜像或空回滚触发条件都失败关闭", () => {
    const input = repositoryInputs();
    const issues = validateProductionReleaseInputs({
      ...input,
      apiDockerfile: input.apiDockerfile.replace(/@sha256:[a-f0-9]{64}/u, ""),
      manifest: { ...input.manifest, rollback: { ...input.manifest.rollback, trigger: "" } },
    });
    expect(issues).toContain("API 基础镜像未同时固定 build/runtime digest");
    expect(issues).toContain("API 存在 tag-only Node 基础镜像");
    expect(issues).toContain("发布 manifest 回滚目标不完整");
  });

  it("Docker build context 必须排除本地 exports 运行证据", () => {
    const input = repositoryInputs();
    expect(
      validateProductionReleaseInputs({ ...input, dockerignore: ".git\nnode_modules\n" }),
    ).toContain("Docker build context 未排除根级 exports 运行证据");
  });

  it("运行闭包必须归 root 所有且不可由运行 UID 改写", () => {
    const input = repositoryInputs();
    expect(
      validateProductionReleaseInputs({
        ...input,
        workerDockerfile: input.workerDockerfile.replace(
          "COPY --from=build --chown=0:0 /opt/deploy/ ./",
          "COPY --from=build --chown=1000:1000 /opt/deploy/ ./",
        ),
      }),
    ).toContain("Worker 运行闭包未固定为 root 所有且不可写");
  });
});

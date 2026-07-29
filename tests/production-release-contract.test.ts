import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  validateProductionReleaseContract,
  validateProductionReleaseInputs,
} from "../scripts/production-release-contract.mjs";

function repositoryInputs() {
  const scriptsDirectory = new URL("../scripts/", import.meta.url);
  return {
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
});

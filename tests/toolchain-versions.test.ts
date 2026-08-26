import { describe, expect, it } from "vitest";
import {
  readToolchainVersionInputs,
  validateToolchainVersionContract,
  validateToolchainVersions,
} from "../scripts/validate-toolchain-versions.mjs";

describe("工具链版本契约", () => {
  it("仓库声明保持一致", () => {
    expect(validateToolchainVersionContract()).toEqual([]);
  });

  it("版本文件漂移时失败关闭", () => {
    const input = readToolchainVersionInputs();
    expect(
      validateToolchainVersions({
        ...input,
        nodeVersionFile: "24.17.0\n",
        nvmrc: "24.16.0\n",
      }),
    ).toEqual(
      expect.arrayContaining([
        ".node-version 与 package.json#engines.node 不一致",
        ".nvmrc 与 package.json#engines.node 不一致",
      ]),
    );
  });

  it("Node.js 类型包必须精确固定在相同主版本", () => {
    const input = readToolchainVersionInputs();
    expect(
      validateToolchainVersions({
        ...input,
        packageJson: {
          ...input.packageJson,
          devDependencies: { ...input.packageJson.devDependencies, "@types/node": "^25.0.0" },
        },
      }),
    ).toContain("@types/node 必须使用精确版本");

    expect(
      validateToolchainVersions({
        ...input,
        packageJson: {
          ...input.packageJson,
          devDependencies: { ...input.packageJson.devDependencies, "@types/node": "25.0.0" },
        },
      }),
    ).toContain("@types/node 必须与 Node.js 运行时保持相同主版本");
  });

  it("仓库脚本不得回退到系统全局 pnpm", () => {
    const input = readToolchainVersionInputs();
    expect(
      validateToolchainVersions({
        ...input,
        packageJson: {
          ...input.packageJson,
          scripts: { ...input.packageJson.scripts, build: "pnpm --recursive build" },
        },
      }),
    ).toContain("package.json 脚本不得绕过 Corepack 调用 pnpm：build");
  });

  it("CI、Docker 与 pnpm 的重复声明发生漂移时失败关闭", () => {
    const input = readToolchainVersionInputs();
    const piPromptGate = input.dockerfiles.find(
      (dockerfile) => dockerfile.name === "Dockerfile.pi-prompt-gate",
    );
    expect(piPromptGate).toBeDefined();

    expect(
      validateToolchainVersions({
        ...input,
        ciWorkflow: input.ciWorkflow.replace(
          "node-version-file: .node-version",
          "node-version: 24.17.0",
        ),
        dockerfiles: input.dockerfiles.map((dockerfile) =>
          dockerfile.name === "Dockerfile.pi-prompt-gate"
            ? {
                ...dockerfile,
                content: dockerfile.content
                  .replace("node:24.18.0", "node:24.17.0")
                  .replace("pnpm@10.15.1", "pnpm@10.14.0"),
              }
            : dockerfile,
        ),
      }),
    ).toEqual(
      expect.arrayContaining([
        "CI 中所有 setup-node 步骤都必须读取 .node-version",
        "CI 不得重复硬编码 Node.js 版本",
        "Dockerfile.pi-prompt-gate 的 Node.js 基础镜像版本不一致",
        "Dockerfile.pi-prompt-gate 的 pnpm 版本不一致",
      ]),
    );
  });
});

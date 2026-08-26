import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exactVersionPattern = /^(\d+)\.(\d+)\.(\d+)$/u;
const packageManagerPattern = /^pnpm@(\d+\.\d+\.\d+)\+sha512\.[A-Za-z0-9+/=]+$/u;

function normalizedVersionFile(value) {
  return value.trim();
}

export function readToolchainVersionInputs() {
  return Object.freeze({
    packageJson: JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")),
    nodeVersionFile: readFileSync(join(repositoryRoot, ".node-version"), "utf8"),
    nvmrc: readFileSync(join(repositoryRoot, ".nvmrc"), "utf8"),
    ciWorkflow: readFileSync(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8"),
    dockerfiles: Object.freeze(
      readdirSync(repositoryRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.startsWith("Dockerfile"))
        .map((entry) =>
          Object.freeze({
            name: entry.name,
            content: readFileSync(join(repositoryRoot, entry.name), "utf8"),
          }),
        ),
    ),
  });
}

export function validateToolchainVersions(input) {
  const issues = [];
  const runtimeVersion = input.packageJson.engines?.node;
  const runtimeMatch =
    typeof runtimeVersion === "string" ? exactVersionPattern.exec(runtimeVersion) : null;
  if (runtimeMatch === null) {
    issues.push("package.json#engines.node 必须是精确版本");
    return issues;
  }

  for (const [file, value] of [
    [".node-version", input.nodeVersionFile],
    [".nvmrc", input.nvmrc],
  ]) {
    if (normalizedVersionFile(value) !== runtimeVersion) {
      issues.push(`${file} 与 package.json#engines.node 不一致`);
    }
  }

  const nodeTypesVersion = input.packageJson.devDependencies?.["@types/node"];
  const nodeTypesMatch =
    typeof nodeTypesVersion === "string" ? exactVersionPattern.exec(nodeTypesVersion) : null;
  if (nodeTypesMatch === null) {
    issues.push("@types/node 必须使用精确版本");
  } else if (nodeTypesMatch[1] !== runtimeMatch[1]) {
    issues.push("@types/node 必须与 Node.js 运行时保持相同主版本");
  }

  const packageManager = input.packageJson.packageManager;
  const packageManagerMatch =
    typeof packageManager === "string" ? packageManagerPattern.exec(packageManager) : null;
  if (packageManagerMatch === null) {
    issues.push("packageManager 必须固定 pnpm 精确版本与 registry integrity");
  }

  for (const [name, command] of Object.entries(input.packageJson.scripts ?? {})) {
    if (typeof command === "string" && /(?<!corepack )\bpnpm\s/u.test(command)) {
      issues.push(`package.json 脚本不得绕过 Corepack 调用 pnpm：${name}`);
    }
  }

  const setupNodeCount = [...input.ciWorkflow.matchAll(/uses:\s*actions\/setup-node@/gu)].length;
  const nodeVersionFileCount = [
    ...input.ciWorkflow.matchAll(/^\s*node-version-file:\s*\.node-version\s*$/gmu),
  ].length;
  if (setupNodeCount === 0 || nodeVersionFileCount !== setupNodeCount) {
    issues.push("CI 中所有 setup-node 步骤都必须读取 .node-version");
  }
  if (/^\s*node-version:\s*/mu.test(input.ciWorkflow)) {
    issues.push("CI 不得重复硬编码 Node.js 版本");
  }

  for (const dockerfile of input.dockerfiles) {
    for (const match of dockerfile.content.matchAll(
      /^FROM\s+node:([^\s@]+)(?:@[^\s]+)?(?:\s+AS\s+\S+)?\s*$/gimu,
    )) {
      const tag = match[1];
      if (tag !== runtimeVersion && !tag.startsWith(`${runtimeVersion}-`)) {
        issues.push(`${dockerfile.name} 的 Node.js 基础镜像版本不一致`);
      }
    }
    if (packageManagerMatch !== null) {
      for (const match of dockerfile.content.matchAll(/\bpnpm@(\d+\.\d+\.\d+)\b/gu)) {
        if (match[1] !== packageManagerMatch[1]) {
          issues.push(`${dockerfile.name} 的 pnpm 版本不一致`);
        }
      }
    }
  }

  return [...new Set(issues)].sort();
}

export function validateToolchainVersionContract() {
  return validateToolchainVersions(readToolchainVersionInputs());
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const issues = validateToolchainVersionContract();
  if (issues.length > 0) throw new Error(issues.join("\n"));
  console.info("Node.js 与 pnpm 工具链版本契约验证通过");
}

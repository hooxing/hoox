import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const productionNodeBaseDigest =
  "sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";
const pinnedNodeImage = `node:24.18.0-bookworm-slim@${productionNodeBaseDigest}`;
const pinnedPackageManager =
  "pnpm@10.15.1+sha512.34e538c329b5553014ca8e8f4535997f96180a1d0f614339357449935350d924e22f8614682191264ec33d1462ac21561aff97f6bb18065351c162c7e8f6de67";
const requiredGates = Object.freeze([
  "config:check:production",
  "supply-chain:check",
  "license:check",
  "release:check",
  "test:production-api:container",
  "test:production-scheduler:container",
  "test:production-worker:container",
]);

function occurrences(value, pattern) {
  return value.split(pattern).length - 1;
}

function readRepositoryInputs() {
  const scripts = readdirSync(join(repositoryRoot, "scripts"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => readFileSync(join(repositoryRoot, "scripts", entry.name), "utf8"))
    .join("\n");
  return Object.freeze({
    apiDockerfile: readFileSync(join(repositoryRoot, "Dockerfile.production-api-gate"), "utf8"),
    schedulerDockerfile: readFileSync(
      join(repositoryRoot, "Dockerfile.production-scheduler-gate"),
      "utf8",
    ),
    workerDockerfile: readFileSync(
      join(repositoryRoot, "Dockerfile.production-worker-gate"),
      "utf8",
    ),
    manifest: JSON.parse(
      readFileSync(join(repositoryRoot, "deploy", "production-release-manifest.example.json")),
    ),
    checklist: readFileSync(
      join(repositoryRoot, "deploy", "production-release-checklist.md"),
      "utf8",
    ),
    packageJson: JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")),
    scripts,
  });
}

export function validateProductionReleaseInputs(input) {
  const issues = [];
  for (const [service, dockerfile] of [
    ["API", input.apiDockerfile],
    ["Scheduler", input.schedulerDockerfile],
    ["Worker", input.workerDockerfile],
  ]) {
    if (occurrences(dockerfile, `FROM ${pinnedNodeImage}`) !== 2) {
      issues.push(`${service} 基础镜像未同时固定 build/runtime digest`);
    }
    if (/^FROM\s+node:[^\s@]+(?:\s|$)/mu.test(dockerfile)) {
      issues.push(`${service} 存在 tag-only Node 基础镜像`);
    }
    if (
      !dockerfile.includes(`org.opencontainers.image.base.digest="${productionNodeBaseDigest}"`)
    ) {
      issues.push(`${service} 缺少基础镜像 digest 标签`);
    }
    if (
      !dockerfile.includes("USER 1000:1000") ||
      !dockerfile.includes('CMD ["node", "dist/production-main.js"]')
    ) {
      issues.push(`${service} 非 root production entry 契约缺失`);
    }
    if (
      !dockerfile.includes("runtime-ts/vendor/cubesandbox-sdk/LICENSE") ||
      !dockerfile.includes("runtime-ts/vendor/cubesandbox-sdk/SOURCE.md")
    ) {
      issues.push(`${service} 缺少 vendor LICENSE/SOURCE 镜像证据`);
    }
    if (
      !dockerfile.includes("RUN pnpm fetch --frozen-lockfile") ||
      !dockerfile.includes("RUN --network=none pnpm install --offline --frozen-lockfile")
    ) {
      issues.push(`${service} 缺少锁定 store 与断网安装/编译阶段`);
    }
    for (const toolPath of [
      "/usr/local/lib/node_modules/npm",
      "/usr/local/lib/node_modules/corepack",
      "/usr/local/bin/npm",
      "/usr/local/bin/npx",
      "/usr/local/bin/corepack",
    ]) {
      if (!dockerfile.includes(toolPath))
        issues.push(`${service} 未移除 runtime 构建工具：${toolPath}`);
    }
  }

  const manifest = input.manifest;
  if (input.packageJson.packageManager !== pinnedPackageManager) {
    issues.push("packageManager 缺少固定 registry integrity");
  }
  if (manifest.schemaVersion !== 1 || manifest.releaseId !== "<release-id>") {
    issues.push("发布 manifest 版本或 release 占位符无效");
  }
  for (const key of ["apiImageDigest", "schedulerImageDigest", "workerImageDigest"]) {
    if (!/^sha256:<64-hex-[a-z-]+-image-digest>$/u.test(manifest[key] ?? "")) {
      issues.push(`发布 manifest 镜像 digest 占位符无效：${key}`);
    }
  }
  if (JSON.stringify(manifest.requiredGates) !== JSON.stringify(requiredGates)) {
    issues.push("发布 manifest Gate 清单漂移");
  }
  for (const service of ["api", "scheduler", "worker"]) {
    if (
      manifest.sbom?.[service] !== `supply-chain/sbom/${service}.cdx.json` ||
      manifest.sbom?.[`${service}Sha256`] !== `<64-hex-${service}-sbom-sha256>`
    ) {
      issues.push(`发布 manifest SBOM 记录不完整：${service}`);
    }
  }
  if (
    !/^sha256:<64-hex-previous-api-image-digest>$/u.test(manifest.rollback?.apiImageDigest ?? "") ||
    !/^sha256:<64-hex-previous-scheduler-image-digest>$/u.test(
      manifest.rollback?.schedulerImageDigest ?? "",
    ) ||
    !/^sha256:<64-hex-previous-worker-image-digest>$/u.test(
      manifest.rollback?.workerImageDigest ?? "",
    ) ||
    manifest.rollback?.trigger !== "<rollback-trigger-and-threshold>" ||
    manifest.rollback?.owner !== "<on-call-owner>"
  ) {
    issues.push("发布 manifest 回滚目标不完整");
  }

  for (const heading of ["## 发布前", "## 发布", "## 回滚触发", "## 回滚执行", "## 完成条件"]) {
    if (!input.checklist.includes(heading)) issues.push(`发布回滚清单缺少：${heading}`);
  }
  for (const boundary of [
    "镜像 digest",
    "CycloneDX SBOM",
    "rollbackCompatibleThrough",
    "最小权限 Runtime 角色",
    "API/Scheduler/Worker",
    "M7 的容量、全量故障与真实基础设施 Gate",
  ]) {
    if (!input.checklist.includes(boundary)) issues.push(`发布回滚边界缺少：${boundary}`);
  }

  for (const script of requiredGates) {
    if (typeof input.packageJson.scripts?.[script] !== "string") {
      issues.push(`package script 缺失：${script}`);
    }
  }
  const executableText = `${JSON.stringify(input.packageJson.scripts ?? {})}\n${input.scripts}`;
  const floatingExecutorPattern = new RegExp(
    String.raw`\b(?:pnpm\s+d${"lx"}|n${"px"})\s+(?:--[^\s]+\s+)*[^\s;&|]+`,
    "u",
  );
  if (floatingExecutorPattern.test(executableText)) {
    issues.push(`生产 Gate 禁止浮动 d${"lx"}/n${"px"}`);
  }
  return issues.sort();
}

export function validateProductionReleaseContract() {
  return validateProductionReleaseInputs(readRepositoryInputs());
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const issues = validateProductionReleaseContract();
  if (issues.length > 0) throw new Error(issues.join("\n"));
  console.info("生产发布与回滚静态契约验证通过");
}

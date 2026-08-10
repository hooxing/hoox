import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockfilePath = join(repositoryRoot, "pnpm-lock.yaml");
const policyPath = join(repositoryRoot, "supply-chain", "license-policy.json");
const sbomDirectory = join(repositoryRoot, "supply-chain", "sbom");
const excludedVendorTreeDirectories = new Set(["dist", "node_modules", "coverage", ".tmp"]);

export const productionSbomTargets = Object.freeze([
  Object.freeze({ id: "api", packageName: "@cube-runtime/api", fileName: "api.cdx.json" }),
  Object.freeze({
    id: "scheduler",
    packageName: "@cube-runtime/scheduler",
    fileName: "scheduler.cdx.json",
  }),
  Object.freeze({
    id: "worker",
    packageName: "@cube-runtime/agent-worker",
    fileName: "worker.cdx.json",
  }),
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 排序后的相对路径、UTF-8 路径长度与原始文件字节共同形成无歧义 vendor tree digest。 */
export function canonicalVendorTreeSha256(directory) {
  const files = [];
  const visit = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      compareCodeUnits(left.name, right.name),
    )) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("PRODUCTION_VENDOR_TREE_SYMLINK_FORBIDDEN");
      if (entry.isDirectory()) {
        if (!(prefix === "" && excludedVendorTreeDirectories.has(entry.name))) {
          visit(join(current, entry.name), relativePath);
        }
      } else if (
        entry.isFile() &&
        !entry.name.endsWith(".tsbuildinfo") &&
        entry.name !== ".DS_Store"
      ) {
        files.push(relativePath);
      }
    }
  };
  visit(directory, "");
  const digest = createHash("sha256");
  for (const relativePath of files) {
    const content = readFileSync(join(directory, ...relativePath.split("/")));
    digest.update(
      Buffer.from(
        `${Buffer.byteLength(relativePath, "utf8")}\n${relativePath}\n${content.length}\n`,
      ),
    );
    digest.update(content);
  }
  return digest.digest("hex");
}

/** 精确补丁必须能从当前受控树反向应用；Git 缺失、异常或非零状态均失败关闭。 */
export function verifyReverseApplicablePatch(patchPath) {
  const result = spawnSync(
    "git",
    ["apply", "--reverse", "--check", "--whitespace=nowarn", patchPath],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return result.error === undefined && result.status === 0;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function packageUrl(name, version) {
  const encodedName = name.startsWith("@")
    ? `${encodeURIComponent(name.split("/")[0])}/${encodeURIComponent(name.split("/")[1])}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function sortedProperties(properties) {
  return Object.entries(properties)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([name, value]) => Object.freeze({ name, value }));
}

function component(input) {
  const purl = packageUrl(input.name, input.version);
  return Object.freeze({
    type: input.type ?? "library",
    "bom-ref": purl,
    name: input.name,
    version: input.version,
    purl,
    ...(input.license === undefined
      ? {}
      : { licenses: [Object.freeze({ license: Object.freeze({ id: input.license }) })] }),
    properties: sortedProperties(input.properties),
  });
}

function workspaceManifests() {
  const manifests = new Map();
  for (const parent of ["runtime-ts/apps", "runtime-ts/packages", "runtime-ts/vendor"]) {
    const directory = join(repositoryRoot, parent);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name, "package.json");
      if (!existsSync(path)) continue;
      const manifest = readJson(path);
      if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
        throw new Error("PRODUCTION_SBOM_WORKSPACE_MANIFEST_INVALID");
      }
      manifests.set(manifest.name, Object.freeze({ manifest, path }));
    }
  }
  return manifests;
}

function workspaceClosure(rootPackageName, policy) {
  const manifests = workspaceManifests();
  const queue = [rootPackageName];
  const visited = new Set();
  const components = [];
  let rootManifest;
  while (queue.length > 0) {
    const packageName = queue.shift();
    if (packageName === undefined || visited.has(packageName)) continue;
    const item = manifests.get(packageName);
    if (item === undefined) throw new Error("PRODUCTION_SBOM_WORKSPACE_DEPENDENCY_MISSING");
    visited.add(packageName);
    if (packageName === rootPackageName) rootManifest = item.manifest;
    const dependencies = item.manifest.dependencies ?? {};
    for (const [dependencyName, specifier] of Object.entries(dependencies)) {
      if (typeof specifier === "string" && specifier.startsWith("workspace:")) {
        queue.push(dependencyName);
      }
    }
    if (packageName === rootPackageName) continue;
    const evidence = policy.vendorEvidence?.[packageName];
    components.push(
      component({
        name: packageName,
        version: item.manifest.version,
        ...(evidence === undefined ? {} : { license: evidence.license }),
        properties: {
          "cube:origin": evidence === undefined ? "workspace" : "vendor",
          "cube:workspace-path": relative(repositoryRoot, dirname(item.path)).split(sep).join("/"),
          ...(evidence === undefined
            ? {}
            : {
                "cube:license-file": evidence.licenseFile,
                "cube:upstream-source-commit": evidence.upstreamCommit,
                "cube:source-file": evidence.sourceFile,
                "cube:local-modified": "true",
                "cube:local-patch-id": evidence.localPatchId,
                "cube:local-patch-file": evidence.patchFile,
                "cube:local-patch-sha256": evidence.patchSha256,
                "cube:patched-tree-sha256": evidence.patchedTreeSha256,
              }),
        },
      }),
    );
  }
  if (rootManifest === undefined) throw new Error("PRODUCTION_SBOM_ROOT_PACKAGE_MISSING");
  return Object.freeze({
    rootManifest,
    components: Object.freeze(components),
    packageNames: Object.freeze([...visited].sort()),
  });
}

const pnpmLicenseCache = new Map();

function runPnpmLicenses(packageName) {
  const cached = pnpmLicenseCache.get(packageName);
  if (cached !== undefined) return cached;
  if (!/^@[a-z0-9_-]+\/[a-z0-9_-]+$/u.test(packageName)) {
    throw new Error("PRODUCTION_SBOM_PACKAGE_NAME_INVALID");
  }
  const pnpmArguments = ["--filter", packageName, "licenses", "list", "--prod", "--json"];
  const windows = process.platform === "win32";
  const result = spawnSync(
    windows ? (process.env.ComSpec ?? "cmd.exe") : "pnpm",
    windows ? ["/d", "/s", "/c", `pnpm ${pnpmArguments.join(" ")}`] : pnpmArguments,
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, PNPM_CONFIG_OFFLINE: "true" },
      windowsHide: true,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("PRODUCTION_SBOM_LICENSE_CLOSURE_UNAVAILABLE");
  }
  try {
    const output = result.stdout.trim();
    const parsed = output === "No licenses in packages found" ? {} : JSON.parse(output);
    pnpmLicenseCache.set(packageName, parsed);
    return parsed;
  } catch {
    throw new Error("PRODUCTION_SBOM_LICENSE_CLOSURE_INVALID");
  }
}

const clipboardPlatformPackagePattern = /^@mariozechner\/clipboard-(?:darwin|linux|win32)-/u;
const canonicalProductionClipboardPackages = Object.freeze([
  "@mariozechner/clipboard-linux-x64-gnu",
  "@mariozechner/clipboard-linux-x64-musl",
]);

/**
 * pnpm licenses 只报告当前宿主链接的 optional native 包；生产目标固定为 Linux x64，
 * 因此必须把开发机的 Windows/macOS 变体规范化为相同的生产闭包。
 */
export function canonicalizeProductionPlatformComponents(components) {
  const platformComponents = components.filter((item) =>
    clipboardPlatformPackagePattern.test(item.name),
  );
  if (platformComponents.length === 0) return components;
  const versions = new Set(platformComponents.map((item) => item.version));
  const licenses = new Set(
    platformComponents.map((item) => item.licenses?.[0]?.license?.id).filter(Boolean),
  );
  if (versions.size !== 1 || licenses.size !== 1) {
    throw new Error("PRODUCTION_SBOM_PLATFORM_COMPONENT_CONFLICT");
  }
  const [version] = versions;
  const [license] = licenses;
  return [
    ...components.filter((item) => !clipboardPlatformPackagePattern.test(item.name)),
    ...canonicalProductionClipboardPackages.map((name) =>
      component({
        name,
        version,
        license,
        properties: { "cube:origin": "registry" },
      }),
    ),
  ];
}

function externalComponents(packageNames) {
  const components = [];
  for (const packageName of packageNames) {
    const licenseGroups = runPnpmLicenses(packageName);
    for (const [licenseGroup, entries] of Object.entries(licenseGroups)) {
      if (!Array.isArray(entries)) throw new Error("PRODUCTION_SBOM_LICENSE_CLOSURE_INVALID");
      for (const entry of entries) {
        if (typeof entry.name !== "string" || !Array.isArray(entry.versions)) {
          throw new Error("PRODUCTION_SBOM_LICENSE_CLOSURE_INVALID");
        }
        const license = typeof entry.license === "string" ? entry.license : licenseGroup;
        for (const version of entry.versions) {
          if (typeof version !== "string") {
            throw new Error("PRODUCTION_SBOM_LICENSE_CLOSURE_INVALID");
          }
          components.push(
            component({
              name: entry.name,
              version,
              license,
              properties: { "cube:origin": "registry" },
            }),
          );
        }
      }
    }
  }
  return canonicalizeProductionPlatformComponents(components);
}

function uniqueSortedComponents(components) {
  const byReference = new Map();
  for (const item of components) {
    const existing = byReference.get(item["bom-ref"]);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(item)) {
      throw new Error("PRODUCTION_SBOM_COMPONENT_CONFLICT");
    }
    byReference.set(item["bom-ref"], item);
  }
  return [...byReference.values()].sort((left, right) =>
    compareCodeUnits(left["bom-ref"], right["bom-ref"]),
  );
}

export function buildCycloneDx(input) {
  const components = uniqueSortedComponents(input.components);
  const rootReference = packageUrl(input.root.name, input.root.version);
  return Object.freeze({
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: Object.freeze({
      component: Object.freeze({
        type: "application",
        "bom-ref": rootReference,
        name: input.root.name,
        version: input.root.version,
        purl: rootReference,
      }),
      tools: Object.freeze({
        components: Object.freeze([
          Object.freeze({
            type: "application",
            name: "cube-runtime-offline-sbom-generator",
            version: "1",
          }),
        ]),
      }),
      properties: sortedProperties({
        "cube:dependency-source": "pnpm production installed closure",
        "cube:generator-network": "offline",
        "cube:lockfile": "pnpm-lock.yaml",
        "cube:lockfile-sha256": input.lockfileSha256,
      }),
    }),
    components: Object.freeze(components),
    dependencies: Object.freeze([
      Object.freeze({
        ref: rootReference,
        dependsOn: Object.freeze(components.map((item) => item["bom-ref"])),
      }),
    ]),
  });
}

export function evaluateLicensePolicy(components, policy) {
  const allowed = new Set(policy.allowed ?? []);
  const denied = new Set(policy.denied ?? []);
  const issues = [];
  for (const item of components) {
    const origin = item.properties?.find((property) => property.name === "cube:origin")?.value;
    if (origin === "workspace") continue;
    const license = item.licenses?.[0]?.license?.id;
    if (typeof license !== "string") {
      issues.push(`许可证缺失：${item.name}@${item.version}`);
    } else if (denied.has(license)) {
      issues.push(`许可证明确禁止：${item.name}@${item.version}:${license}`);
    } else if (!allowed.has(license)) {
      issues.push(`许可证未经允许：${item.name}@${item.version}:${license}`);
    }
  }
  return issues.sort();
}

export function validateVendorEvidence(policy) {
  const issues = [];
  for (const [packageName, evidence] of Object.entries(policy.vendorEvidence ?? {})) {
    for (const key of ["licenseFile", "sourceFile", "patchFile"]) {
      const relativePath = evidence[key];
      const path = typeof relativePath === "string" ? join(repositoryRoot, relativePath) : "";
      if (path === "" || !existsSync(path) || readFileSync(path, "utf8").trim().length === 0) {
        issues.push(`vendor 证据缺失：${packageName}:${key}`);
      }
    }
    const sourcePath = join(repositoryRoot, evidence.sourceFile ?? "");
    if (
      existsSync(sourcePath) &&
      (!readFileSync(sourcePath, "utf8").includes(evidence.upstreamCommit ?? "missing") ||
        !readFileSync(sourcePath, "utf8").includes(evidence.localPatchId ?? "missing"))
    ) {
      issues.push(`vendor 来源或补丁登记不匹配：${packageName}`);
    }
    const vendorDirectory = dirname(sourcePath);
    const patchPath = resolve(repositoryRoot, evidence.patchFile ?? "");
    const patchRoot = resolve(vendorDirectory, "PATCHES");
    const patchText = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
    const patchedPaths = [...patchText.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gmu)].map(
      ([, left, right]) => (left === right ? left : ""),
    );
    const expectedPatchedPaths = Array.isArray(evidence.patchedFiles)
      ? [...evidence.patchedFiles].sort(compareCodeUnits)
      : [];
    if (
      !patchPath.startsWith(`${patchRoot}${sep}`) ||
      !/^CUBE-LOCAL-\d{4}-[a-z0-9-]+\.patch$/u.test(patchPath.slice(patchRoot.length + 1)) ||
      !/^[a-f0-9]{64}$/u.test(evidence.patchSha256 ?? "") ||
      !existsSync(patchPath) ||
      sha256(readFileSync(patchPath)) !== evidence.patchSha256 ||
      !patchText.startsWith(`Subject: [PATCH] ${evidence.localPatchId ?? "missing"}`) ||
      !verifyReverseApplicablePatch(patchPath) ||
      patchedPaths.includes("") ||
      JSON.stringify([...patchedPaths].sort(compareCodeUnits)) !==
        JSON.stringify(expectedPatchedPaths) ||
      expectedPatchedPaths.some(
        (path) =>
          typeof path !== "string" ||
          !path.startsWith("runtime-ts/vendor/cubesandbox-sdk/") ||
          path.includes(".."),
      )
    ) {
      issues.push(`vendor 补丁哈希不匹配：${packageName}`);
    }
    const manifestPath = join(vendorDirectory, "package.json");
    if (
      !existsSync(manifestPath) ||
      !readJson(manifestPath).version?.includes("-cube.local.") ||
      !/^[a-f0-9]{64}$/u.test(evidence.patchedTreeSha256 ?? "") ||
      canonicalVendorTreeSha256(vendorDirectory) !== evidence.patchedTreeSha256
    ) {
      issues.push(`vendor patched tree 不匹配：${packageName}`);
    }
  }
  return issues.sort();
}

export function generateProductionSboms() {
  const policy = readJson(policyPath);
  const lockfileSha256 = sha256(readFileSync(lockfilePath));
  return productionSbomTargets.map((target) => {
    const workspace = workspaceClosure(target.packageName, policy);
    const bom = buildCycloneDx({
      root: { name: workspace.rootManifest.name, version: workspace.rootManifest.version },
      components: [...workspace.components, ...externalComponents(workspace.packageNames)],
      lockfileSha256,
    });
    return Object.freeze({ target, bom, serialized: `${JSON.stringify(bom, null, 2)}\n` });
  });
}

export function validateProductionSupplyChain(input = {}) {
  const policy = readJson(policyPath);
  const generated = input.generated ?? generateProductionSboms();
  const issues = [...validateVendorEvidence(policy)];
  for (const item of generated) {
    issues.push(...evaluateLicensePolicy(item.bom.components, policy));
    const path = join(sbomDirectory, item.target.fileName);
    if (!existsSync(path) || readFileSync(path, "utf8") !== item.serialized) {
      issues.push(`CycloneDX SBOM 未复现：${item.target.id}`);
    }
  }
  return issues.sort();
}

function writeProductionSboms(generated) {
  mkdirSync(sbomDirectory, { recursive: true });
  for (const item of generated) {
    writeFileSync(join(sbomDirectory, item.target.fileName), item.serialized, "utf8");
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const generated = generateProductionSboms();
  if (process.argv.includes("--write")) writeProductionSboms(generated);
  const issues = validateProductionSupplyChain({ generated });
  if (issues.length > 0) throw new Error(issues.join("\n"));
  console.info("生产 CycloneDX SBOM 与许可证策略验证通过");
}

import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceGroups = Object.freeze([
  Object.freeze({ kind: "app", directory: join("runtime-ts", "apps") }),
  Object.freeze({ kind: "package", directory: join("runtime-ts", "packages") }),
]);
const sourceExtensions = Object.freeze([".ts", ".tsx", ".mts", ".cts"]);
const skippedDirectories = new Set(["node_modules", "dist", "coverage", ".turbo"]);
const builtinSpecifiers = new Set(builtinModules);

/**
 * 依赖方向规则。这里只列出已经确定的架构边界：违反任意一条都意味着契约层反向依赖实现、
 * 或共享代码借用应用入口。新增例外必须同步更新 docs/architecture/repository-map.md。
 */
export const workspaceDependencyRules = Object.freeze({
  /** 应用之间默认禁止依赖；仅允许被统一进程装配的路由模块。 */
  allowedAppDependencies: Object.freeze({
    "@hoox/admin-control-api": Object.freeze(["@hoox/skill-admin-api"]),
  }),
  /**
   * 运行时依赖（dependencies）的禁止边：契约与纯领域包不得依赖模型内核、Sandbox Provider
   * 或持久化实现；模型内核适配器只经 Tool Router 获得工具，不直接持有 Sandbox Provider。
   * devDependencies 只服务测试装配，不计入运行时方向。
   */
  forbiddenDependencies: Object.freeze({
    "@hoox/domain": Object.freeze(["*"]),
    "@hoox/protocol": Object.freeze(["*"]),
    "@hoox/run-contracts": Object.freeze([
      "@hoox/pi-adapter",
      "@hoox/sandbox",
      "@hoox/persistence",
      "@hoox/tool-router",
    ]),
    "@hoox/tool-router": Object.freeze(["@hoox/pi-adapter", "@hoox/persistence"]),
    "@hoox/pi-adapter": Object.freeze(["@hoox/sandbox", "@hoox/persistence"]),
    "@hoox/persistence": Object.freeze(["@hoox/pi-adapter", "@hoox/sandbox", "@hoox/tool-router"]),
    "@hoox/sandbox": Object.freeze(["@hoox/pi-adapter", "@hoox/tool-router", "@hoox/persistence"]),
  }),
});

function isTestSource(relativePath) {
  return (
    /\.(test|spec)\.[cm]?tsx?$/u.test(relativePath) ||
    relativePath.split(sep).some((segment) => segment === "testing" || segment === "__tests__") ||
    /(^|[/\\])(real-)?[\w-]*smoke\.[cm]?tsx?$/u.test(relativePath)
  );
}

function listSourceFiles(directory) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name))
        files.push(...listSourceFiles(join(directory, entry.name)));
      continue;
    }
    if (
      entry.isFile() &&
      sourceExtensions.some((extension) => entry.name.endsWith(extension)) &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

/** 只识别静态 import/export 与字符串字面量动态 import；不做完整语法分析。 */
export function extractImportSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

/** 把裸模块说明符归一为包名；相对路径、内建模块和 URL 返回 undefined。 */
export function packageNameOf(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes(":")) {
    return undefined;
  }
  if (builtinSpecifiers.has(specifier) || builtinSpecifiers.has(specifier.split("/")[0])) {
    return undefined;
  }
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

export function readWorkspaceDependencyInputs() {
  const rootManifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  const workspaces = [];
  for (const group of workspaceGroups) {
    const groupDirectory = join(repositoryRoot, group.directory);
    for (const name of readdirSync(groupDirectory).sort()) {
      const directory = join(groupDirectory, name);
      const manifestPath = join(directory, "package.json");
      try {
        if (!statSync(manifestPath).isFile()) continue;
      } catch {
        continue;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const sources = ["src", "scripts"].flatMap((child) =>
        listSourceFiles(join(directory, child)),
      );
      workspaces.push(
        Object.freeze({
          name: manifest.name,
          kind: group.kind,
          directory: relative(repositoryRoot, directory),
          manifest,
          files: Object.freeze(
            sources.map((file) =>
              Object.freeze({
                path: relative(directory, file),
                specifiers: Object.freeze(extractImportSpecifiers(readFileSync(file, "utf8"))),
              }),
            ),
          ),
        }),
      );
    }
  }
  return Object.freeze({ rootManifest, workspaces: Object.freeze(workspaces) });
}

function declaredNames(manifest, fields) {
  return new Set(fields.flatMap((field) => Object.keys(manifest[field] ?? {})));
}

export function validateWorkspaceDependencies(input, rules = workspaceDependencyRules) {
  const issues = [];
  const workspaceKinds = new Map(
    input.workspaces.map((workspace) => [workspace.name, workspace.kind]),
  );
  const rootDevelopmentNames = declaredNames(input.rootManifest, [
    "dependencies",
    "devDependencies",
  ]);

  for (const workspace of input.workspaces) {
    const runtimeNames = declaredNames(workspace.manifest, [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
    ]);
    const developmentNames = declaredNames(workspace.manifest, ["devDependencies"]);

    // 1. 未声明依赖：生产源码只能使用本包 dependencies；测试源码额外允许 devDependencies 与根工具链。
    for (const file of workspace.files) {
      const testSource = isTestSource(file.path);
      for (const specifier of file.specifiers) {
        const name = packageNameOf(specifier);
        if (name === undefined || name === workspace.name) continue;
        if (runtimeNames.has(name)) continue;
        // 纯类型包（如 mdast）只发布在 @types 下，类型擦除后不进入运行时闭包。
        const typesName = `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;
        if (runtimeNames.has(typesName) || developmentNames.has(typesName)) continue;
        if (testSource && (developmentNames.has(name) || rootDevelopmentNames.has(name))) continue;
        issues.push(`${workspace.directory}/${file.path} 导入了未声明的依赖 ${name}`);
      }
    }

    const runtimeDependencyNames = declaredNames(workspace.manifest, ["dependencies"]);
    // 2. 依赖方向：以 package.json 声明为准，避免只靠导入扫描漏掉“声明但暂未使用”的反向边。
    const internalDependencies = [
      ...declaredNames(workspace.manifest, ["dependencies", "devDependencies"]),
    ]
      .filter((name) => workspaceKinds.has(name))
      .sort();
    for (const dependency of internalDependencies) {
      const dependencyKind = workspaceKinds.get(dependency);
      if (dependencyKind === "app") {
        const allowed = rules.allowedAppDependencies[workspace.name] ?? [];
        if (workspace.kind === "package") {
          issues.push(`共享包 ${workspace.name} 不得依赖应用 ${dependency}`);
        } else if (!allowed.includes(dependency)) {
          issues.push(`应用 ${workspace.name} 不得依赖应用 ${dependency}`);
        }
      }
      const forbidden = rules.forbiddenDependencies[workspace.name] ?? [];
      if (
        runtimeDependencyNames.has(dependency) &&
        (forbidden.includes("*") || forbidden.includes(dependency))
      ) {
        issues.push(`${workspace.name} 不得依赖 ${dependency}`);
      }
    }
  }

  return [...new Set(issues)].sort();
}

export function validateWorkspaceDependencyContract() {
  return validateWorkspaceDependencies(readWorkspaceDependencyInputs());
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const issues = validateWorkspaceDependencyContract();
  if (issues.length > 0) throw new Error(issues.join("\n"));
  console.info("Workspace 依赖声明与依赖方向验证通过");
}

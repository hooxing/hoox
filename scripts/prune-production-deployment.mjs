import { lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";
import process from "node:process";

const serviceEntries = Object.freeze({
  api: "dist/production-main.js",
  scheduler: "dist/production-main.js",
  worker: "dist/production-main.js",
});

const [targetArgument, service] = process.argv.slice(2);
if (targetArgument === undefined || service === undefined || !(service in serviceEntries)) {
  throw new Error("PRODUCTION_DEPLOY_PRUNE_ARGUMENT_INVALID");
}

const target = resolve(targetArgument);
if (!isAbsolute(targetArgument) || target === parse(target).root) {
  throw new Error("PRODUCTION_DEPLOY_PRUNE_TARGET_INVALID");
}

const rootPackagePath = join(target, "package.json");
const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
const expectedPackages = Object.freeze({
  api: "@hoox/api",
  scheduler: "@hoox/scheduler",
  worker: "@hoox/agent-worker",
});
if (
  rootPackage.name !== expectedPackages[service] ||
  Object.keys(rootPackage.devDependencies ?? {}).length > 0
) {
  throw new Error("PRODUCTION_DEPLOY_PACKAGE_INVALID");
}

const removableDirectoryNames = new Set([
  ".github",
  "__tests__",
  "coverage",
  "test",
  "testing",
  "tests",
  "integration",
]);
const workspaceSourceDirectoryNames = new Set(["scripts", "src"]);

function isWorkspacePackage(directory) {
  const manifestPath = join(directory, "package.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return (
      typeof manifest.name === "string" &&
      (manifest.name.startsWith("@hoox/") || manifest.name === "@cubesandbox/sdk")
    );
  } catch {
    return false;
  }
}

function shouldRemoveFile(name) {
  return (
    name === ".tsbuildinfo" ||
    name === "package-lock.json" ||
    /^tsconfig(?:\.[^.]+)?\.json$/u.test(name) ||
    /(?:^|\.)vitest\.config\.[^.]+$/u.test(name) ||
    /(?:^|\.)tsup\.config\.[^.]+$/u.test(name) ||
    /\.(?:test|spec)\.[^.]+(?:\.map)?$/u.test(name) ||
    /\.(?:cts|mts|ts|tsx)$/u.test(name) ||
    /\.d\.(?:cts|mts|ts)(?:\.map)?$/u.test(name) ||
    /\.(?:cts|mts|ts|tsx)\.map$/u.test(name) ||
    /\.js\.map$/u.test(name)
  );
}

function pruneDirectory(directory, workspacePackage) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (
        removableDirectoryNames.has(entry.name) ||
        (workspacePackage && workspaceSourceDirectoryNames.has(entry.name))
      ) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      pruneDirectory(path, isWorkspacePackage(path));
      continue;
    }
    if (entry.isFile() && shouldRemoveFile(entry.name)) rmSync(path, { force: true });
  }
}

pruneDirectory(target, true);

const developmentEntries =
  service === "api"
    ? ["development-main", "development-identity-main"]
    : service === "worker"
      ? ["development-main", "development-preflight-main"]
      : [];
for (const developmentEntry of developmentEntries) {
  for (const extension of ["js", "js.map", "d.ts", "d.ts.map"]) {
    rmSync(join(target, "dist", `${developmentEntry}.${extension}`), { force: true });
  }
}

rootPackage.scripts = Object.freeze({
  "start:production": `node ${serviceEntries[service]}`,
});
delete rootPackage.devDependencies;
writeFileSync(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`, "utf8");

const forbiddenBins = ["biome", "tsc", "tsx", "vitest"];
for (const command of forbiddenBins) {
  for (const suffix of ["", ".cmd", ".ps1"]) {
    try {
      lstatSync(join(target, "node_modules", ".bin", `${command}${suffix}`));
      throw new Error("PRODUCTION_DEPLOY_DEV_TOOL_PRESENT");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

const forbiddenNames = [];
function auditDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (removableDirectoryNames.has(entry.name)) forbiddenNames.push(path);
      auditDirectory(path);
    } else if (entry.isFile() && shouldRemoveFile(entry.name)) {
      forbiddenNames.push(path);
    }
  }
}
auditDirectory(target);

if (forbiddenNames.length > 0 || !lstatSync(join(target, serviceEntries[service])).isFile()) {
  throw new Error("PRODUCTION_DEPLOY_PRUNE_INCOMPLETE");
}

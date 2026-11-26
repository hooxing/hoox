import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../../", import.meta.url);
const versionPattern = /^\d+\.\d+\.\d+(?:-[\dA-Za-z.-]+)?(?:\+[\dA-Za-z.-]+)?$/u;
const shaPattern = /^(?:[\da-f]{40}|[\da-f]{64})$/iu;

function read<T>(source: () => T): T | undefined {
  try {
    return source();
  } catch {
    return undefined;
  }
}

function version(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 128 && versionPattern.test(value)
    ? value
    : undefined;
}

function sha(value: string | undefined): string | undefined {
  return value !== undefined && shaPattern.test(value) ? value.toLowerCase() : undefined;
}

export function resolveBuildInfo(environment: NodeJS.ProcessEnv, now = new Date()) {
  const buildVersion =
    version(environment.HOOX_BUILD_VERSION?.trim()) ??
    read(() => version(JSON.parse(readFileSync(new URL("package.json", root), "utf8")).version));
  const buildSha =
    sha(environment.HOOX_BUILD_SHA?.trim()) ??
    read(() =>
      sha(
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: fileURLToPath(root),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1_000,
        }).trim(),
      ),
    );
  const timestamp = environment.HOOX_BUILD_TIME;
  // Docker 可显式传空值来保留「未知」，不把墙钟时间写进可复现的产物。
  const builtAt =
    timestamp === undefined
      ? now.toISOString()
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(timestamp)
        ? read(() => new Date(timestamp).toISOString())
        : undefined;
  return { version: buildVersion ?? "dev", sha: buildSha ?? "unknown", builtAt };
}

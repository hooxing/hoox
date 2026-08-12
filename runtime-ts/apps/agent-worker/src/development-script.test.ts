import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

function manifest(): PackageManifest {
  return JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageManifest;
}

describe("Agent Worker 开发启动脚本", () => {
  it("包级 dev 在启动进程前编译当前 Worker，禁止直接加载陈旧 dist", () => {
    expect(manifest().scripts?.dev).toBe(
      "tsc -p tsconfig.json && node --env-file-if-exists=../../../.env dist/development-main.js",
    );
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function repositoryFile(path: string): string {
  return readFileSync(`${repositoryRoot}${path}`, "utf8");
}

describe("process-runtime 最小容器打包", () => {
  it("复制 index.js 导出的全部运行时模块", () => {
    const index = repositoryFile("runtime-ts/packages/process-runtime/src/index.ts");
    const dockerfile = repositoryFile("Dockerfile.process-gate");
    const exportedModules = [...index.matchAll(/export \* from "\.\/([^"]+)\.js";/gu)].map(
      (match) => match[1],
    );

    expect(exportedModules.length).toBeGreaterThan(0);
    for (const moduleName of exportedModules) {
      expect(dockerfile).toContain(
        `COPY runtime-ts/packages/process-runtime/dist/${moduleName}.js ./process-runtime/${moduleName}.js`,
      );
    }
  });
});

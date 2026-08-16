import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

function readText(path: string): string {
  return readFileSync(new URL(path, root), "utf8");
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readText(path)) as Record<string, unknown>;
}

function workspaceManifestPaths(): readonly string[] {
  return ["runtime-ts/apps", "runtime-ts/packages"].flatMap((directory) =>
    readdirSync(new URL(directory, root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${directory}/${entry.name}/package.json`),
  );
}

describe("AISay Runtime 项目身份契约", () => {
  it("根包与所有第一方 Workspace 包使用统一的新身份", () => {
    expect(readJson("package.json").name).toBe("aisay-runtime");

    for (const path of workspaceManifestPaths()) {
      const manifest = readJson(path);
      expect(manifest.name, path).toMatch(/^@aisay\/[a-z0-9-]+$/u);
      expect(JSON.stringify(manifest), path).not.toContain("@cube-runtime/");
    }

    expect(readJson("runtime-ts/vendor/deepseek-trajectory/package.json").name).toBe(
      "@aisay/vendor-deepseek-trajectory",
    );
  });

  it("部署身份切换到 AISay，但保留 CubeSandbox Provider 契约", () => {
    expect(readText("docker-compose.dev.yml")).toContain("name: aisay-runtime-dev");
    expect(readText("docker-compose.dev.yml")).toContain("name: aisay-runtime-minio-data");
    expect(readText("deploy/production.env.example")).toContain("API_JWT_AUDIENCE=aisay-runtime");

    const sandboxManifest = readJson("runtime-ts/packages/sandbox/package.json");
    expect(sandboxManifest.dependencies).toMatchObject({ "@cubesandbox/sdk": "workspace:*" });
    expect(readText("runtime-ts/packages/sandbox/src/config.ts")).toContain("CUBESANDBOX_API_URL");
  });

  it("第一方协议、浏览器偏好和制品属性不再使用临时 Cube 品牌", () => {
    expect(readText("runtime-ts/packages/protocol/src/schemas.ts")).toContain(
      '"aisay-iso-utc-timestamp-v1"',
    );
    expect(readText("runtime-ts/apps/web/src/team-workspace.tsx")).toContain(
      '"aisay.team-switcher.expanded"',
    );
    expect(readText("runtime-ts/packages/persistence/src/postgres.ts")).toContain(
      '"aisay-runtime"',
    );
    expect(readText("scripts/production-supply-chain.mjs")).toContain('"aisay:origin"');
    expect(readText("scripts/production-supply-chain.mjs")).not.toContain('"cube:origin"');
  });
});

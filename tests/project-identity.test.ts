import { existsSync, readdirSync, readFileSync } from "node:fs";
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
      .map((entry) => `${directory}/${entry.name}/package.json`)
      .filter((path) => existsSync(new URL(path, root))),
  );
}

describe("Hoox 项目身份契约", () => {
  it("根包与所有第一方 Workspace 包使用统一身份", () => {
    expect(readJson("package.json").name).toBe("hoox");

    for (const path of workspaceManifestPaths()) {
      const manifest = readJson(path);
      expect(manifest.name, path).toMatch(/^@hoox\/[a-z0-9-]+$/u);
      expect(JSON.stringify(manifest), path).not.toContain("@cube-runtime/");
      expect(JSON.stringify(manifest), path).not.toContain("@aisay/");
    }
  });

  it("部署身份使用 Hoox，但保留 CubeSandbox Provider 契约", () => {
    expect(readText("docker-compose.dev.yml")).toContain("name: hoox-dev");
    expect(readText("docker-compose.dev.yml")).toContain("name: hoox-minio-data");
    expect(readText("deploy/production.env.example")).toContain("API_JWT_AUDIENCE=hoox-api");
    expect(readText("deploy/production.env.example")).toContain(
      "ADMIN_CONTROL_JWT_AUDIENCE=hoox-admin-control-api",
    );

    const sandboxManifest = readJson("runtime-ts/packages/sandbox/package.json");
    expect(sandboxManifest.dependencies).toMatchObject({ "@cubesandbox/sdk": "workspace:*" });
    expect(readText("runtime-ts/packages/sandbox/src/config.ts")).toContain("CUBESANDBOX_API_URL");
  });

  it("第一方协议、浏览器偏好、运行时和制品属性使用 Hoox", () => {
    expect(readText("runtime-ts/packages/protocol/src/schemas.ts")).toContain(
      '"hoox-iso-utc-timestamp-v1"',
    );
    expect(readText("runtime-ts/apps/web/src/team-workspace.tsx")).toContain(
      '"hoox.team-switcher.expanded"',
    );
    expect(readText("runtime-ts/packages/persistence/src/postgres.ts")).toContain('"hoox"');
    expect(readText("scripts/start-development.mjs")).toContain("Hoox 开发环境已全部启动");
    expect(readText("scripts/start-development.mjs")).not.toContain("Cube Runtime");
  });

  it("页面、文档和模型身份统一使用 Hoox", () => {
    expect(readText("README.md")).toContain("# Hoox");
    expect(readText("README.md")).toContain("hoox.aisay.cc");
    expect(readText("runtime-ts/apps/web/index.html")).toContain(
      "<title>Hoox — 开源、可自托管的云端 Agent 平台</title>",
    );
    expect(readText("runtime-ts/apps/admin-web/index.html")).toContain(
      "<title>Hoox 技能发布管理台</title>",
    );
    expect(readText("runtime-ts/apps/trajectory-web/src/html.ts")).toContain(
      "<title>Hoox 内部轨迹</title>",
    );
    const workspaceView = readText("runtime-ts/apps/web/src/workspace-view.tsx");
    // 白标后工作台名称来自品牌配置，未配置时的默认产品名固定为 Hoox。
    expect(workspaceView).toContain("{configuration.productName}");
    expect(workspaceView).toContain('src={HOOX_HORIZONTAL_PATH} alt="Hoox"');
    expect(readText("runtime-ts/packages/protocol/src/branding.ts")).toContain(
      'productName: "Hoox"',
    );
    expect(readText("runtime-ts/apps/web/src/brand.ts")).toContain(
      "brand/hoox-horizontal-transparent.png",
    );
    expect(readText("runtime-ts/packages/prompt-builder/src/index.ts")).toContain(
      "你是 Hoox，由 Hoox 平台托管的受控 Agent",
    );
    expect(readText("runtime-ts/packages/prompt-builder/src/index.ts")).toContain(
      "runtime-system-prompt.v16",
    );
  });
});

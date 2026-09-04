import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repositoryRoot = new URL("../", import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, repositoryRoot), "utf8");
}

function workspaceManifestPaths(): readonly string[] {
  return ["runtime-ts/apps", "runtime-ts/packages"].flatMap((directory) =>
    readdirSync(new URL(directory, repositoryRoot), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${directory}/${entry.name}/package.json`),
  );
}

describe("CI 工作流效率契约", () => {
  it("完整工程 Gate 只构建一次并复用构建结果", () => {
    const packageJson = JSON.parse(source("package.json")) as {
      scripts: Record<string, string>;
    };
    const check = packageJson.scripts.check ?? "";

    expect(check.match(/corepack pnpm build/gu)).toHaveLength(1);
    expect(check).toContain("corepack pnpm typecheck:built");
    expect(check).toContain("corepack pnpm test:built");
    expect(check).not.toContain("corepack pnpm typecheck &&");
    expect(check).not.toContain("corepack pnpm test &&");
    expect(packageJson.scripts["test:built"]).toBe("vitest run");

    expect(packageJson.scripts["typecheck:built"]).toBe(
      "tsc -p tsconfig.json && corepack pnpm --recursive --sort --if-present typecheck:built && " +
        "corepack pnpm --filter @cubesandbox/sdk typecheck",
    );

    for (const manifestPath of workspaceManifestPaths()) {
      const manifest = JSON.parse(source(manifestPath)) as { scripts?: Record<string, string> };
      const scripts = manifest.scripts ?? {};
      if (scripts.typecheck === undefined) continue;
      const regularBuildAlreadyTypechecks =
        scripts.build === "tsc -p tsconfig.json" &&
        scripts.typecheck === "tsc -p tsconfig.json --noEmit";
      if (!regularBuildAlreadyTypechecks) {
        expect(scripts["typecheck:built"], manifestPath).toBeDefined();
      }
    }
    const persistence = JSON.parse(source("runtime-ts/packages/persistence/package.json")) as {
      scripts: Record<string, string>;
    };
    expect(persistence.scripts["typecheck:built"]).toBe("tsc -p scripts/tsconfig.json");
    expect(packageJson.scripts["typecheck:built"]).toContain(
      "corepack pnpm --filter @cubesandbox/sdk typecheck",
    );
  });

  it("PR 取消过期运行而 main 保持完整，并缓存 Pi Prompt Gate 镜像", () => {
    const workflow = source(".github/workflows/ci.yml");

    expect(workflow).toContain(
      "cancel-in-progress: $" + "{{ github.event_name == 'pull_request' }}",
    );
    expect(workflow).toContain("file: Dockerfile.pi-prompt-gate");
    expect(workflow).toContain("cache-from: type=gha,scope=hoox-pi-prompt-gate");
    expect(workflow).toContain("cache-to: type=gha,mode=max,scope=hoox-pi-prompt-gate");
    expect(workflow).toContain("PI_PROMPT_GATE_IMAGE: hoox/pi-prompt-gate:$" + "{{ github.sha }}");
  });

  it("Pi Prompt 镜像只构建测试所需闭包，生产聚合 Gate 不重复供应链扫描", () => {
    const dockerfile = source("Dockerfile.pi-prompt-gate");
    const packageJson = JSON.parse(source("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(dockerfile).toContain("RUN pnpm fetch --frozen-lockfile");
    expect(dockerfile).toContain("pnpm install --offline --frozen-lockfile");
    expect(dockerfile).not.toContain("&& pnpm build");
    for (const packageName of [
      "@hoox/prompt-builder...",
      "@hoox/pi-adapter...",
      "@hoox/tool-router...",
      "@hoox/agent-worker...",
    ]) {
      expect(dockerfile).toContain(`--filter "${packageName}"`);
    }
    expect(packageJson.scripts["check:production"]).not.toContain("license:check");
  });
});

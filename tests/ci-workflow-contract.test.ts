import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repositoryRoot = new URL("../", import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, repositoryRoot), "utf8");
}

function ciJob(name: string): string {
  const workflow = source(".github/workflows/ci.yml");
  const job = new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, "mu").exec(
    workflow,
  )?.[1];
  expect(job, `CI Job ${name} 必须存在`).toBeDefined();
  return job ?? "";
}

function workspaceManifestPaths(): readonly string[] {
  return ["runtime-ts/apps", "runtime-ts/packages"].flatMap((directory) =>
    readdirSync(new URL(directory, repositoryRoot), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${directory}/${entry.name}/package.json`),
  );
}

describe("CI 工作流效率契约", () => {
  it("工程、进程与 M4 Job 独立运行，工程 Job 保留完整 clean 检查与生产配置、漏洞审计", () => {
    const engineering = ciJob("engineering-checks");
    expect(engineering).toContain("run: pnpm check:clean-workspace");
    expect(engineering).toContain(
      "run: pnpm config:check:production && pnpm security:audit:production",
    );

    for (const jobName of [
      "engineering-checks",
      "process-portability",
      "m4-development-blackbox",
    ]) {
      expect(ciJob(jobName)).not.toMatch(/^ {4}needs:/mu);
      expect(ciJob(jobName)).not.toContain("continue-on-error:");
    }
    expect(ciJob("process-portability")).toContain("pnpm test:process-runtime:clean");
    expect(ciJob("m4-development-blackbox")).toContain("pnpm test:integration:m4:clean");
  });

  it("M4 门禁先执行 Runtime 模型与模式快照，再运行完整黑盒", () => {
    const gate = ciJob("m4-development-blackbox");
    expect(gate).toContain(
      'tests/integration/postgres-core.integration.test.ts -t "PostgreSQL Runtime 模型与模式快照"',
    );
    expect(gate.indexOf("postgres-core.integration.test.ts")).toBeLessThan(
      gate.indexOf("pnpm test:integration:m4:clean"),
    );
    expect(gate).not.toContain("continue-on-error:");
  });

  it("工程基线校验只在工程检查成功时通过，失败或跳过不能绕过合并门禁", () => {
    const gate = ciJob("verify");
    expect(gate).toContain("name: 工程基线校验");
    expect(gate).toContain("if: $" + "{{ always() }}");
    expect(gate).toContain("needs: [engineering-checks]");
    expect(gate).not.toContain("continue-on-error:");
    expect(gate).toContain("ENGINEERING_RESULT: $" + "{{ needs.engineering-checks.result }}");
    expect(gate).toContain('run: test "$ENGINEERING_RESULT" = success');
  });

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

  it("PR 取消过期运行而 main 保持完整", () => {
    const workflow = source(".github/workflows/ci.yml");

    expect(workflow).toContain(
      "cancel-in-progress: $" + "{{ github.event_name == 'pull_request' }}",
    );
  });
});

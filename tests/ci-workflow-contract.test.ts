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
  it("工程和容器独立运行，保留完整 clean 检查并避免容器 Job 在宿主重复安装依赖", () => {
    const engineering = ciJob("engineering-checks");
    expect(engineering).toContain("run: pnpm check:clean-workspace");
    expect(engineering).toContain("run: pnpm test:process:container");
    expect(engineering).not.toContain("Dockerfile.pi-prompt-gate");

    for (const jobName of [
      "engineering-checks",
      "pi-prompt-gate",
      "production-static",
      "production-containers",
    ]) {
      expect(ciJob(jobName)).not.toMatch(/^ {4}needs:/mu);
      expect(ciJob(jobName)).not.toContain("continue-on-error:");
    }
    for (const jobName of ["pi-prompt-gate", "production-containers"]) {
      const job = ciJob(jobName);
      expect(job).toContain("node-version-file: .node-version");
      expect(job).not.toContain("pnpm install");
      expect(job).not.toContain("pnpm/action-setup");
      expect(job).toMatch(/run: node /u);
    }
    expect(ciJob("process-portability")).toContain("pnpm test:process-runtime:clean");
    expect(ciJob("m4-development-blackbox")).toContain("pnpm test:integration:m4:clean");
  });

  it("M4 门禁执行工具选择快照和真实迁移降级边界，不只保留未被筛选的测试", () => {
    const gate = ciJob("m4-development-blackbox");
    expect(gate).toContain(
      'tests/integration/postgres-core.integration.test.ts -t "PostgreSQL Runtime 模型与模式快照|工具选择迁移整批提交"',
    );
    expect(gate.indexOf("postgres-core.integration.test.ts")).toBeLessThan(
      gate.indexOf("pnpm test:integration:m4:clean"),
    );
    expect(gate).not.toContain("continue-on-error:");
  });

  it.each([
    {
      job: "verify",
      name: "工程基线校验",
      needs: "engineering-checks, pi-prompt-gate",
      results: ["ENGINEERING_RESULT", "PI_PROMPT_RESULT"],
    },
    {
      job: "production-gates",
      name: "Production 静态与容器 Gate",
      needs: "production-static, production-containers",
      results: ["STATIC_RESULT", "CONTAINERS_RESULT"],
    },
  ])(
    "$name 只在所有依赖成功时通过，失败或跳过不能绕过旧合并门禁",
    ({ job, name, needs, results }) => {
      const gate = ciJob(job);
      expect(gate).toContain(`name: ${name}`);
      expect(gate).toContain("if: $" + "{{ always() }}");
      expect(gate).toContain(`needs: [${needs}]`);
      expect(gate).not.toContain("continue-on-error:");
      for (const [index, dependency] of needs.split(", ").entries()) {
        expect(gate).toContain(`${results[index]}: $` + `{{ needs.${dependency}.result }}`);
      }
      expect(gate).toContain(
        `run: test "$${results[0]}" = success && test "$${results[1]}" = success`,
      );
    },
  );

  it("三个生产角色并行构建且各自缓存，Gate 检查构建输出的不可变镜像", () => {
    const containers = ciJob("production-containers");
    expect(containers).toContain("fail-fast: false");
    expect(containers).toContain("role: [api, scheduler, worker]");
    expect(containers).toContain("context: .");
    expect(containers).toContain("file: Dockerfile.production-$" + "{{ matrix.role }}-gate");
    expect(containers).toContain("load: true");
    expect(containers).toContain(
      "cache-from: type=gha,scope=hoox-production-$" + "{{ matrix.role }}",
    );
    expect(containers).toContain(
      "cache-to: type=gha,mode=max,scope=hoox-production-$" + "{{ matrix.role }}",
    );
    expect(containers).toContain("id: build");
    expect(containers).toContain("PRODUCTION_GATE_IMAGE: $" + "{{ steps.build.outputs.imageid }}");
    expect(containers).toContain("PRODUCTION_GATE_ROLE: $" + "{{ matrix.role }}");
    expect(containers).toContain(
      'run: node "scripts/production-$' + '{PRODUCTION_GATE_ROLE}-container-gate.mjs"',
    );

    const staticGate = ciJob("production-static");
    expect(staticGate).toContain("cache: pnpm");
    expect(staticGate).toContain(
      "pnpm config:check:production && pnpm security:audit:production && pnpm supply-chain:check && pnpm release:check",
    );
    expect(staticGate).not.toContain("test:production-");
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

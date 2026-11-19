import { describe, expect, it } from "vitest";
import {
  extractImportSpecifiers,
  packageNameOf,
  validateWorkspaceDependencies,
  validateWorkspaceDependencyContract,
} from "../scripts/validate-workspace-dependencies.mjs";

function workspace(
  name: string,
  kind: "app" | "package",
  dependencies: Record<string, string>,
  files: readonly { path: string; specifiers: readonly string[] }[] = [],
  devDependencies: Record<string, string> = {},
) {
  return {
    name,
    kind,
    directory: `runtime-ts/${kind === "app" ? "apps" : "packages"}/${name.slice(6)}`,
    manifest: { name, dependencies, devDependencies },
    files,
  };
}

const rootManifest = { devDependencies: { vitest: "4.1.10" } };

describe("Workspace 依赖契约", () => {
  it("仓库当前满足依赖声明与依赖方向", () => {
    expect(validateWorkspaceDependencyContract()).toEqual([]);
  });

  it("识别静态、类型、重导出与动态导入", () => {
    expect(
      extractImportSpecifiers(`
        import a from "a";
        import type { B } from "@scope/b/sub";
        export * from "./local.js";
        export { c } from "c";
        import "side-effect";
        const d = await import("d");
      `).sort(),
    ).toEqual(["./local.js", "@scope/b/sub", "a", "c", "d", "side-effect"]);
  });

  it("归一包名并忽略内建模块与相对路径", () => {
    expect(packageNameOf("@hoox/run-contracts/sandbox-port")).toBe("@hoox/run-contracts");
    expect(packageNameOf("pg/lib/x")).toBe("pg");
    expect(packageNameOf("node:fs")).toBeUndefined();
    expect(packageNameOf("fs/promises")).toBeUndefined();
    expect(packageNameOf("./x.js")).toBeUndefined();
  });

  it("生产源码使用未声明的 workspace 包时失败关闭", () => {
    const issues = validateWorkspaceDependencies({
      rootManifest,
      workspaces: [
        workspace("@hoox/sandbox", "package", {}),
        workspace("@hoox/persistence", "package", {}, [
          { path: "src/a.ts", specifiers: ["@hoox/sandbox"] },
        ]),
      ],
    });
    expect(issues).toEqual([
      "runtime-ts/packages/persistence/src/a.ts 导入了未声明的依赖 @hoox/sandbox",
    ]);
  });

  it("测试源码可使用 devDependencies 与根工具链，生产源码不可", () => {
    const issues = validateWorkspaceDependencies({
      rootManifest,
      workspaces: [
        workspace(
          "@hoox/x",
          "package",
          {},
          [
            { path: "src/a.test.ts", specifiers: ["vitest", "fixture-lib"] },
            { path: "src/a.ts", specifiers: ["fixture-lib"] },
          ],
          { "fixture-lib": "1.0.0" },
        ),
      ],
    });
    expect(issues).toEqual(["runtime-ts/packages/x/src/a.ts 导入了未声明的依赖 fixture-lib"]);
  });

  it("纯类型包由 @types 声明满足", () => {
    const issues = validateWorkspaceDependencies({
      rootManifest,
      workspaces: [
        workspace("@hoox/web", "app", {}, [{ path: "src/a.ts", specifiers: ["mdast"] }], {
          "@types/mdast": "4.0.4",
        }),
      ],
    });
    expect(issues).toEqual([]);
  });

  it("禁止边只约束运行时依赖，测试装配可使用 devDependencies", () => {
    const issues = validateWorkspaceDependencies({
      rootManifest,
      workspaces: [
        workspace("@hoox/sandbox", "package", {}),
        workspace("@hoox/pi-adapter", "package", {}, [], { "@hoox/sandbox": "workspace:*" }),
      ],
    });
    expect(issues).toEqual([]);
    expect(
      validateWorkspaceDependencies({
        rootManifest,
        workspaces: [
          workspace("@hoox/sandbox", "package", {}),
          workspace("@hoox/pi-adapter", "package", { "@hoox/sandbox": "workspace:*" }),
        ],
      }),
    ).toEqual(["@hoox/pi-adapter 不得依赖 @hoox/sandbox"]);
  });

  it("拒绝契约层反向依赖实现与应用间依赖", () => {
    const issues = validateWorkspaceDependencies({
      rootManifest,
      workspaces: [
        workspace("@hoox/pi-adapter", "package", {}),
        workspace("@hoox/run-contracts", "package", { "@hoox/pi-adapter": "workspace:*" }),
        workspace("@hoox/api", "app", {}),
        workspace("@hoox/skill-admin-api", "app", { "@hoox/api": "workspace:*" }),
        workspace("@hoox/admin-control-api", "app", { "@hoox/skill-admin-api": "workspace:*" }),
        workspace("@hoox/memory", "package", { "@hoox/api": "workspace:*" }),
      ],
    });
    expect(issues).toEqual([
      "@hoox/run-contracts 不得依赖 @hoox/pi-adapter",
      "共享包 @hoox/memory 不得依赖应用 @hoox/api",
      "应用 @hoox/skill-admin-api 不得依赖应用 @hoox/api",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { assertDestructiveMigrationAllowed } from "../../runtime-ts/packages/persistence/src/migration-safety.js";

describe("迁移 CLI 破坏性安全门", () => {
  it.each(["production", "staging", undefined])("环境 %s 一律拒绝 down", (environment) => {
    expect(() =>
      assertDestructiveMigrationAllowed(
        ["node", "cli", "down", "--allow-destructive"],
        environment,
      ),
    ).toThrow("down 需要 --allow-destructive");
  });

  it("开发环境缺少显式开关也拒绝", () => {
    expect(() => assertDestructiveMigrationAllowed(["node", "cli", "down"], "development")).toThrow(
      "down 需要 --allow-destructive",
    );
  });

  it("只有开发或测试环境加显式开关才允许", () => {
    expect(() =>
      assertDestructiveMigrationAllowed(
        ["node", "cli", "down", "--allow-destructive"],
        "development",
      ),
    ).not.toThrow();
  });
});

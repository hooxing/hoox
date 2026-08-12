import { describe, expect, it } from "vitest";
import { mergeDevelopmentEnvironment } from "./development-environment.js";

describe("开发环境文件合并", () => {
  it("以本地 .env 覆盖长驻终端中的过期数据库配置，同时保留未声明变量", () => {
    const merged = mergeDevelopmentEnvironment(
      {
        DATABASE_TEAM_COORDINATOR_URL: "postgresql://stale.invalid/runtime",
        INHERITED_ONLY: "keep",
      },
      [
        "DATABASE_TEAM_COORDINATOR_URL=postgresql://current.invalid/runtime",
        "DATABASE_RUNTIME_ROLE=runtime_local",
      ].join("\n"),
    );

    expect(merged).toEqual({
      DATABASE_TEAM_COORDINATOR_URL: "postgresql://current.invalid/runtime",
      DATABASE_RUNTIME_ROLE: "runtime_local",
      INHERITED_ONLY: "keep",
    });
    expect(Object.isFrozen(merged)).toBe(true);
  });

  it("显式空值也覆盖继承值，让后续配置契约按缺失配置失败", () => {
    expect(
      mergeDevelopmentEnvironment(
        { DATABASE_URL: "postgresql://stale.invalid/runtime" },
        "DATABASE_URL=\n",
      ),
    ).toEqual({ DATABASE_URL: "" });
  });
});

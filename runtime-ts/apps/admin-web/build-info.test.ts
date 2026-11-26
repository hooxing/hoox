import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBuildInfo } from "./build-info.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", { spy: true });

const commit = `7654321${"a".repeat(33)}`;
const now = new Date("2026-11-26T12:00:00.000Z");

beforeEach(() => {
  vi.resetAllMocks();
});

describe("后台构建元数据", () => {
  it("优先使用显式元数据，无需 Git 或清单，时间规范化为 UTC", () => {
    expect(
      resolveBuildInfo(
        {
          HOOX_BUILD_VERSION: "1.2.3-rc.1",
          HOOX_BUILD_SHA: commit.toUpperCase(),
          HOOX_BUILD_TIME: "2026-11-26T04:00:00-08:00",
        },
        new Date("2026-11-27T12:00:00Z"),
      ),
    ).toEqual({ version: "1.2.3-rc.1", sha: commit, builtAt: now.toISOString() });
    expect(readFileSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("可选覆盖缺失或无效时读取仓库根版本与完整 Git SHA", () => {
    vi.mocked(readFileSync).mockReturnValueOnce('{"version":"0.1.0"}');
    vi.mocked(execFileSync).mockReturnValueOnce(`${commit}\n`);
    expect(resolveBuildInfo({ HOOX_BUILD_SHA: "" }, now)).toEqual({
      version: "0.1.0",
      sha: commit,
      builtAt: now.toISOString(),
    });
    expect(readFileSync).toHaveBeenCalledWith(
      new URL("../../../package.json", import.meta.url),
      "utf8",
    );
    expect(execFileSync).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], expect.any(Object));
  });

  it("没有清单和 Git 的构建仍成功；可显式省略时间", () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("no package.json");
    });
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("no git");
    });
    expect(resolveBuildInfo({ HOOX_BUILD_TIME: "" }, now)).toEqual({
      version: "dev",
      sha: "unknown",
      builtAt: undefined,
    });
  });
});

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseArgs, parseDotEnv } from "../scripts/start-development.mjs";
const launcherUrl = new URL("../scripts/start-development.mjs", import.meta.url);

const scriptUrl = new URL("../scripts/start-development.ps1", import.meta.url);

describe("跨平台开发环境启动入口", () => {
  it("解析跨平台启动参数并拒绝冲突选项", () => {
    expect(parseArgs(["--skip-build", "--no-browser"])).toMatchObject({
      skipBuild: true,
      noBrowser: true,
    });
    expect(() => parseArgs(["--core-only", "--include-skill"])).toThrow("不能同时使用");
    expect(() => parseArgs(["--unknown"])).toThrow("未知启动参数");
  });

  it("读取简单 dotenv 值并保留等号", () => {
    expect(parseDotEnv("# ignored\nA=one\nB='two=2'\nC=\"three\"")).toEqual({
      A: "one",
      B: "two=2",
      C: "three",
    });
  });

  it("按顺序构建、预检并覆盖完整核心与默认管理拓扑", async () => {
    const script = await readFile(launcherUrl, "utf8");
    expect(script).toContain('"corepack", ["pnpm", "build"]');
    expect(script).toContain("development-preflight-main.js");
    for (const entry of [
      "apps/api/",
      "apps/agent-worker/",
      "apps/scheduler/",
      "apps/admin-control-api/",
    ]) {
      expect(script).toContain(entry);
    }
    expect(script).toContain("@hoox/web");
    expect(script).toContain("@hoox/admin-web");
    expect(script).toContain("waitReady");
    expect(script).toContain("portOpen");
    expect(script).toContain('"pids.json"');
    expect(script).not.toContain("docker compose");
    expect(script).not.toContain("db:setup");
  });

  it("PowerShell 兼容入口保留 Windows PowerShell 5.1 编碼并只转发启动参数", async () => {
    const bytes = await readFile(scriptUrl);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const script = bytes.toString("utf8");
    expect(script).toContain("corepack pnpm dev:up");
    expect(script).toContain("--core-only");
    expect(script).not.toContain("Start-Process");
  });
});

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const scriptUrl = new URL("../scripts/start-development.ps1", import.meta.url);

describe("Windows development 一键启动脚本", () => {
  it("使用 Windows PowerShell 5.1 可识别的 UTF-8 BOM", async () => {
    const scriptBytes = await readFile(scriptUrl);

    expect([...scriptBytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
  it("只执行非首次启动动作并启动完整开发拓扑", async () => {
    const script = await readFile(scriptUrl, "utf8");

    expect(script).toContain("docker compose --env-file .env -f docker-compose.dev.yml up -d");
    expect(script).toContain("corepack pnpm build");
    expect(script).toContain("development-preflight-main.js");
    expect(script).toContain("runtime-ts\\apps\\api\\dist\\development-main.js");
    expect(script).toContain("runtime-ts\\apps\\agent-worker\\dist\\development-main.js");
    expect(script).toContain("runtime-ts\\apps\\scheduler\\dist\\development-main.js");
    expect(script).toContain("@aisay/web");
    expect(script).toContain("runtime-ts\\apps\\skill-admin-api\\dist\\development-main.js");
    expect(script).toContain("@aisay/admin-web");

    expect(script).not.toContain("pnpm install");
    expect(script).not.toContain("db:migrate:up");
    expect(script).not.toContain("dev:identity:provision");
  });

  it("复用已运行的 MinIO 和开发进程，只启动缺失服务", async () => {
    const script = await readFile(scriptUrl, "utf8");

    const minioProbe = script.indexOf("if (Test-HttpEndpoint -Url $minioHealthUrl)");
    const composeStart = script.indexOf(
      "docker compose --env-file .env -f docker-compose.dev.yml up -d",
    );
    expect(minioProbe).toBeGreaterThanOrEqual(0);
    expect(composeStart).toBeGreaterThan(minioProbe);
    expect(script).toContain("[复用] MinIO 已在 $s3Endpoint 运行");
    expect(script).toContain("Test-DevelopmentProcess");
    expect(script).toContain("[复用] $($service.Name) 已运行");
    expect(script).toContain("$servicesToStart += $service");
  });

  it("端口冲突时失败关闭，不会终止已有进程", async () => {
    const script = await readFile(scriptUrl, "utf8");

    expect(script).toContain("Get-NetTCPConnection -State Listen");
    expect(script).toContain("脚本不会自动终止已有进程");
    expect(script).not.toContain("Stop-Process");
  });

  it("提供双击入口并允许显式裁剪启动范围", async () => {
    const [script, launcher] = await Promise.all([
      readFile(scriptUrl, "utf8"),
      readFile(new URL("../start-development.cmd", import.meta.url), "utf8"),
    ]);

    expect(script).toContain("[switch]$CoreOnly");
    expect(script).toContain("[switch]$SkipBuild");
    expect(script).toContain("[switch]$NoBrowser");
    expect(launcher).toContain("scripts\\start-development.ps1");
  });
});

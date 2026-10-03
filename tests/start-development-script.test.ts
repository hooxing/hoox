import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const scriptUrl = new URL("../scripts/start-development.ps1", import.meta.url);

describe("Windows development 一键启动脚本", () => {
  it("使用 Windows PowerShell 5.1 可识别的 UTF-8 BOM", async () => {
    const scriptBytes = await readFile(scriptUrl);

    expect([...scriptBytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("只执行非首次启动动作并启动核心开发拓扑", async () => {
    const script = await readFile(scriptUrl, "utf8");

    expect(script).toContain("corepack pnpm build");
    expect(script).toContain("development-preflight-main.js");
    expect(script).toContain("runtime-ts\\apps\\api\\dist\\development-main.js");
    expect(script).toContain("runtime-ts\\apps\\agent-worker\\dist\\development-main.js");
    expect(script).toContain("runtime-ts\\apps\\scheduler\\dist\\development-main.js");
    expect(script).toContain("@hoox/web");
    expect(script).toContain('Start-Process "http://127.0.0.1:4173/app"');

    expect(script).not.toContain("docker compose");
    expect(script).not.toContain("pnpm install");
    expect(script).not.toContain("db:migrate:up");
    expect(script).not.toContain("dev:identity:provision");
  });

  it("只检查 .env 外部依赖，不负责启动或修改外部服务", async () => {
    const script = await readFile(scriptUrl, "utf8");

    expect(script).toContain("检查 .env 配置的 PostgreSQL、S3、CubeSandbox 与模型服务");
    expect(script).toContain("development-preflight-main.js");
    expect(script).not.toContain("docker compose");
    expect(script).not.toContain("docker-compose.dev.yml");
  });

  it("交互询问平台管理服务且空回答默认不启动", async () => {
    const script = await readFile(scriptUrl, "utf8");

    expect(script).toContain("[switch]$IncludeSkill");
    expect(script).toContain("Read-Host $skillPrompt");
    expect(script).toContain("是否启动平台管理服务（Skill、Control 与 Admin Web）？[y/N]");
    expect(script).toContain('$skillAnswer.Trim() -match "^(y|yes|1|是)$"');
    expect(script).toContain("if ($startSkillServices)");
    expect(script).toContain("@hoox/admin-web");
    expect(script).toContain(
      String.raw`runtime-ts\apps\admin-control-api\dist\development-main.js`,
    );
    expect(script).toContain("ADMIN_CONTROL_LISTEN_PORT");
  });

  it("复用已运行的应用进程，只启动缺失服务", async () => {
    const script = await readFile(scriptUrl, "utf8");

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

  it("提供双击入口和非交互启动参数", async () => {
    const [script, launcher] = await Promise.all([
      readFile(scriptUrl, "utf8"),
      readFile(new URL("../start-development.cmd", import.meta.url), "utf8"),
    ]);

    expect(script).toContain("[switch]$CoreOnly");
    expect(script).toContain("[switch]$IncludeSkill");
    expect(script).toContain("[switch]$SkipBuild");
    expect(script).toContain("[switch]$NoBrowser");
    expect(launcher).toContain("scripts\\start-development.ps1");
  });
});

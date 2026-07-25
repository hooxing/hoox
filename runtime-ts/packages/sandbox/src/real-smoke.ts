import { cubeConfigFromEnv } from "./config.js";
import { CubeSandboxGateway } from "./cube-gateway.js";
import type { SandboxHandle } from "./types.js";

if (process.env.REAL_CUBE_SMOKE !== "1") {
  throw new Error("真实冒烟默认关闭；请显式设置 REAL_CUBE_SMOKE=1");
}

const config = cubeConfigFromEnv(process.env);
const gateway = new CubeSandboxGateway({ ...config, defaultOperationTimeoutMs: 90_000 });
let active: SandboxHandle | undefined;

try {
  console.log("[1/8] 创建 Sandbox");
  active = await gateway.create({ templateId: config.templateId, ttlSeconds: 120 });

  console.log("[2/8] 执行命令");
  const command = await active.command("printf cube-command-ok");
  assertEqual(command.exitCode, 0, "命令退出码");
  assertEqual(command.stdout, "cube-command-ok", "命令输出");

  console.log("[3/8] 执行 runCode 并建立内存变量");
  const code = await active.runCode("cube_value = 41\ncube_value + 1", { language: "python" });
  assertEqual(code.text, "42", "runCode 结果");

  console.log("[4/8] 写入并读取文件");
  const path = `/tmp/agent-runtime-smoke-${Date.now()}.txt`;
  await active.writeFile(path, "cube-file-ok");
  assertEqual(await active.readFile(path), "cube-file-ok", "文件内容");

  console.log("[5/8] 暂停 Sandbox");
  const sandboxId = active.id;
  await active.pause({ timeoutMs: 90_000 });

  console.log("[6/8] connect 自动恢复 Sandbox");
  active = await gateway.connect(sandboxId, { timeoutMs: 90_000 });

  console.log("[7/8] 恢复后验证内存、文件和命令");
  const resumedCode = await active.runCode("cube_value + 2", { language: "python" });
  assertEqual(resumedCode.text, "43", "暂停恢复后的变量");
  assertEqual(await active.readFile(path), "cube-file-ok", "暂停恢复后的文件");
  assertEqual(
    (await active.command("printf cube-resumed-ok")).stdout,
    "cube-resumed-ok",
    "恢复后命令",
  );

  console.log("[8/8] 冒烟通过，进入 finally 清理");
} finally {
  // 真实环境里不能依赖测试断言走到最后；任何中途异常都必须清理资源。
  if (active) await active.kill({ ignoreNotFound: true, timeoutMs: 90_000 });
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}不符合预期`);
}

import { EnvironmentConfigurationError } from "@hoox/process-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startProcess, selectEnvironment, loadEnvironment } = vi.hoisted(() => ({
  startProcess: vi.fn(),
  selectEnvironment: vi.fn(),
  loadEnvironment: vi.fn(),
}));

vi.mock("./process-entry.js", () => ({
  startSchedulerProcess: startProcess,
  selectSchedulerProcessEnvironment: selectEnvironment,
}));
vi.mock("@hoox/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hoox/process-runtime")>()),
  loadDevelopmentEnvironment: loadEnvironment,
}));

const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  loadEnvironment.mockResolvedValue({});
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe.each([
  ["development", "开发"],
  ["production", "生产"],
])("Scheduler %s 启动失败日志", (runtimeEnvironment, label) => {
  async function runMain() {
    selectEnvironment.mockReturnValue({ RUNTIME_ENV: runtimeEnvironment });
    if (runtimeEnvironment === "development") await import("./development-main.js");
    else await import("./production-main.js");
  }

  it.each(["MISSING", "INVALID"] as const)(
    "输出 %s 的变量名与稳定分类，不输出值或堆栈",
    async (code) => {
      startProcess.mockRejectedValue(
        new EnvironmentConfigurationError([
          { code, key: "S3_SECRET_ACCESS_KEY" },
          { code, key: "S3_FORCE_PATH_STYLE" },
        ]),
      );
      await runMain();
      expect(process.exitCode).toBe(1);
      expect(console.error).toHaveBeenCalledExactlyOnceWith(
        `Scheduler ${label}进程启动失败：环境配置无效：${code}:S3_FORCE_PATH_STYLE,${code}:S3_SECRET_ACCESS_KEY`,
      );
    },
  );

  it("非配置异常仍隐藏底层错误和秘密", async () => {
    startProcess.mockRejectedValue(
      new Error("s3-secret-canary postgres://user:password@invalid/db"),
    );
    await runMain();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(`Scheduler ${label}进程启动失败`);
  });
});

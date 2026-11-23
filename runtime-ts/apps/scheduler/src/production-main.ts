import { EnvironmentConfigurationError } from "@hoox/process-runtime";
import { selectSchedulerProcessEnvironment, startSchedulerProcess } from "./process-entry.js";

try {
  const environment = selectSchedulerProcessEnvironment(process.env);
  if (environment.RUNTIME_ENV !== "production") throw new Error("PRODUCTION_SCHEDULER_ONLY");
  const running = await startSchedulerProcess({
    environment,
    onShutdownFailure: () => {
      // 只输出稳定分类，不能把数据库、Cube 或 S3 凭据写入日志。
      console.error("Scheduler 生产进程关闭失败");
    },
  });
  const readiness = await running.readiness();
  if (
    readiness.status !== "ready" &&
    readiness.failedChecks.some((name) => name !== "sandbox-providers")
  ) {
    await running.close();
    throw new Error("SCHEDULER_NOT_READY");
  }
  if (readiness.status !== "ready") console.info("Scheduler 等待沙箱配置；保存配置后自动就绪");
  console.info("Scheduler 生产进程已启动");
} catch (error) {
  console.error(
    error instanceof EnvironmentConfigurationError
      ? `Scheduler 生产进程启动失败：${error.message}`
      : "Scheduler 生产进程启动失败",
  );
  process.exitCode = 1;
}

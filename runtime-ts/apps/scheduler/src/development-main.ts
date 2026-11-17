import { loadDevelopmentEnvironment } from "@hoox/process-runtime";
import { selectSchedulerProcessEnvironment, startSchedulerProcess } from "./process-entry.js";

try {
  const environment = selectSchedulerProcessEnvironment(
    await loadDevelopmentEnvironment(process.env, new URL("../../../../.env", import.meta.url)),
  );
  if (environment.RUNTIME_ENV !== "development") throw new Error("DEVELOPMENT_SCHEDULER_ONLY");
  const running = await startSchedulerProcess({
    environment,
    onShutdownFailure: () => {
      console.error("Scheduler 开发进程关闭失败");
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
  console.info("Scheduler 开发进程已启动");
} catch {
  // 入口只输出稳定分类，不能泄露数据库或 Cube 配置。
  console.error("Scheduler 开发进程启动失败");
  process.exitCode = 1;
}

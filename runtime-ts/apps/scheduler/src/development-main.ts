import { selectSchedulerProcessEnvironment, startSchedulerProcess } from "./process-entry.js";

try {
  const environment = selectSchedulerProcessEnvironment(process.env);
  if (environment.RUNTIME_ENV !== "development") throw new Error("DEVELOPMENT_SCHEDULER_ONLY");
  const running = await startSchedulerProcess({
    environment,
    onShutdownFailure: () => {
      console.error("Scheduler 开发进程关闭失败");
    },
  });
  if ((await running.readiness()).status !== "ready") {
    await running.close();
    throw new Error("SCHEDULER_NOT_READY");
  }
  console.info("Scheduler 开发进程已启动");
} catch {
  // 入口只输出稳定分类，不能泄露数据库或 Cube 配置。
  console.error("Scheduler 开发进程启动失败");
  process.exitCode = 1;
}

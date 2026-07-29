import { selectWorkerProcessEnvironment, startWorkerProcess } from "./process-entry.js";

try {
  const environment = selectWorkerProcessEnvironment(process.env);
  if (environment.RUNTIME_ENV !== "production") throw new Error("PRODUCTION_WORKER_ONLY");
  const running = await startWorkerProcess({
    environment,
    onShutdownFailure: () => {
      // 入口只输出稳定类别，不能把配置、连接串或外部错误写入部署日志。
      console.error("Agent Worker 生产进程关闭失败");
    },
  });
  if ((await running.readiness()).status !== "ready") {
    await running.close();
    throw new Error("AGENT_WORKER_NOT_READY");
  }
  console.info("Agent Worker 生产进程已启动");
} catch {
  console.error("Agent Worker 生产进程启动失败");
  process.exitCode = 1;
}

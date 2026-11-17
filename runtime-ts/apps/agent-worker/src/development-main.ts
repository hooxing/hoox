import { loadDevelopmentEnvironment } from "@hoox/process-runtime";
import { selectWorkerProcessEnvironment, startWorkerProcess } from "./process-entry.js";

try {
  const environment = selectWorkerProcessEnvironment(
    await loadDevelopmentEnvironment(process.env, new URL("../../../../.env", import.meta.url)),
  );
  if (environment.RUNTIME_ENV !== "development") {
    throw new Error("DEVELOPMENT_WORKER_ONLY");
  }
  const running = await startWorkerProcess({
    environment,
    onShutdownFailure: () => {
      console.error("Agent Worker 开发进程关闭失败");
    },
  });
  const readiness = await running.readiness();
  if (
    readiness.status !== "ready" &&
    readiness.failedChecks.some((name) => name !== "model-runtime" && name !== "sandbox")
  ) {
    await running.close();
    throw new Error("AGENT_WORKER_NOT_READY");
  }
  if (readiness.status !== "ready")
    console.info("Agent Worker 等待模型或沙箱配置；配置完成后会自动开始领取任务");
  console.info("Agent Worker 开发进程已启动");
} catch {
  // 入口只输出稳定信息，避免把模型 key、Provider body 或连接串写入控制台。
  console.error("Agent Worker 开发进程启动失败");
  process.exitCode = 1;
}

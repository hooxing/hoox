import { selectApiProcessEnvironment, startApiProcess } from "./process-entry.js";

try {
  const environment = selectApiProcessEnvironment(process.env);
  if (environment.RUNTIME_ENV !== "production") throw new Error("PRODUCTION_API_ONLY");
  const running = await startApiProcess({
    environment,
    onShutdownFailure: () => {
      // 入口只输出稳定分类，不能把 TLS 文件、连接串、JWT 密钥或外部错误写入部署日志。
      console.error("API 生产进程关闭失败");
    },
  });
  if ((await running.readiness()).status !== "ready") {
    await running.close();
    throw new Error("API_NOT_READY");
  }
  console.info("API 生产进程已启动");
} catch {
  console.error("API 生产进程启动失败");
  process.exitCode = 1;
}

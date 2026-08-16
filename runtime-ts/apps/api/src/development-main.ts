import { loadDevelopmentEnvironment } from "@aisay/process-runtime";
import { selectApiProcessEnvironment, startApiProcess } from "./process-entry.js";

try {
  const environment = selectApiProcessEnvironment(
    await loadDevelopmentEnvironment(process.env, new URL("../../../../.env", import.meta.url)),
  );
  const running = await startApiProcess({
    environment,
    onShutdownFailure: () => {
      console.error("API 开发进程关闭失败");
    },
  });
  if ((await running.readiness()).status !== "ready") {
    await running.close();
    throw new Error("API_NOT_READY");
  }
  console.info("API 开发进程已启动");
} catch {
  // 入口只输出稳定信息；配置、数据库驱动异常和秘密值都不能进入控制台。
  console.error("API 开发进程启动失败");
  process.exitCode = 1;
}

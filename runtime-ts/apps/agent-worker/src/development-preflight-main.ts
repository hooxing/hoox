import { loadDevelopmentEnvironment } from "@aisay/process-runtime";
import {
  parseWorkerProcessEnvironment,
  probeDevelopmentWorkerDependencies,
  selectWorkerProcessEnvironment,
} from "./process-entry.js";

try {
  const environment = selectWorkerProcessEnvironment(
    await loadDevelopmentEnvironment(process.env, new URL("../../../../.env", import.meta.url)),
  );
  if (environment.RUNTIME_ENV !== "development") {
    throw new Error("DEVELOPMENT_WORKER_ONLY");
  }
  const configuration = parseWorkerProcessEnvironment(environment);
  await probeDevelopmentWorkerDependencies(configuration);
  console.info("Agent Worker 开发预检通过");
} catch {
  // 和常驻入口相同，只公开稳定结果，不能意外泄漏 Provider 响应或凭据。
  console.error("Agent Worker 开发预检失败");
  process.exitCode = 1;
}

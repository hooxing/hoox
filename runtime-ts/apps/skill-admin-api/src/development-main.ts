import { loadDevelopmentEnvironment } from "@hoox/process-runtime";
import {
  selectSkillAdminApiProcessEnvironment,
  startSkillAdminApiProcess,
} from "./process-entry.js";

try {
  const environment = selectSkillAdminApiProcessEnvironment(
    await loadDevelopmentEnvironment(process.env, new URL("../../../../.env", import.meta.url)),
  );
  if (environment.RUNTIME_ENV === "production") throw new Error("DEVELOPMENT_SKILL_ADMIN_ONLY");
  const running = await startSkillAdminApiProcess({
    environment,
    onShutdownFailure: () => {
      console.error("Skill 管理 API 开发进程关闭失败");
    },
  });
  if ((await running.readiness()).status !== "ready") {
    await running.close();
    throw new Error("SKILL_ADMIN_API_NOT_READY");
  }
  console.info("Skill 管理 API 开发进程已启动");
} catch {
  // 入口只输出稳定分类，不能把开发 Token、数据库或对象存储凭据写入控制台。
  console.error("Skill 管理 API 开发进程启动失败");
  process.exitCode = 1;
}

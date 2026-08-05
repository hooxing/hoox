import {
  selectSkillAdminApiProcessEnvironment,
  startSkillAdminApiProcess,
} from "./process-entry.js";

try {
  const environment = selectSkillAdminApiProcessEnvironment(process.env);
  if (environment.RUNTIME_ENV !== "production") throw new Error("PRODUCTION_SKILL_ADMIN_ONLY");
  const running = await startSkillAdminApiProcess({
    environment,
    onShutdownFailure: () => {
      console.error("Skill 管理 API 生产进程关闭失败");
    },
  });
  if ((await running.readiness()).status !== "ready") {
    await running.close();
    throw new Error("SKILL_ADMIN_API_NOT_READY");
  }
  console.info("Skill 管理 API 生产进程已启动");
} catch {
  // 生产入口不得输出 JWT 密钥、TLS 路径、连接串、S3 凭据或底层驱动消息。
  console.error("Skill 管理 API 生产进程启动失败");
  process.exitCode = 1;
}

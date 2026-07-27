import { createApiPersistenceRuntime } from "@cube-runtime/persistence";
import {
  parseDevelopmentIdentityEnvironment,
  provisionDevelopmentIdentities,
  selectDevelopmentIdentityEnvironment,
} from "./development-identity.js";

async function main(): Promise<void> {
  const configuration = parseDevelopmentIdentityEnvironment(
    selectDevelopmentIdentityEnvironment(process.env),
  );
  if (
    configuration.runtimeEnvironment !== "development" ||
    configuration.principals === undefined
  ) {
    throw new Error("DEVELOPMENT_IDENTITY_PROVISIONING_FORBIDDEN");
  }

  const persistence = createApiPersistenceRuntime({
    connectionString: configuration.databaseUrl,
    schema: configuration.databaseSchema,
    applicationName: "cube-runtime-development-identity-provision",
  });
  try {
    const results = await provisionDevelopmentIdentities({
      runtimeEnvironment: configuration.runtimeEnvironment,
      principals: configuration.principals,
      tenantRepository: persistence.repositories.tenants,
    });
    const created = results.filter((result) => result.outcome === "created").length;
    const unchanged = results.length - created;
    // 只报告稳定计数，不把环境变量值或数据库连接信息写入终端。
    console.info(`开发身份初始化完成：新建 ${created}，保持不变 ${unchanged}`);
  } finally {
    await persistence.close();
  }
}

void main().catch(() => {
  console.error("开发身份初始化失败");
  process.exitCode = 1;
});

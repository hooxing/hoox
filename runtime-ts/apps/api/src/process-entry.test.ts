import { describe, expect, it } from "vitest";

import { parseApiProcessEnvironment, startApiProcess } from "./process-entry.js";

function productionEnvironment(): Record<string, string> {
  return {
    RUNTIME_ENV: "production",
    DATABASE_URL: "postgresql://runtime:credential@database/runtime",
    DATABASE_SCHEMA: "runtime",
    THREAD_CURSOR_ACTIVE_KID: "current",
    THREAD_CURSOR_SIGNING_KEYS: "current:opaque-test-value",
    DEV_AUTH_ENABLED: "false",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
  };
}

describe("API 进程入口", () => {
  it("生产配置没有真实装配器时拒绝启动", async () => {
    await expect(startApiProcess({ environment: productionEnvironment() })).rejects.toThrow(
      "ASSEMBLER_MISSING:api",
    );
  });

  it("开发身份只有显式开启且字段完整时才启用", () => {
    const incomplete = {
      ...productionEnvironment(),
      RUNTIME_ENV: "development",
      DEV_AUTH_ENABLED: "true",
    };
    expect(() => parseApiProcessEnvironment(incomplete)).toThrow("MISSING:DEV_AUTH_USER_A_ID");

    const parsed = parseApiProcessEnvironment({
      ...incomplete,
      DEV_AUTH_USER_A_ID: "user-a-local",
      DEV_AUTH_USER_A_TENANT_ID: "tenant-a-local",
      DEV_AUTH_USER_B_ID: "user-b-local",
      DEV_AUTH_USER_B_TENANT_ID: "tenant-b-local",
    });
    expect(parsed.developmentPrincipals?.[0].userId).toBe("user-a-local");
  });

  it("未知变量失败且错误不泄漏值", () => {
    const source = { ...productionEnvironment(), WRONG_SECRET: "must-not-appear" };
    expect(() => parseApiProcessEnvironment(source)).toThrow("UNKNOWN:WRONG_SECRET");
    try {
      parseApiProcessEnvironment(source);
    } catch (error) {
      expect(String(error)).not.toContain("must-not-appear");
    }
  });
});

import { tenantId, userId } from "@cube-runtime/domain";
import { describe, expect, it } from "vitest";
import { createDevelopmentAuthResolver } from "./development-auth.js";

describe("开发身份解析器", () => {
  const principals = [
    { tenantId: tenantId("tenant-a"), userId: userId("user-a") },
    { tenantId: tenantId("tenant-b"), userId: userId("user-b") },
  ] as const;

  it("只接受固定开发 Token，不接受客户端伪造租户", async () => {
    const resolver = createDevelopmentAuthResolver({
      runtimeEnvironment: "test",
      principals,
    });
    await expect(
      resolver.resolve({ authorization: "Bearer dev-user-a", requestId: "r" }),
    ).resolves.toEqual(principals[0]);
    await expect(
      resolver.resolve({ authorization: "Bearer tenant-a", requestId: "r" }),
    ).resolves.toBeUndefined();
  });

  it("生产环境不可构造", () => {
    expect(() =>
      createDevelopmentAuthResolver({ runtimeEnvironment: "production", principals }),
    ).toThrow("DEVELOPMENT_AUTH_FORBIDDEN_IN_PRODUCTION");
  });

  it("拒绝把两个隔离测试身份配置为同一 principal", () => {
    expect(() =>
      createDevelopmentAuthResolver({
        runtimeEnvironment: "test",
        principals: [principals[0], principals[0]],
      }),
    ).toThrow("不能是同一 principal");
  });
});

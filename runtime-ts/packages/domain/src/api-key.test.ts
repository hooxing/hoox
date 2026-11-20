import { describe, expect, it } from "vitest";
import { apiKeyIsActive, apiKeyMetadata, apiKeyScope } from "./api-key.js";
import { isoTimestamp } from "./ids.js";

describe("Tenant API Key 元数据", () => {
  it("拒绝未知作用域并在吊销或到期后视为无效", () => {
    expect(() => apiKeyScope("threads:admin")).toThrow();
    const now = isoTimestamp("2026-11-19T00:00:00.000Z");
    expect(apiKeyIsActive({}, now)).toBe(true);
    expect(apiKeyIsActive({ expiresAt: isoTimestamp("2026-11-18T00:00:00.000Z") }, now)).toBe(
      false,
    );
    expect(apiKeyIsActive({ revokedAt: now }, now)).toBe(false);
  });

  it("校验名称、备注、作用域集合和到期时间", () => {
    expect(() =>
      apiKeyMetadata({
        id: "key_test",
        tenantId: "tenant_test",
        integrationUserId: "int_test",
        prefix: "hoox_sk_abcd",
        name: " ",
        scopes: ["threads:read"],
        createdBy: "user_test",
        createdAt: isoTimestamp("2026-11-19T00:00:00.000Z"),
      }),
    ).toThrow();
    expect(() =>
      apiKeyMetadata({
        id: "key_test",
        tenantId: "tenant_test",
        integrationUserId: "int_test",
        prefix: "hoox_sk_abcd",
        name: "test",
        scopes: ["threads:read", "threads:read"],
        createdBy: "user_test",
        createdAt: isoTimestamp("2026-11-19T00:00:00.000Z"),
      }),
    ).toThrow();
  });
});

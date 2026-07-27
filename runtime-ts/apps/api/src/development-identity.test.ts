import {
  createPersonalTenant,
  createUser,
  isoTimestamp,
  membershipId,
  tenantId,
  userId,
} from "@cube-runtime/domain";
import type { TenantBundle, TenantRepository, TenantScope } from "@cube-runtime/persistence";
import { describe, expect, it, vi } from "vitest";
import {
  parseDevelopmentIdentityEnvironment,
  provisionDevelopmentIdentities,
  selectDevelopmentIdentityEnvironment,
} from "./development-identity.js";

const principals = [
  { userId: "user-development-a", tenantId: "tenant-development-a" },
  { userId: "user-development-b", tenantId: "tenant-development-b" },
] as const;
const now = isoTimestamp("2026-07-28T00:00:00.000Z");

function bundleFor(index: 0 | 1): TenantBundle {
  const principal = principals[index];
  const user = createUser(userId(principal.userId), now);
  const personal = createPersonalTenant({
    id: tenantId(principal.tenantId),
    ownerMembershipId: membershipId(`membership-test-${index}`),
    owner: user,
    createdAt: now,
  });
  return { user, tenant: personal.tenant, membership: personal.ownerMembership };
}

function inMemoryRepository(): TenantRepository & { readonly size: () => number } {
  const values = new Map<string, TenantBundle>();
  return {
    size: () => values.size,
    get: async (scope: TenantScope) => values.get(`${scope.tenantId}:${scope.userId}`),
    createPersonal: async (bundle: TenantBundle) => {
      const key = `${bundle.tenant.id}:${bundle.user.id}`;
      if (values.has(key)) return { outcome: "conflict" };
      values.set(key, bundle);
      return { outcome: "created" };
    },
  };
}

describe("显式开发身份初始化", () => {
  it("只要求身份初始化所需配置，不耦合 API 游标或监听配置", () => {
    const environment = {
      RUNTIME_ENV: "development",
      DATABASE_URL: "postgresql://runtime:credential@database/runtime",
      DATABASE_SCHEMA: "runtime",
      DEV_AUTH_ENABLED: "true",
      DEV_AUTH_USER_A_ID: principals[0].userId,
      DEV_AUTH_USER_A_TENANT_ID: principals[0].tenantId,
      DEV_AUTH_USER_B_ID: principals[1].userId,
      DEV_AUTH_USER_B_TENANT_ID: principals[1].tenantId,
      UNRELATED_SECRET: "不会进入解析器",
    };
    const parsed = parseDevelopmentIdentityEnvironment(
      selectDevelopmentIdentityEnvironment(environment),
    );
    expect(parsed.principals).toEqual(principals);
  });

  it.each([
    { DEV_AUTH_USER_B_ID: principals[0].userId },
    { DEV_AUTH_USER_B_TENANT_ID: principals[0].tenantId },
  ])("配置解析与 API 启动共用 A/B 隔离约束：%o", (overrides) => {
    expect(() =>
      parseDevelopmentIdentityEnvironment({
        RUNTIME_ENV: "development",
        DATABASE_URL: "postgresql://runtime:credential@database/runtime",
        DATABASE_SCHEMA: "runtime",
        DEV_AUTH_ENABLED: "true",
        DEV_AUTH_USER_A_ID: principals[0].userId,
        DEV_AUTH_USER_A_TENANT_ID: principals[0].tenantId,
        DEV_AUTH_USER_B_ID: principals[1].userId,
        DEV_AUTH_USER_B_TENANT_ID: principals[1].tenantId,
        ...overrides,
      }),
    ).toThrow("DEVELOPMENT_IDENTITIES_MUST_BE_ISOLATED");
  });

  it("首次创建两个隔离聚合，再次执行保持不变", async () => {
    const repository = inMemoryRepository();
    await expect(
      provisionDevelopmentIdentities({
        runtimeEnvironment: "development",
        principals,
        tenantRepository: repository,
        now: () => now,
      }),
    ).resolves.toEqual([
      { label: "A", outcome: "created" },
      { label: "B", outcome: "created" },
    ]);
    await expect(
      provisionDevelopmentIdentities({
        runtimeEnvironment: "development",
        principals,
        tenantRepository: repository,
        now: () => now,
      }),
    ).resolves.toEqual([
      { label: "A", outcome: "unchanged" },
      { label: "B", outcome: "unchanged" },
    ]);
    expect(repository.size()).toBe(2);
  });

  it("并发插入冲突后只有读回完全一致才视为幂等成功", async () => {
    const first = bundleFor(0);
    const second = bundleFor(1);
    const get = vi
      .fn<TenantRepository["get"]>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(second);
    const repository: TenantRepository = {
      get,
      createPersonal: vi.fn().mockResolvedValue({ outcome: "conflict" }),
    };
    await expect(
      provisionDevelopmentIdentities({
        runtimeEnvironment: "development",
        principals,
        tenantRepository: repository,
        now: () => now,
      }),
    ).resolves.toEqual([
      { label: "A", outcome: "unchanged" },
      { label: "B", outcome: "unchanged" },
    ]);
  });

  it("已存在聚合与配置不一致时失败关闭", async () => {
    const repository: TenantRepository = {
      get: vi.fn().mockResolvedValue(bundleFor(1)),
      createPersonal: vi.fn(),
    };
    await expect(
      provisionDevelopmentIdentities({
        runtimeEnvironment: "development",
        principals,
        tenantRepository: repository,
      }),
    ).rejects.toThrow("DEVELOPMENT_IDENTITY_A_CONFLICT");
    expect(repository.createPersonal).not.toHaveBeenCalled();
  });

  it("非 development、重复用户或重复租户均在写入前拒绝", async () => {
    const repository = inMemoryRepository();
    await expect(
      provisionDevelopmentIdentities({
        runtimeEnvironment: "test",
        principals,
        tenantRepository: repository,
      }),
    ).rejects.toThrow("DEVELOPMENT_IDENTITY_PROVISIONING_FORBIDDEN");
    await expect(
      provisionDevelopmentIdentities({
        runtimeEnvironment: "development",
        principals: [principals[0], { ...principals[1], tenantId: principals[0].tenantId }],
        tenantRepository: repository,
      }),
    ).rejects.toThrow("DEVELOPMENT_IDENTITIES_MUST_BE_ISOLATED");
    expect(repository.size()).toBe(0);
  });
});

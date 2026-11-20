import { describe, expect, it } from "vitest";
import {
  changeTeamMembershipRole,
  createMembership,
  createPersonalTenant,
  createTeamTenant,
  createUser,
  DomainError,
  isoTimestamp,
  membershipId,
  rehydrateThread,
  revokeMembership,
  revokeMembershipForTeamDissolution,
  rehydrateMembership,
  tenantId,
  threadId,
  userId,
} from "./index.js";

const createdAt = isoTimestamp("2026-08-09T00:00:00.000Z");

describe("团队身份领域", () => {
  it("创建团队时规范化名称并同步创建 Owner", () => {
    const owner = createUser(userId("user_owner"), createdAt);
    const created = createTeamTenant({
      id: tenantId("tenant_team"),
      ownerMembershipId: membershipId("membership_owner"),
      owner,
      displayName: "  产品团队  ",
      createdAt,
    });

    expect(created.tenant.displayName).toBe("产品团队");
    expect(created.ownerMembership.role).toBe("owner");
  });

  it("普通路径不能移除 Owner，但解散路径可以撤销全部成员", () => {
    const owner = createUser(userId("user_owner"), createdAt);
    const created = createTeamTenant({
      id: tenantId("tenant_team"),
      ownerMembershipId: membershipId("membership_owner"),
      owner,
      displayName: "产品团队",
      createdAt,
    });
    expect(() => revokeMembership(created.ownerMembership)).toThrow(DomainError);
    expect(revokeMembershipForTeamDissolution(created.tenant, created.ownerMembership).status).toBe(
      "revoked",
    );
  });

  it("允许团队成员角色变化，且拒绝修改已撤销成员", () => {
    const owner = createUser(userId("user_owner"), createdAt);
    const member = createUser(userId("user_member"), createdAt);
    const created = createTeamTenant({
      id: tenantId("tenant_team"),
      ownerMembershipId: membershipId("membership_owner"),
      owner,
      displayName: "产品团队",
      createdAt,
    });
    const active = createMembership({
      id: membershipId("membership_member"),
      tenant: created.tenant,
      user: member,
      role: "member",
      createdAt,
    });
    const admin = changeTeamMembershipRole(created.tenant, active, "admin");
    expect(admin.role).toBe("admin");
    expect(() =>
      changeTeamMembershipRole(created.tenant, revokeMembership(admin), "member"),
    ).toThrow(DomainError);
  });

  it("集成身份可作为个人租户 Member，但不能获得管理角色", () => {
    const owner = createUser(userId("user_personal_owner"), createdAt);
    const integration = createUser(userId("user_personal_integration"), createdAt, "integration");
    const created = createPersonalTenant({
      id: tenantId("tenant_personal_integration"),
      ownerMembershipId: membershipId("membership_personal_owner"),
      owner,
      createdAt,
    });
    const membership = createMembership({
      id: membershipId("membership_personal_integration"),
      tenant: created.tenant,
      user: integration,
      role: "member",
      createdAt,
    });

    expect(membership.role).toBe("member");
    expect(
      rehydrateMembership(
        {
          id: membership.id,
          tenantId: membership.tenantId,
          userId: integration.id,
          role: membership.role,
          status: membership.status,
          createdAt: membership.createdAt,
        },
        created.tenant,
        integration,
      ).role,
    ).toBe("member");
    expect(() =>
      createMembership({
        id: membershipId("membership_personal_integration_admin"),
        tenant: created.tenant,
        user: integration,
        role: "admin",
        createdAt,
      }),
    ).toThrow(DomainError);
  });

  it("成员退出后仍可反序列化其创建但归团队所有的任务", () => {
    const owner = createUser(userId("user_owner"), createdAt);
    const creator = createUser(userId("user_creator"), createdAt);
    const created = createTeamTenant({
      id: tenantId("tenant_team"),
      ownerMembershipId: membershipId("membership_owner"),
      owner,
      displayName: "产品团队",
      createdAt,
    });
    const revokedCreator = revokeMembership(
      createMembership({
        id: membershipId("membership_creator"),
        tenant: created.tenant,
        user: creator,
        role: "member",
        createdAt,
      }),
    );

    const thread = rehydrateThread(
      {
        id: threadId("thread_team_owned"),
        tenantId: created.tenant.id,
        createdByUserId: creator.id,
        title: "团队发布计划",
        status: "active",
        createdAt,
        updatedAt: createdAt,
      },
      created.tenant,
      creator,
      revokedCreator,
    );

    expect(thread.createdByUserId).toBe(creator.id);
  });
});

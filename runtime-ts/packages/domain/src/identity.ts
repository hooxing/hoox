import { assertSameTenant, domainInvariant } from "./errors.js";
import type { IsoTimestamp, MembershipId, TenantId, UserId } from "./ids.js";

export interface User {
  readonly id: UserId;
  readonly createdAt: IsoTimestamp;
}

export interface PersonalTenant {
  readonly id: TenantId;
  readonly kind: "personal";
  readonly ownerUserId: UserId;
  readonly createdAt: IsoTimestamp;
}

// 团队 Tenant 只保留领域形态，首版不开放创建入口和团队权限策略。
export interface TeamTenant {
  readonly id: TenantId;
  readonly kind: "team";
  readonly displayName: string;
  readonly createdByUserId: UserId;
  readonly createdAt: IsoTimestamp;
}

export type Tenant = PersonalTenant | TeamTenant;
export type MembershipRole = "owner" | "admin" | "member";
export type MembershipStatus = "active" | "revoked";

export interface Membership {
  readonly id: MembershipId;
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
  readonly createdAt: IsoTimestamp;
}

export function createUser(id: UserId, createdAt: IsoTimestamp): User {
  return Object.freeze({ id, createdAt });
}

export function createPersonalTenant(input: {
  readonly id: TenantId;
  readonly ownerMembershipId: MembershipId;
  readonly owner: User;
  readonly createdAt: IsoTimestamp;
}): { readonly tenant: PersonalTenant; readonly ownerMembership: Membership } {
  const tenant = Object.freeze<PersonalTenant>({
    id: input.id,
    kind: "personal",
    ownerUserId: input.owner.id,
    createdAt: input.createdAt,
  });
  const ownerMembership = Object.freeze<Membership>({
    id: input.ownerMembershipId,
    tenantId: tenant.id,
    userId: input.owner.id,
    role: "owner",
    status: "active",
    createdAt: input.createdAt,
  });
  return Object.freeze({ tenant, ownerMembership });
}

export function createMembership(input: {
  readonly id: MembershipId;
  readonly tenant: Tenant;
  readonly user: User;
  readonly role: MembershipRole;
  readonly createdAt: IsoTimestamp;
}): Membership {
  if (input.tenant.kind === "personal") {
    domainInvariant(
      input.tenant.ownerUserId === input.user.id && input.role === "owner",
      "NOT_AUTHORIZED",
      "个人租户只允许其所有者加入",
    );
  }
  return Object.freeze({
    id: input.id,
    tenantId: input.tenant.id,
    userId: input.user.id,
    role: input.role,
    status: "active",
    createdAt: input.createdAt,
  });
}

export function assertActiveMembership(tenant: Tenant, user: User, membership: Membership): void {
  assertSameTenant(tenant.id, membership.tenantId);
  domainInvariant(
    membership.userId === user.id && membership.status === "active",
    "NOT_AUTHORIZED",
    "当前用户没有有效成员资格",
  );
}

export function revokeMembership(membership: Membership): Membership {
  domainInvariant(
    membership.role !== "owner",
    "INVALID_STATE_TRANSITION",
    "不能撤销租户所有者的成员资格",
  );
  domainInvariant(membership.status === "active", "INVALID_STATE_TRANSITION", "成员资格已经失效");
  return Object.freeze({ ...membership, status: "revoked" });
}

import { sealEntity, type Entity } from "./entity.js";
import { assertSameTenant, domainInvariant } from "./errors.js";
import {
  isoTimestamp,
  membershipId,
  tenantId,
  userId,
  type IsoTimestamp,
  type MembershipId,
  type TenantId,
  type UserId,
} from "./ids.js";
import { enumValue, recordValue, stringValue } from "./validation.js";

export type UserKind = "human" | "integration";

interface UserData {
  readonly id: UserId;
  readonly kind: UserKind;
  readonly createdAt: IsoTimestamp;
}
export type User = Entity<"User", UserData>;

interface PersonalTenantData {
  readonly id: TenantId;
  readonly kind: "personal";
  readonly ownerUserId: UserId;
  readonly createdAt: IsoTimestamp;
}
export type PersonalTenant = Entity<"PersonalTenant", PersonalTenantData>;

interface TeamTenantData {
  readonly id: TenantId;
  readonly kind: "team";
  readonly displayName: string;
  readonly createdByUserId: UserId;
  readonly createdAt: IsoTimestamp;
}
export type TeamTenant = Entity<"TeamTenant", TeamTenantData>;
export type Tenant = PersonalTenant | TeamTenant;

export type MembershipRole = "owner" | "admin" | "member";
export type MembershipStatus = "active" | "revoked";
interface MembershipData {
  readonly id: MembershipId;
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
  readonly createdAt: IsoTimestamp;
}
export type Membership = Entity<"Membership", MembershipData>;

export function createUser(id: UserId, createdAt: IsoTimestamp, kind: UserKind = "human"): User {
  return sealEntity("User", { id, kind, createdAt });
}

export function rehydrateUser(snapshot: unknown): User {
  const raw = recordValue(snapshot, "User");
  const kind =
    raw.kind === undefined ? "human" : enumValue(raw, "kind", ["human", "integration"] as const);
  return createUser(
    userId(stringValue(raw, "id")),
    isoTimestamp(stringValue(raw, "createdAt")),
    kind,
  );
}

export function createPersonalTenant(input: {
  readonly id: TenantId;
  readonly ownerMembershipId: MembershipId;
  readonly owner: User;
  readonly createdAt: IsoTimestamp;
}): { readonly tenant: PersonalTenant; readonly ownerMembership: Membership } {
  const tenant = sealEntity("PersonalTenant", {
    id: input.id,
    kind: "personal" as const,
    ownerUserId: input.owner.id,
    createdAt: input.createdAt,
  });
  const ownerMembership = sealEntity("Membership", {
    id: input.ownerMembershipId,
    tenantId: tenant.id,
    userId: input.owner.id,
    role: "owner" as const,
    status: "active" as const,
    createdAt: input.createdAt,
  });
  return Object.freeze({ tenant, ownerMembership });
}

export function createTeamTenant(input: {
  readonly id: TenantId;
  readonly ownerMembershipId: MembershipId;
  readonly owner: User;
  readonly displayName: string;
  readonly createdAt: IsoTimestamp;
}): { readonly tenant: TeamTenant; readonly ownerMembership: Membership } {
  const displayName = input.displayName.trim();
  domainInvariant(
    displayName.length > 0 && displayName.length <= 200,
    "INVALID_ARGUMENT",
    "团队名称长度无效",
  );
  const tenant = sealEntity("TeamTenant", {
    id: input.id,
    kind: "team" as const,
    displayName,
    createdByUserId: input.owner.id,
    createdAt: input.createdAt,
  });
  const ownerMembership = sealEntity("Membership", {
    id: input.ownerMembershipId,
    tenantId: tenant.id,
    userId: input.owner.id,
    role: "owner" as const,
    status: "active" as const,
    createdAt: input.createdAt,
  });
  return Object.freeze({ tenant, ownerMembership });
}

export function rehydrateTenant(snapshot: unknown, relatedUser: User): Tenant {
  const raw = recordValue(snapshot, "Tenant");
  const kind = enumValue(raw, "kind", ["personal", "team"] as const);
  const id = tenantId(stringValue(raw, "id"));
  const createdAt = isoTimestamp(stringValue(raw, "createdAt"));
  if (kind === "personal") {
    const ownerUserId = userId(stringValue(raw, "ownerUserId"));
    domainInvariant(ownerUserId === relatedUser.id, "OWNERSHIP_MISMATCH", "租户所有者关联无效");
    return sealEntity("PersonalTenant", { id, kind, ownerUserId, createdAt });
  }
  const createdByUserId = userId(stringValue(raw, "createdByUserId"));
  domainInvariant(createdByUserId === relatedUser.id, "OWNERSHIP_MISMATCH", "租户创建者关联无效");
  const displayName = stringValue(raw, "displayName").trim();
  domainInvariant(
    displayName.length > 0 && displayName.length <= 200,
    "INVALID_ARGUMENT",
    "团队名称长度无效",
  );
  return sealEntity("TeamTenant", { id, kind, displayName, createdByUserId, createdAt });
}

export function createMembership(input: {
  readonly id: MembershipId;
  readonly tenant: Tenant;
  readonly user: User;
  readonly role: MembershipRole;
  readonly createdAt: IsoTimestamp;
}): Membership {
  if (input.user.kind === "integration") {
    domainInvariant(input.role === "member", "NOT_AUTHORIZED", "集成身份只能拥有 Member 权限");
  }
  if (input.tenant.kind === "personal" && input.user.kind === "human") {
    domainInvariant(
      input.tenant.ownerUserId === input.user.id && input.role === "owner",
      "NOT_AUTHORIZED",
      "个人租户只允许其所有者加入",
    );
  }
  return sealEntity("Membership", {
    id: input.id,
    tenantId: input.tenant.id,
    userId: input.user.id,
    role: input.role,
    status: "active",
    createdAt: input.createdAt,
  });
}

export function rehydrateMembership(snapshot: unknown, tenant: Tenant, user: User): Membership {
  const raw = recordValue(snapshot, "Membership");
  const restoredTenantId = tenantId(stringValue(raw, "tenantId"));
  assertSameTenant(restoredTenantId, tenant.id);
  const restoredUserId = userId(stringValue(raw, "userId"));
  domainInvariant(restoredUserId === user.id, "OWNERSHIP_MISMATCH", "成员用户关联无效");
  const role = enumValue(raw, "role", ["owner", "admin", "member"] as const);
  const status = enumValue(raw, "status", ["active", "revoked"] as const);
  if (user.kind === "integration") {
    domainInvariant(role === "member", "NOT_AUTHORIZED", "集成身份只能拥有 Member 权限");
  }
  if (tenant.kind === "personal" && user.kind === "human") {
    domainInvariant(
      user.id === tenant.ownerUserId && role === "owner" && status === "active",
      "INVALID_ARGUMENT",
      "个人租户成员快照无效",
    );
  }
  return sealEntity("Membership", {
    id: membershipId(stringValue(raw, "id")),
    tenantId: restoredTenantId,
    userId: restoredUserId,
    role,
    status,
    createdAt: isoTimestamp(stringValue(raw, "createdAt")),
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
  return sealEntity("Membership", { ...membership, status: "revoked" as const });
}

export function changeTeamMembershipRole(
  tenant: TeamTenant,
  membership: Membership,
  role: MembershipRole,
): Membership {
  assertSameTenant(tenant.id, membership.tenantId);
  domainInvariant(membership.status === "active", "INVALID_STATE_TRANSITION", "成员资格已经失效");
  return sealEntity("Membership", { ...membership, role });
}

/** 解散是唯一允许同时撤销 Owner 的路径；普通移除仍由 revokeMembership 拒绝。 */
export function revokeMembershipForTeamDissolution(
  tenant: TeamTenant,
  membership: Membership,
): Membership {
  assertSameTenant(tenant.id, membership.tenantId);
  domainInvariant(membership.status === "active", "INVALID_STATE_TRANSITION", "成员资格已经失效");
  return sealEntity("Membership", { ...membership, status: "revoked" as const });
}

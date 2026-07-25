import {
  DomainError,
  rehydrateArtifact,
  rehydrateMembership,
  rehydrateResourceVersion,
  rehydrateRun,
  rehydrateTenant,
  rehydrateThread,
  rehydrateUser,
  rehydrateWorkspaceRevision,
  type Artifact,
  type Membership,
  type Resource,
  type ResourceVersion,
  type Run,
  type Tenant,
  type Thread,
  type User,
  type Workspace,
  type WorkspaceRevision,
} from "@cube-runtime/domain";
import {
  createErrorEnvelope,
  ProtocolConstructionError,
  type ArtifactDto,
  type ErrorEnvelope,
  type MembershipDto,
  type ResourceVersionDto,
  type RunDto,
  type TenantDto,
  type ThreadDto,
  type UserDto,
  type WorkspaceRevisionDto,
} from "@cube-runtime/protocol";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export function decodeDtoJson<T extends TSchema>(schema: T, json: string): Static<T> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ProtocolConstructionError("JSON 格式无效");
  }
  if (!Value.Check(schema, value)) {
    throw new ProtocolConstructionError("DTO 未通过协议校验");
  }
  return value as Static<T>;
}

export const toUserDto = (entity: User): UserDto => ({
  id: entity.id,
  createdAt: entity.createdAt,
});
export const fromUserDto = (dto: UserDto): User => rehydrateUser(dto);

export function toTenantDto(entity: Tenant): TenantDto {
  return entity.kind === "personal"
    ? {
        id: entity.id,
        kind: entity.kind,
        ownerUserId: entity.ownerUserId,
        createdAt: entity.createdAt,
      }
    : {
        id: entity.id,
        kind: entity.kind,
        displayName: entity.displayName,
        createdByUserId: entity.createdByUserId,
        createdAt: entity.createdAt,
      };
}
export const fromTenantDto = (dto: TenantDto, relatedUser: User): Tenant =>
  rehydrateTenant(dto, relatedUser);

export const toMembershipDto = (entity: Membership): MembershipDto => ({
  id: entity.id,
  tenantId: entity.tenantId,
  userId: entity.userId,
  role: entity.role,
  status: entity.status,
  createdAt: entity.createdAt,
});
export const fromMembershipDto = (dto: MembershipDto, tenant: Tenant, user: User): Membership =>
  rehydrateMembership(dto, tenant, user);

export const toThreadDto = (entity: Thread): ThreadDto => ({
  id: entity.id,
  tenantId: entity.tenantId,
  createdByUserId: entity.createdByUserId,
  title: entity.title,
  status: entity.status,
  createdAt: entity.createdAt,
  updatedAt: entity.updatedAt,
});
export const fromThreadDto = (
  dto: ThreadDto,
  tenant: Tenant,
  user: User,
  membership: Membership,
): Thread => rehydrateThread(dto, tenant, user, membership);

export const toRunDto = (entity: Run): RunDto => ({
  id: entity.id,
  tenantId: entity.tenantId,
  threadId: entity.threadId,
  status: entity.status,
  createdAt: entity.createdAt,
  updatedAt: entity.updatedAt,
});
export const fromRunDto = (dto: RunDto, thread: Thread): Run => rehydrateRun(dto, thread);

export const toWorkspaceRevisionDto = (entity: WorkspaceRevision): WorkspaceRevisionDto => ({
  id: entity.id,
  workspaceId: entity.workspaceId,
  tenantId: entity.tenantId,
  threadId: entity.threadId,
  revisionNumber: entity.revisionNumber,
  ...(entity.parentRevisionId === undefined ? {} : { parentRevisionId: entity.parentRevisionId }),
  createdByRunId: entity.createdByRunId,
  leaseEpoch: entity.leaseEpoch,
  objectKey: entity.objectKey,
  digest: entity.digest,
  createdAt: entity.createdAt,
});
export const fromWorkspaceRevisionDto = (
  dto: WorkspaceRevisionDto,
  workspace: Workspace,
  rootRun: Run,
): WorkspaceRevision => rehydrateWorkspaceRevision(dto, workspace, rootRun);

export const toResourceVersionDto = (entity: ResourceVersion): ResourceVersionDto => ({
  id: entity.id,
  resourceId: entity.resourceId,
  tenantId: entity.tenantId,
  versionNumber: entity.versionNumber,
  ...(entity.parentVersionId === undefined ? {} : { parentVersionId: entity.parentVersionId }),
  objectKey: entity.objectKey,
  digest: entity.digest,
  mediaType: entity.mediaType,
  sizeBytes: entity.sizeBytes,
  createdAt: entity.createdAt,
});
export const fromResourceVersionDto = (
  dto: ResourceVersionDto,
  resource: Resource,
): ResourceVersion => rehydrateResourceVersion(dto, resource);

export const toArtifactDto = (entity: Artifact): ArtifactDto => ({
  id: entity.id,
  tenantId: entity.tenantId,
  threadId: entity.threadId,
  runId: entity.runId,
  resourceVersionId: entity.resourceVersionId,
  ...(entity.replacesArtifactId === undefined
    ? {}
    : { replacesArtifactId: entity.replacesArtifactId }),
  name: entity.name,
  status: entity.status,
  createdAt: entity.createdAt,
  updatedAt: entity.updatedAt,
});
export const fromArtifactDto = (
  dto: ArtifactDto,
  run: Run,
  resourceVersion: ResourceVersion,
  replaces?: Artifact,
): Artifact => rehydrateArtifact(dto, run, resourceVersion, replaces);

function assertNever(value: never): never {
  throw new ProtocolConstructionError(`未映射的领域错误码：${String(value)}`);
}

export function mapDomainError(error: unknown, requestId: unknown): ErrorEnvelope {
  if (!(error instanceof DomainError)) {
    return createErrorEnvelope(requestId, { kind: "internal" });
  }
  switch (error.code) {
    case "INVALID_ARGUMENT":
      return createErrorEnvelope(requestId, { kind: "bad_request" });
    case "NOT_AUTHORIZED":
    case "OWNERSHIP_MISMATCH":
      // 不区分跨 Tenant、无成员资格或真实不存在，避免形成存在性探针。
      return createErrorEnvelope(requestId, { kind: "not_found" });
    case "INVALID_STATE_TRANSITION":
      return createErrorEnvelope(requestId, { kind: "invalid_state" });
    case "VERSION_CONFLICT":
      return createErrorEnvelope(requestId, { kind: "conflict" });
    default:
      return assertNever(error.code);
  }
}

import { describe, expect, it } from "vitest";
import {
  acquireWorkspaceLease,
  appendResourceVersion,
  artifactId,
  createArtifact,
  createPersonalTenant,
  createResource,
  createRun,
  createThread,
  createUser,
  createWorkspace,
  DomainError,
  isoTimestamp,
  membershipId,
  prepareWorkspaceRevision,
  resourceId,
  resourceVersionId,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  transitionArtifact,
  transitionRun,
  userId,
  workspaceId,
  workspaceRevisionId,
} from "../../runtime-ts/packages/domain/src/index.js";
import {
  ArtifactDtoSchema,
  MembershipDtoSchema,
  ResourceVersionDtoSchema,
  RunDtoSchema,
  TenantDtoSchema,
  ThreadDtoSchema,
  UserDtoSchema,
  WorkspaceRevisionDtoSchema,
} from "../../runtime-ts/packages/protocol/src/index.js";
import {
  decodeDtoJson,
  fromArtifactDto,
  fromMembershipDto,
  fromResourceVersionDto,
  fromRunDto,
  fromTenantDto,
  fromThreadDto,
  fromUserDto,
  fromWorkspaceRevisionDto,
  mapDomainError,
  toArtifactDto,
  toMembershipDto,
  toResourceVersionDto,
  toRunDto,
  toTenantDto,
  toThreadDto,
  toUserDto,
  toWorkspaceRevisionDto,
} from "../../runtime-ts/packages/protocol-mapper/src/index.js";

const now = isoTimestamp("2026-07-26T00:00:00.000Z");
const runningAt = isoTimestamp("2026-07-26T00:01:00.000Z");
const leaseExpiresAt = isoTimestamp("2026-07-26T01:00:00.000Z");
const digest = sha256Digest("b".repeat(64));

function fixture() {
  const user = createUser(userId("user_mapper"), now);
  const { tenant, ownerMembership } = createPersonalTenant({
    id: tenantId("tenant_mapper"),
    ownerMembershipId: membershipId("membership_mapper"),
    owner: user,
    createdAt: now,
  });
  const thread = createThread({
    id: threadId("thread_mapper"),
    tenant,
    user,
    membership: ownerMembership,
    title: "Mapper 往返",
    now,
  });
  const run = transitionRun(
    createRun({ id: runId("run_mapper"), thread, now }),
    "running",
    runningAt,
  );
  return { user, tenant, ownerMembership, thread, run };
}

describe("Domain 与 Protocol 显式 Mapper", () => {
  it("身份、任务和运行完成 Domain→DTO→JSON→Schema→DTO→Domain 往返", () => {
    const source = fixture();
    const userDto = decodeDtoJson(UserDtoSchema, JSON.stringify(toUserDto(source.user)));
    const user = fromUserDto(userDto);
    const tenantDto = decodeDtoJson(TenantDtoSchema, JSON.stringify(toTenantDto(source.tenant)));
    const tenant = fromTenantDto(tenantDto, user);
    const membershipDto = decodeDtoJson(
      MembershipDtoSchema,
      JSON.stringify(toMembershipDto(source.ownerMembership)),
    );
    const membership = fromMembershipDto(membershipDto, tenant, user);
    const threadDto = decodeDtoJson(ThreadDtoSchema, JSON.stringify(toThreadDto(source.thread)));
    const thread = fromThreadDto(threadDto, tenant, user, membership);
    const runDto = decodeDtoJson(RunDtoSchema, JSON.stringify(toRunDto(source.run)));
    const run = fromRunDto(runDto, thread);

    expect(toUserDto(user)).toEqual(toUserDto(source.user));
    expect(toTenantDto(tenant)).toEqual(toTenantDto(source.tenant));
    expect(toMembershipDto(membership)).toEqual(toMembershipDto(source.ownerMembership));
    expect(toThreadDto(thread)).toEqual(toThreadDto(source.thread));
    expect(toRunDto(run)).toEqual(toRunDto(source.run));
  });

  it("版本和交付物往返时重新校验所有关联", () => {
    const source = fixture();
    const workspace = acquireWorkspaceLease({
      workspace: createWorkspace({
        id: workspaceId("workspace_mapper"),
        thread: source.thread,
        now,
      }),
      rootRun: source.run,
      epoch: 1,
      expiresAt: leaseExpiresAt,
      now: runningAt,
    });
    const commit = prepareWorkspaceRevision({
      workspace,
      rootRun: source.run,
      leaseEpoch: 1,
      revisionId: workspaceRevisionId("workspace_revision_mapper"),
      objectKey: "workspace/mapper.tar",
      digest,
      now: runningAt,
    });
    const revisionDto = decodeDtoJson(
      WorkspaceRevisionDtoSchema,
      JSON.stringify(toWorkspaceRevisionDto(commit.revision)),
    );
    const revision = fromWorkspaceRevisionDto(revisionDto, commit.workspace, source.run);

    const resource = createResource({
      id: resourceId("resource_mapper"),
      tenantId: source.tenant.id,
      name: "Mapper 资源",
      origin: "artifact",
      now,
    });
    const resourceResult = appendResourceVersion({
      resource,
      tenantId: source.tenant.id,
      versionId: resourceVersionId("resource_version_mapper"),
      expectedLatestVersionNumber: 0,
      objectKey: "resources/mapper",
      digest,
      mediaType: "text/plain",
      sizeBytes: 12,
      now,
    });
    const versionDto = decodeDtoJson(
      ResourceVersionDtoSchema,
      JSON.stringify(toResourceVersionDto(resourceResult.version)),
    );
    const version = fromResourceVersionDto(versionDto, resourceResult.resource);
    const published = transitionArtifact(
      createArtifact({
        id: artifactId("artifact_mapper"),
        run: source.run,
        resourceVersion: version,
        name: "Mapper 交付物",
        now,
      }),
      "published",
      runningAt,
    );
    const artifactDto = decodeDtoJson(ArtifactDtoSchema, JSON.stringify(toArtifactDto(published)));
    const artifact = fromArtifactDto(artifactDto, source.run, version);

    expect(toWorkspaceRevisionDto(revision)).toEqual(toWorkspaceRevisionDto(commit.revision));
    expect(toResourceVersionDto(version)).toEqual(toResourceVersionDto(resourceResult.version));
    expect(toArtifactDto(artifact)).toEqual(toArtifactDto(published));
  });

  it("Schema 合法但关联被篡改的 DTO 仍被 Domain 拒绝", () => {
    const source = fixture();
    const dto = { ...toRunDto(source.run), tenantId: "tenant_attacker" };
    const decoded = decodeDtoJson(RunDtoSchema, JSON.stringify(dto));
    expect(() => fromRunDto(decoded, source.thread)).toThrow("资源不属于当前租户");
  });

  it("公共错误穷尽映射且不透传领域消息", () => {
    const secret = "tenant_secret_identifier";
    const envelope = mapDomainError(
      new DomainError("OWNERSHIP_MISMATCH", `不应泄漏：${secret}`),
      "request_mapper",
    );
    expect(envelope.error.code).toBe("NOT_FOUND");
    expect(JSON.stringify(envelope)).not.toContain(secret);
  });

  it.each([
    ["INVALID_ARGUMENT", "BAD_REQUEST"],
    ["NOT_AUTHORIZED", "NOT_FOUND"],
    ["OWNERSHIP_MISMATCH", "NOT_FOUND"],
    ["INVALID_STATE_TRANSITION", "INVALID_STATE"],
    ["VERSION_CONFLICT", "CONFLICT"],
  ] as const)("领域错误 %s 集中映射为 %s", (domainCode, publicCode) => {
    expect(
      mapDomainError(new DomainError(domainCode, "内部消息"), "request_mapping").error.code,
    ).toBe(publicCode);
  });
});

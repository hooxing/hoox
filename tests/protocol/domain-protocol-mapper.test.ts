import { Value } from "@sinclair/typebox/value";
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
  mapDomainError,
  toArtifactDto,
  toMembershipDto,
  toResourceVersionDto,
  toRunDto,
  toTenantDto,
  toThreadDto,
  toUserDto,
  toWorkspaceRevisionDto,
} from "@hoox/protocol-mapper";

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
    title: "Mapper 投影",
    now,
  });
  const run = transitionRun(
    createRun({ id: runId("run_mapper"), thread, now }),
    "running",
    runningAt,
  );
  return { user, tenant, ownerMembership, thread, run };
}

describe("Domain 到 Protocol 的显式 Mapper", () => {
  it("身份、任务和运行投影符合公开 Schema", () => {
    const source = fixture();
    const projections = [
      [UserDtoSchema, toUserDto(source.user)],
      [TenantDtoSchema, toTenantDto(source.tenant)],
      [MembershipDtoSchema, toMembershipDto(source.ownerMembership)],
      [ThreadDtoSchema, toThreadDto(source.thread)],
      [RunDtoSchema, toRunDto(source.run)],
    ] as const;

    for (const [schema, dto] of projections) {
      expect(Value.Check(schema, dto)).toBe(true);
    }
  });

  it("恢复投影只增加执行状态，不改写 Domain Run 状态", () => {
    const source = fixture();
    const dto = toRunDto(source.run, "recovery_required");

    expect(Value.Check(RunDtoSchema, dto)).toBe(true);
    expect(dto).toMatchObject({ status: "running", executionStatus: "recovery_required" });
    expect(source.run.status).toBe("running");
  });

  it("版本和交付物投影符合公开 Schema", () => {
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
    const resourceResult = appendResourceVersion({
      resource: createResource({
        id: resourceId("resource_mapper"),
        tenantId: source.tenant.id,
        name: "Mapper 资源",
        origin: "artifact",
        now,
      }),
      tenantId: source.tenant.id,
      versionId: resourceVersionId("resource_version_mapper"),
      expectedLatestVersionNumber: 0,
      objectKey: "resources/mapper",
      digest,
      mediaType: "text/plain",
      sizeBytes: 12,
      now,
    });
    const published = transitionArtifact(
      createArtifact({
        id: artifactId("artifact_mapper"),
        run: source.run,
        resourceVersion: resourceResult.version,
        name: "Mapper 交付物",
        now,
      }),
      "published",
      runningAt,
    );

    expect(Value.Check(WorkspaceRevisionDtoSchema, toWorkspaceRevisionDto(commit.revision))).toBe(
      true,
    );
    expect(
      Value.Check(ResourceVersionDtoSchema, toResourceVersionDto(resourceResult.version)),
    ).toBe(true);
    expect(Value.Check(ArtifactDtoSchema, toArtifactDto(published))).toBe(true);
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
    ["INVALID_ARGUMENT", "INVALID_REQUEST"],
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

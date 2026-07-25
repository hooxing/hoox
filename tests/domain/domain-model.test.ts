import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  agentThreadId,
  appendResourceVersion,
  appendWorkspaceRevision,
  archiveThread,
  artifactId,
  createAgentTree,
  createArtifact,
  createMembership,
  createPersonalTenant,
  createPlan,
  createResource,
  createRun,
  createSandboxSession,
  createThread,
  createUser,
  createWorkspace,
  DomainError,
  isoTimestamp,
  membershipId,
  planId,
  planStepId,
  resourceId,
  resourceVersionId,
  runId,
  sandboxSessionId,
  sha256Digest,
  spawnAgentThread,
  tenantId,
  threadId,
  transitionAgentThread,
  transitionArtifact,
  transitionPlan,
  transitionPlanStep,
  transitionRun,
  transitionSandboxSession,
  userId,
  workspaceId,
  workspaceRevisionId,
  type DomainErrorCode,
  type Run,
  type RunStatus,
} from "../../runtime-ts/packages/domain/src/index.js";

const now = isoTimestamp("2026-07-26T00:00:00.000Z");
const later = isoTimestamp("2026-07-26T00:01:00.000Z");
const digest = sha256Digest("a".repeat(64));

function expectDomainError(operation: () => unknown, code: DomainErrorCode): void {
  try {
    operation();
    throw new Error("预期抛出 DomainError");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

function fixture(prefix = "one") {
  const user = createUser(userId(`usr_${prefix}`), now);
  const { tenant, ownerMembership } = createPersonalTenant({
    id: tenantId(`ten_${prefix}`),
    ownerMembershipId: membershipId(`mem_${prefix}`),
    owner: user,
    createdAt: now,
  });
  const thread = createThread({
    id: threadId(`thr_${prefix}`),
    tenant,
    user,
    membership: ownerMembership,
    title: "领域测试任务",
    now,
  });
  return { user, tenant, ownerMembership, thread };
}

describe("身份和所有权", () => {
  it.each(["", "ab", "has space", "slash/value", "a".repeat(129)])(
    "拒绝无效品牌 ID：%s",
    (value) => {
      expectDomainError(() => userId(value), "INVALID_ARGUMENT");
    },
  );

  it("个人 Tenant 自动建立唯一所有者 Membership", () => {
    const { user, tenant, ownerMembership } = fixture();
    expect(tenant).toMatchObject({ kind: "personal", ownerUserId: user.id });
    expect(ownerMembership).toMatchObject({ role: "owner", status: "active" });
    expect(Object.isFrozen(tenant)).toBe(true);
  });

  it("个人 Tenant 拒绝加入其他用户", () => {
    const { tenant } = fixture();
    const outsider = createUser(userId("usr_outsider"), now);
    expectDomainError(
      () =>
        createMembership({
          id: membershipId("mem_outsider"),
          tenant,
          user: outsider,
          role: "member",
          createdAt: now,
        }),
      "NOT_AUTHORIZED",
    );
  });

  it("Run 和 Workspace 的 Tenant 只能从 Thread 继承", () => {
    const { thread, tenant } = fixture();
    const run = createRun({ id: runId("run_one"), thread, now });
    const workspace = createWorkspace({ id: workspaceId("wsp_one"), thread, now });
    expect(run.tenantId).toBe(tenant.id);
    expect(workspace).toMatchObject({ tenantId: tenant.id, threadId: thread.id });
  });

  it("归档 Thread 后不能创建 Run 或 Workspace", () => {
    const archived = archiveThread(fixture().thread, later);
    expectDomainError(
      () => createRun({ id: runId("run_archived"), thread: archived, now: later }),
      "INVALID_STATE_TRANSITION",
    );
    expectDomainError(
      () => createWorkspace({ id: workspaceId("wsp_archived"), thread: archived, now: later }),
      "INVALID_STATE_TRANSITION",
    );
  });
});

describe("状态机", () => {
  const statuses: readonly RunStatus[] = [
    "queued",
    "running",
    "waiting",
    "succeeded",
    "failed",
    "cancelled",
  ];
  const allowed = new Set([
    "queued->running",
    "queued->cancelled",
    "running->waiting",
    "running->succeeded",
    "running->failed",
    "running->cancelled",
    "waiting->running",
    "waiting->failed",
    "waiting->cancelled",
  ]);

  it("Run 只接受状态表中声明的转换", () => {
    fc.assert(
      fc.property(fc.constantFrom(...statuses), fc.constantFrom(...statuses), (source, target) => {
        const base = createRun({ id: runId("run_state"), thread: fixture().thread, now });
        const run: Run = { ...base, status: source };
        if (allowed.has(`${source}->${target}`)) {
          expect(transitionRun(run, target, later).status).toBe(target);
        } else {
          expectDomainError(() => transitionRun(run, target, later), "INVALID_STATE_TRANSITION");
        }
      }),
    );
  });

  it("Plan 同时最多一个执行中步骤，全部结束后才能完成", () => {
    const run = transitionRun(
      createRun({ id: runId("run_plan"), thread: fixture().thread, now }),
      "running",
      later,
    );
    let plan = createPlan({
      id: planId("pln_one"),
      run,
      steps: [
        { id: planStepId("stp_one"), title: "第一步" },
        { id: planStepId("stp_two"), title: "第二步" },
      ],
      now,
    });
    plan = transitionPlan(plan, "active", later);
    plan = transitionPlanStep(plan, planStepId("stp_one"), "in_progress", later);
    expectDomainError(
      () => transitionPlanStep(plan, planStepId("stp_two"), "in_progress", later),
      "INVALID_STATE_TRANSITION",
    );
    plan = transitionPlanStep(plan, planStepId("stp_one"), "completed", later);
    plan = transitionPlanStep(plan, planStepId("stp_two"), "skipped", later);
    expect(transitionPlan(plan, "completed", later).status).toBe("completed");
  });

  it("Artifact 发布失败后允许 Agent 重试，但发布成功后终止", () => {
    const { thread, tenant } = fixture();
    const run = createRun({ id: runId("run_artifact"), thread, now });
    const resource = createResource({
      id: resourceId("res_artifact"),
      tenantId: tenant.id,
      name: "报告",
      origin: "artifact",
      now,
    });
    const { version } = appendResourceVersion({
      resource,
      tenantId: tenant.id,
      versionId: resourceVersionId("rsv_artifact"),
      expectedLatestVersionNumber: 0,
      objectKey: "artifacts/report.md",
      digest,
      mediaType: "text/markdown",
      sizeBytes: 10,
      now,
    });
    let artifact = createArtifact({
      id: artifactId("art_one"),
      run,
      resourceVersion: version,
      name: "最终报告",
      now,
    });
    artifact = transitionArtifact(artifact, "failed", later);
    artifact = transitionArtifact(artifact, "publishing", later);
    artifact = transitionArtifact(artifact, "published", later);
    expectDomainError(
      () => transitionArtifact(artifact, "publishing", later),
      "INVALID_STATE_TRANSITION",
    );
  });

  it("Sandbox 只有绑定厂商实例后才能 ready，terminated 后不可恢复", () => {
    let session = createSandboxSession({
      id: sandboxSessionId("sbx_one"),
      thread: fixture().thread,
      templateId: "tpl_one",
      now,
    });
    expectDomainError(() => transitionSandboxSession(session, "ready", later), "INVALID_ARGUMENT");
    session = transitionSandboxSession(session, "ready", later, "provider-sandbox-one");
    session = transitionSandboxSession(session, "paused", later);
    session = transitionSandboxSession(session, "terminated", later);
    expectDomainError(
      () => transitionSandboxSession(session, "ready", later),
      "INVALID_STATE_TRANSITION",
    );
  });
});

describe("不可变版本与 Agent Tree", () => {
  it("拒绝跨 Tenant 的 Workspace Revision 写入", () => {
    const first = fixture("first");
    const second = fixture("second");
    const workspace = createWorkspace({ id: workspaceId("wsp_first"), thread: first.thread, now });
    const otherRun = createRun({ id: runId("run_second"), thread: second.thread, now });
    expectDomainError(
      () =>
        appendWorkspaceRevision({
          workspace,
          run: otherRun,
          revisionId: workspaceRevisionId("wrv_first"),
          expectedCurrentRevisionNumber: 0,
          objectKey: "workspace/revision.tar",
          digest,
          now,
        }),
      "OWNERSHIP_MISMATCH",
    );
  });

  it("Workspace Revision 只追加、冻结旧版本并检测并发覆盖", () => {
    const { thread } = fixture();
    const run = createRun({ id: runId("run_workspace"), thread, now });
    const original = createWorkspace({ id: workspaceId("wsp_versions"), thread, now });
    const first = appendWorkspaceRevision({
      workspace: original,
      run,
      revisionId: workspaceRevisionId("wrv_one"),
      expectedCurrentRevisionNumber: 0,
      objectKey: "workspace/1.tar",
      digest,
      now,
    });
    const second = appendWorkspaceRevision({
      workspace: first.workspace,
      run,
      revisionId: workspaceRevisionId("wrv_two"),
      expectedCurrentRevisionNumber: 1,
      objectKey: "workspace/2.tar",
      digest,
      now: later,
    });
    expect(original.currentRevisionNumber).toBe(0);
    expect(first.revision.revisionNumber).toBe(1);
    expect(first.revision.parentRevisionId).toBeUndefined();
    expect(second.revision).toMatchObject({
      revisionNumber: 2,
      parentRevisionId: first.revision.id,
    });
    expect(Object.isFrozen(first.revision)).toBe(true);
    expectDomainError(
      () =>
        appendWorkspaceRevision({
          workspace: second.workspace,
          run,
          revisionId: workspaceRevisionId("wrv_conflict"),
          expectedCurrentRevisionNumber: 1,
          objectKey: "workspace/conflict.tar",
          digest,
          now: later,
        }),
      "VERSION_CONFLICT",
    );
  });

  it("Resource Version 和 Artifact 都拒绝跨 Tenant 组合", () => {
    const first = fixture("owner_a");
    const second = fixture("owner_b");
    const resource = createResource({
      id: resourceId("res_owned_a"),
      tenantId: first.tenant.id,
      name: "租户 A 资源",
      origin: "upload",
      now,
    });
    expectDomainError(
      () =>
        appendResourceVersion({
          resource,
          tenantId: second.tenant.id,
          versionId: resourceVersionId("rsv_wrong_owner"),
          expectedLatestVersionNumber: 0,
          objectKey: "resources/wrong",
          digest,
          mediaType: "text/plain",
          sizeBytes: 1,
          now,
        }),
      "OWNERSHIP_MISMATCH",
    );
    const secondResource = createResource({
      id: resourceId("res_owned_b"),
      tenantId: second.tenant.id,
      name: "租户 B 资源",
      origin: "artifact",
      now,
    });
    const { version } = appendResourceVersion({
      resource: secondResource,
      tenantId: second.tenant.id,
      versionId: resourceVersionId("rsv_owned_b"),
      expectedLatestVersionNumber: 0,
      objectKey: "resources/owned-b",
      digest,
      mediaType: "text/plain",
      sizeBytes: 1,
      now,
    });
    const firstRun = createRun({ id: runId("run_owned_a"), thread: first.thread, now });
    expectDomainError(
      () =>
        createArtifact({
          id: artifactId("art_wrong_owner"),
          run: firstRun,
          resourceVersion: version,
          name: "非法组合",
          now,
        }),
      "OWNERSHIP_MISMATCH",
    );
  });

  it("Resource Version 只追加且不覆盖旧快照", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (count) => {
        const { tenant } = fixture();
        let resource = createResource({
          id: resourceId("res_versions"),
          tenantId: tenant.id,
          name: "版本资源",
          origin: "upload",
          now,
        });
        const versions = [];
        for (let index = 1; index <= count; index += 1) {
          const result = appendResourceVersion({
            resource,
            tenantId: tenant.id,
            versionId: resourceVersionId(`rsv_${index}`),
            expectedLatestVersionNumber: index - 1,
            objectKey: `resources/${index}`,
            digest,
            mediaType: "text/plain",
            sizeBytes: index,
            now,
          });
          resource = result.resource;
          versions.push(result.version);
        }
        expect(resource.latestVersionNumber).toBe(count);
        expect(versions.map((version) => version.versionNumber)).toEqual(
          Array.from({ length: count }, (_, index) => index + 1),
        );
        expect(versions.every(Object.isFrozen)).toBe(true);
        expectDomainError(
          () =>
            appendResourceVersion({
              resource,
              tenantId: tenant.id,
              versionId: resourceVersionId("rsv_conflict"),
              expectedLatestVersionNumber: count - 1,
              objectKey: "resources/conflict",
              digest,
              mediaType: "text/plain",
              sizeBytes: 1,
              now,
            }),
          "VERSION_CONFLICT",
        );
      }),
    );
  });

  it("根 Agent 必须等待所有子 Agent 结束", () => {
    const run = createRun({ id: runId("run_agents"), thread: fixture().thread, now });
    let tree = createAgentTree({ run, rootId: agentThreadId("agt_root"), now });
    tree = spawnAgentThread({
      tree,
      parentId: tree.rootId,
      id: agentThreadId("agt_child"),
      now,
    });
    expectDomainError(
      () => transitionAgentThread({ tree, id: tree.rootId, target: "completed", now: later }),
      "INVALID_STATE_TRANSITION",
    );
    tree = transitionAgentThread({
      tree,
      id: agentThreadId("agt_child"),
      target: "completed",
      now: later,
    });
    expect(
      transitionAgentThread({ tree, id: tree.rootId, target: "completed", now: later }).agents[0]
        ?.status,
    ).toBe("completed");
  });
});

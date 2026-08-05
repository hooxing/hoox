import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  agentThreadId,
  appendResourceVersion,
  acquireWorkspaceLease,
  archiveThread,
  artifactId,
  createAgentTree,
  queueAgentTurn,
  createArtifact,
  createMembership,
  createPersonalTenant,
  createPlan,
  createReplacementSandboxSession,
  createResource,
  createRun,
  createSandboxSession,
  createThread,
  createUser,
  createWorkspace,
  DomainError,
  expireWorkspaceLease,
  isoTimestamp,
  membershipId,
  planId,
  planStepId,
  prepareWorkspaceRevision,
  rehydrateAgentTree,
  rehydrateArtifact,
  rehydratePlan,
  rehydrateResource,
  rehydrateRun,
  rehydrateSandboxSession,
  rehydrateWorkspace,
  releaseWorkspaceLease,
  resourceId,
  resourceVersionId,
  runId,
  sandboxSessionId,
  sha256Digest,
  spawnAgentThread,
  tenantId,
  threadId,
  transitionAgentThread,
  transitionAgentTurn,
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
const leaseExpiry = isoTimestamp("2026-07-26T01:00:00.000Z");
const afterLeaseExpiry = isoTimestamp("2026-07-26T02:00:00.000Z");
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

function runningRun(prefix = "running") {
  const { thread } = fixture(prefix);
  return transitionRun(createRun({ id: runId(`run_${prefix}`), thread, now }), "running", later);
}

describe("身份和所有权", () => {
  it.each(["", "ab", "has space", "slash/value", "a".repeat(129)])(
    "拒绝无效品牌 ID：%s",
    (value) => {
      expectDomainError(() => userId(value), "INVALID_ARGUMENT");
    },
  );

  it.each([
    "2026-02-29T00:00:00.000Z",
    "2026-04-31T00:00:00.000Z",
    "2026-13-01T00:00:00.000Z",
    "2026-01-01T24:00:00.000Z",
  ])("拒绝不存在的 UTC 日历时间：%s", (value) => {
    expectDomainError(() => isoTimestamp(value), "INVALID_ARGUMENT");
  });

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

  it("领域实体不能通过普通对象字面量伪造", () => {
    const valid = createRun({ id: runId("run_opaque"), thread: fixture().thread, now });
    // @ts-expect-error 缺少模块私有实体品牌，证明所有构造必须经过 create/rehydrate。
    const forged: Run = {
      id: valid.id,
      tenantId: valid.tenantId,
      threadId: valid.threadId,
      status: valid.status,
      createdAt: valid.createdAt,
      updatedAt: valid.updatedAt,
    };
    expect(Object.isFrozen(forged)).toBe(false);
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
        const thread = fixture().thread;
        const base = createRun({ id: runId("run_state"), thread, now });
        const run: Run = rehydrateRun({ ...base, status: source }, thread);
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

  it.each(["succeeded", "failed", "cancelled"] as const)(
    "终态 Run（%s）不能新建 Plan、AgentTree 或 Artifact",
    (status) => {
      const { thread, tenant } = fixture(`terminal_${status}`);
      const base = createRun({ id: runId(`run_terminal_${status}`), thread, now });
      const terminal = rehydrateRun({ ...base, status }, thread);
      expectDomainError(
        () =>
          createPlan({
            id: planId(`plan_terminal_${status}`),
            run: terminal,
            steps: [{ id: planStepId(`step_terminal_${status}`), title: "不能创建" }],
            now,
          }),
        "INVALID_STATE_TRANSITION",
      );
      expectDomainError(
        () => createAgentTree({ run: terminal, rootId: agentThreadId(`agent_${status}`), now }),
        "INVALID_STATE_TRANSITION",
      );
      const resource = createResource({
        id: resourceId(`resource_terminal_${status}`),
        tenantId: tenant.id,
        name: "终态资源",
        origin: "artifact",
        now,
      });
      const { version } = appendResourceVersion({
        resource,
        tenantId: tenant.id,
        versionId: resourceVersionId(`version_terminal_${status}`),
        expectedLatestVersionNumber: 0,
        objectKey: `terminal/${status}`,
        digest,
        mediaType: "text/plain",
        sizeBytes: 1,
        now,
      });
      expectDomainError(
        () =>
          createArtifact({
            id: artifactId(`artifact_terminal_${status}`),
            run: terminal,
            resourceVersion: version,
            name: "不能发布",
            now,
          }),
        "INVALID_STATE_TRANSITION",
      );
    },
  );

  it("Artifact 失败后必须用新版本和新发布记录修正", () => {
    const { thread, tenant } = fixture();
    const run = transitionRun(
      createRun({ id: runId("run_artifact"), thread, now }),
      "running",
      later,
    );
    const resource = createResource({
      id: resourceId("res_artifact"),
      tenantId: tenant.id,
      name: "报告",
      origin: "artifact",
      now,
    });
    const initialVersion = appendResourceVersion({
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
      resourceVersion: initialVersion.version,
      name: "最终报告",
      now,
    });
    artifact = transitionArtifact(artifact, "failed", later);
    expectDomainError(
      () =>
        createArtifact({
          id: artifactId("art_same_version"),
          run,
          resourceVersion: initialVersion.version,
          replaces: artifact,
          name: "错误重试",
          now: later,
        }),
      "INVALID_ARGUMENT",
    );
    const corrected = appendResourceVersion({
      resource: initialVersion.resource,
      tenantId: tenant.id,
      versionId: resourceVersionId("rsv_corrected"),
      expectedLatestVersionNumber: 1,
      objectKey: "artifacts/corrected.md",
      digest,
      mediaType: "text/markdown",
      sizeBytes: 12,
      now: later,
    }).version;
    expectDomainError(
      () =>
        createArtifact({
          id: artifact.id,
          run,
          resourceVersion: corrected,
          replaces: artifact,
          name: "复用 ID 的错误修正",
          now: later,
        }),
      "INVALID_ARGUMENT",
    );
    expectDomainError(
      () =>
        rehydrateArtifact(
          {
            ...artifact,
            resourceVersionId: corrected.id,
            replacesArtifactId: artifact.id,
            status: "publishing",
          },
          run,
          corrected,
          artifact,
        ),
      "INVALID_ARGUMENT",
    );
    let correctedArtifact = createArtifact({
      id: artifactId("art_corrected"),
      run,
      resourceVersion: corrected,
      replaces: artifact,
      name: "修正报告",
      now: later,
    });
    correctedArtifact = transitionArtifact(correctedArtifact, "published", later);
    expect(correctedArtifact.replacesArtifactId).toBe(artifact.id);
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
    expectDomainError(
      () => transitionSandboxSession(session, "failed", later, "   "),
      "INVALID_ARGUMENT",
    );
    session = transitionSandboxSession(session, "ready", later, "provider-sandbox-one");
    session = transitionSandboxSession(session, "paused", later);
    expectDomainError(
      () => transitionSandboxSession(session, "ready", later, "provider-sandbox-two"),
      "INVALID_STATE_TRANSITION",
    );
    session = transitionSandboxSession(session, "terminated", later);
    expectDomainError(
      () => transitionSandboxSession(session, "ready", later),
      "INVALID_STATE_TRANSITION",
    );
    const replacement = createReplacementSandboxSession({
      previous: session,
      id: sandboxSessionId("sbx_replacement"),
      thread: fixture().thread,
      templateId: "tpl_one",
      now: later,
    });
    expect(replacement.replacesSessionId).toBe(session.id);
    expectDomainError(
      () =>
        createReplacementSandboxSession({
          previous: session,
          id: session.id,
          thread: fixture().thread,
          templateId: "tpl_one",
          now: later,
        }),
      "INVALID_ARGUMENT",
    );
    expectDomainError(
      () => rehydrateSandboxSession({ ...replacement, id: session.id }, fixture().thread, session),
      "INVALID_ARGUMENT",
    );
  });
});

describe("不可变版本与 Agent Tree", () => {
  it("拒绝跨 Tenant 的 Workspace Revision 写入", () => {
    const first = fixture("first");
    const firstRun = runningRun("first");
    const workspace = acquireWorkspaceLease({
      workspace: createWorkspace({ id: workspaceId("wsp_first"), thread: first.thread, now }),
      rootRun: firstRun,
      epoch: 1,
      expiresAt: leaseExpiry,
      now: later,
    });
    const otherRun = runningRun("second");
    expectDomainError(
      () =>
        prepareWorkspaceRevision({
          workspace,
          rootRun: otherRun,
          leaseEpoch: 1,
          revisionId: workspaceRevisionId("wrv_first"),
          objectKey: "workspace/revision.tar",
          digest,
          now,
        }),
      "OWNERSHIP_MISMATCH",
    );
  });

  it("Workspace Revision 只追加并生成供 Repository 原子提交的 CAS 条件", () => {
    const { thread } = fixture();
    const run = transitionRun(
      createRun({ id: runId("run_workspace"), thread, now }),
      "running",
      later,
    );
    const original = createWorkspace({ id: workspaceId("wsp_versions"), thread, now });
    const leased = acquireWorkspaceLease({
      workspace: original,
      rootRun: run,
      epoch: 1,
      expiresAt: leaseExpiry,
      now: later,
    });
    const first = prepareWorkspaceRevision({
      workspace: leased,
      rootRun: run,
      leaseEpoch: 1,
      revisionId: workspaceRevisionId("wrv_one"),
      objectKey: "workspace/1.tar",
      digest,
      now,
    });
    const second = prepareWorkspaceRevision({
      workspace: first.workspace,
      rootRun: run,
      leaseEpoch: 1,
      revisionId: workspaceRevisionId("wrv_two"),
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
    expect(first).toMatchObject({ expectedCurrentRevisionNumber: 0, expectedLeaseEpoch: 1 });
    expect(second).toMatchObject({ expectedCurrentRevisionNumber: 1, expectedLeaseEpoch: 1 });
  });

  it("Workspace 写入必须持有未过期的 rootRun 租约和匹配 epoch", () => {
    const { thread } = fixture("lease");
    const run = runningRun("lease");
    let workspace = acquireWorkspaceLease({
      workspace: createWorkspace({ id: workspaceId("workspace_lease"), thread, now }),
      rootRun: run,
      epoch: 1,
      expiresAt: leaseExpiry,
      now: later,
    });
    expectDomainError(
      () =>
        prepareWorkspaceRevision({
          workspace,
          rootRun: run,
          leaseEpoch: 2,
          revisionId: workspaceRevisionId("revision_wrong_epoch"),
          objectKey: "workspace/wrong-epoch.tar",
          digest,
          now: later,
        }),
      "OWNERSHIP_MISMATCH",
    );
    expectDomainError(
      () =>
        prepareWorkspaceRevision({
          workspace,
          rootRun: run,
          leaseEpoch: 1,
          revisionId: workspaceRevisionId("revision_expired"),
          objectKey: "workspace/expired.tar",
          digest,
          now: afterLeaseExpiry,
        }),
      "INVALID_STATE_TRANSITION",
    );
    workspace = releaseWorkspaceLease({ workspace, rootRun: run, epoch: 1, now: later });
    expect(workspace.writerLease).toBeUndefined();
    workspace = acquireWorkspaceLease({
      workspace,
      rootRun: run,
      epoch: 2,
      expiresAt: leaseExpiry,
      now: later,
    });
    expect(workspace.writerLease?.epoch).toBe(2);
  });

  it("只有恢复协调器确认 DB 时钟已过期后才能清理 Workspace lease", () => {
    const { thread } = fixture("lease_recovery");
    const run = runningRun("lease_recovery");
    const workspace = acquireWorkspaceLease({
      workspace: createWorkspace({ id: workspaceId("workspace_lease_recovery"), thread, now }),
      rootRun: run,
      epoch: 1,
      expiresAt: leaseExpiry,
      now: later,
    });

    expectDomainError(
      () => expireWorkspaceLease({ workspace, rootRun: run, epoch: 1, now: later }),
      "INVALID_STATE_TRANSITION",
    );
    expect(
      expireWorkspaceLease({ workspace, rootRun: run, epoch: 1, now: afterLeaseExpiry })
        .writerLease,
    ).toBeUndefined();
  });

  it("Workspace 恢复强制零版本与 currentRevisionId 同时为空", () => {
    const { thread } = fixture("workspace_zero");
    const workspace = createWorkspace({ id: workspaceId("workspace_zero"), thread, now });
    expectDomainError(
      () => rehydrateWorkspace({ ...workspace, currentRevisionId: "revision_impossible" }, thread),
      "INVALID_ARGUMENT",
    );
    expectDomainError(
      () => rehydrateWorkspace({ ...workspace, currentRevisionNumber: 1 }, thread),
      "INVALID_ARGUMENT",
    );
  });

  it("JSON 恢复会复验 Plan、Workspace、Resource、Sandbox 和 AgentTree 关联", () => {
    const { thread, tenant } = fixture("rehydrate");
    const run = runningRun("rehydrate");
    const plan = createPlan({
      id: planId("plan_rehydrate"),
      run,
      steps: [{ id: planStepId("step_rehydrate"), title: "恢复" }],
      now,
    });
    expect(rehydratePlan(JSON.parse(JSON.stringify(plan)), run).id).toBe(plan.id);

    const workspace = acquireWorkspaceLease({
      workspace: createWorkspace({ id: workspaceId("workspace_rehydrate"), thread, now }),
      rootRun: run,
      epoch: 1,
      expiresAt: leaseExpiry,
      now: later,
    });
    expect(rehydrateWorkspace(JSON.parse(JSON.stringify(workspace)), thread, run).id).toBe(
      workspace.id,
    );

    const resourceResult = appendResourceVersion({
      resource: createResource({
        id: resourceId("resource_rehydrate"),
        tenantId: tenant.id,
        name: "恢复资源",
        origin: "upload",
        now,
      }),
      tenantId: tenant.id,
      versionId: resourceVersionId("version_rehydrate"),
      expectedLatestVersionNumber: 0,
      objectKey: "resources/rehydrate",
      digest,
      mediaType: "text/plain",
      sizeBytes: 1,
      now,
    });
    expect(
      rehydrateResource(JSON.parse(JSON.stringify(resourceResult.resource)), tenant.id).id,
    ).toBe(resourceResult.resource.id);

    const sandbox = transitionSandboxSession(
      createSandboxSession({
        id: sandboxSessionId("sandbox_rehydrate"),
        thread,
        templateId: "template_rehydrate",
        now,
      }),
      "ready",
      later,
      "provider-rehydrate",
    );
    expect(rehydrateSandboxSession(JSON.parse(JSON.stringify(sandbox)), thread).id).toBe(
      sandbox.id,
    );

    const tree = createAgentTree({ run, rootId: agentThreadId("agent_rehydrate"), now });
    expect(rehydrateAgentTree(JSON.parse(JSON.stringify(tree)), run).rootId).toBe(tree.rootId);
    expectDomainError(
      () =>
        rehydrateWorkspace(
          { ...JSON.parse(JSON.stringify(workspace)), tenantId: "tenant_attacker" },
          thread,
          run,
        ),
      "OWNERSHIP_MISMATCH",
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
    const firstRun = runningRun("owner_a");
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

  it("任意 Agent 进入终态前都必须等待所有后代显式结束", () => {
    const run = runningRun("agents");
    let tree = createAgentTree({ run, rootId: agentThreadId("agt_root"), now });
    tree = spawnAgentThread({
      tree,
      parentId: tree.rootId,
      id: agentThreadId("agt_child"),
      now,
    });
    tree = spawnAgentThread({
      tree,
      parentId: agentThreadId("agt_child"),
      id: agentThreadId("agt_grandchild"),
      now,
    });
    expectDomainError(
      () =>
        transitionAgentThread({
          tree,
          id: agentThreadId("agt_child"),
          target: "failed",
          now: later,
        }),
      "INVALID_STATE_TRANSITION",
    );
    tree = transitionAgentThread({
      tree,
      id: agentThreadId("agt_grandchild"),
      target: "completed",
      now: later,
    });
    tree = transitionAgentThread({
      tree,
      id: agentThreadId("agt_child"),
      target: "failed",
      now: later,
    });
    expect(
      transitionAgentThread({ tree, id: tree.rootId, target: "completed", now: later }).agents[0]
        ?.status,
    ).toBe("completed");
  });

  it("Agent Turn 完成后 Thread 仍可排队 follow-up", () => {
    const run = runningRun("agent_turns");
    let tree = createAgentTree({ run, rootId: agentThreadId("agt_turn_root"), now });
    tree = spawnAgentThread({
      tree,
      parentId: tree.rootId,
      id: agentThreadId("agt_turn_child"),
      now,
    });
    const child = tree.agents.find((agent) => agent.id === agentThreadId("agt_turn_child"));
    if (child === undefined) throw new Error("测试缺少子 Agent");
    let first = queueAgentTurn({
      thread: child,
      id: "turn_1",
      ordinal: 1,
      trigger: "spawn",
      now,
    });
    first = transitionAgentTurn({ turn: first, target: "running", now: later });
    first = transitionAgentTurn({ turn: first, target: "completed", now: later });
    expect(first.status).toBe("completed");
    expect(
      queueAgentTurn({
        thread: child,
        id: "turn_2",
        ordinal: 2,
        trigger: "follow_up",
        now: later,
      }).status,
    ).toBe("queued");
  });
});

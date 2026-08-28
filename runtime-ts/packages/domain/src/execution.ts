import { sealEntity, type Entity } from "./entity.js";
import { assertSameTenant, domainInvariant } from "./errors.js";
import {
  isoTimestamp,
  planId,
  planStepId,
  runId,
  tenantId,
  threadId,
  userId,
  type IsoTimestamp,
  type PlanId,
  type PlanStepId,
  type RunId,
  type TenantId,
  type ThreadId,
  type UserId,
} from "./ids.js";
import { assertActiveMembership, type Membership, type Tenant, type User } from "./identity.js";
import { arrayValue, enumValue, recordValue, stringValue } from "./validation.js";

export type ThreadStatus = "active" | "archived";
interface ThreadData {
  readonly id: ThreadId;
  readonly tenantId: TenantId;
  readonly createdByUserId: UserId;
  readonly title: string;
  readonly status: ThreadStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
export type Thread = Entity<"Thread", ThreadData>;

export function createThread(input: {
  readonly id: ThreadId;
  readonly tenant: Tenant;
  readonly user: User;
  readonly membership: Membership;
  readonly title: string;
  readonly now: IsoTimestamp;
}): Thread {
  assertActiveMembership(input.tenant, input.user, input.membership);
  const title = input.title.trim();
  domainInvariant(title.length > 0 && title.length <= 200, "INVALID_ARGUMENT", "任务标题长度无效");
  return sealEntity("Thread", {
    id: input.id,
    tenantId: input.tenant.id,
    createdByUserId: input.user.id,
    title,
    status: "active",
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function rehydrateThread(
  snapshot: unknown,
  tenant: Tenant,
  user: User,
  membership: Membership,
): Thread {
  // 创建者 Membership 是历史归属证明；退出团队后仍需反序列化团队持有的任务。
  assertSameTenant(tenant.id, membership.tenantId);
  domainInvariant(membership.userId === user.id, "OWNERSHIP_MISMATCH", "任务创建者成员关联无效");
  const raw = recordValue(snapshot, "Thread");
  const restoredTenantId = tenantId(stringValue(raw, "tenantId"));
  assertSameTenant(restoredTenantId, tenant.id);
  const createdByUserId = userId(stringValue(raw, "createdByUserId"));
  domainInvariant(createdByUserId === user.id, "OWNERSHIP_MISMATCH", "任务创建者关联无效");
  const title = stringValue(raw, "title").trim();
  domainInvariant(title.length > 0 && title.length <= 200, "INVALID_ARGUMENT", "任务标题长度无效");
  return sealEntity("Thread", {
    id: threadId(stringValue(raw, "id")),
    tenantId: restoredTenantId,
    createdByUserId,
    title,
    status: enumValue(raw, "status", ["active", "archived"] as const),
    createdAt: isoTimestamp(stringValue(raw, "createdAt")),
    updatedAt: isoTimestamp(stringValue(raw, "updatedAt")),
  });
}

export function renameThread(thread: Thread, rawTitle: string, now: IsoTimestamp): Thread {
  domainInvariant(thread.status === "active", "INVALID_STATE_TRANSITION", "已归档任务不能改名");
  const title = rawTitle.trim();
  domainInvariant(title.length > 0 && title.length <= 200, "INVALID_ARGUMENT", "任务标题长度无效");
  return sealEntity("Thread", { ...thread, title, updatedAt: now });
}

export function archiveThread(thread: Thread, now: IsoTimestamp): Thread {
  domainInvariant(thread.status === "active", "INVALID_STATE_TRANSITION", "任务已经归档");
  return sealEntity("Thread", { ...thread, status: "archived" as const, updatedAt: now });
}

export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
interface RunData {
  readonly id: RunId;
  readonly tenantId: TenantId;
  readonly threadId: ThreadId;
  readonly status: RunStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
export type Run = Entity<"Run", RunData>;

export function createRun(input: {
  readonly id: RunId;
  readonly thread: Thread;
  readonly now: IsoTimestamp;
}): Run {
  domainInvariant(
    input.thread.status === "active",
    "INVALID_STATE_TRANSITION",
    "不能在已归档任务中创建运行",
  );
  // tenantId 只能从 Thread 派生，调用方没有传入并伪造所有权的机会。
  return sealEntity("Run", {
    id: input.id,
    tenantId: input.thread.tenantId,
    threadId: input.thread.id,
    status: "queued",
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function rehydrateRun(snapshot: unknown, thread: Thread): Run {
  const raw = recordValue(snapshot, "Run");
  const restoredTenantId = tenantId(stringValue(raw, "tenantId"));
  assertSameTenant(restoredTenantId, thread.tenantId);
  const restoredThreadId = threadId(stringValue(raw, "threadId"));
  domainInvariant(restoredThreadId === thread.id, "OWNERSHIP_MISMATCH", "运行任务关联无效");
  return sealEntity("Run", {
    id: runId(stringValue(raw, "id")),
    tenantId: restoredTenantId,
    threadId: restoredThreadId,
    status: enumValue(raw, "status", [
      "queued",
      "running",
      "waiting",
      "succeeded",
      "failed",
      "cancelled",
    ] as const),
    createdAt: isoTimestamp(stringValue(raw, "createdAt")),
    updatedAt: isoTimestamp(stringValue(raw, "updatedAt")),
  });
}

const runTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["waiting", "succeeded", "failed", "cancelled"],
  waiting: ["running", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function transitionRun(run: Run, target: RunStatus, now: IsoTimestamp): Run {
  domainInvariant(
    runTransitions[run.status].includes(target),
    "INVALID_STATE_TRANSITION",
    "运行状态转换不被允许",
  );
  return sealEntity("Run", { ...run, status: target, updatedAt: now });
}

export type PlanStatus = "draft" | "active" | "completed" | "abandoned";
export type PlanStepStatus = "pending" | "in_progress" | "completed" | "skipped";
export interface PlanStep {
  readonly id: PlanStepId;
  readonly title: string;
  readonly status: PlanStepStatus;
}
interface PlanData {
  readonly id: PlanId;
  readonly runId: RunId;
  readonly tenantId: TenantId;
  readonly status: PlanStatus;
  readonly steps: readonly PlanStep[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
export type Plan = Entity<"Plan", PlanData>;

function assertRunCanDefinePlan(run: Run): void {
  domainInvariant(
    run.status === "queued" || run.status === "running",
    "INVALID_STATE_TRANSITION",
    "当前运行状态不能创建或恢复计划",
  );
}

export function createPlan(input: {
  readonly id: PlanId;
  readonly run: Run;
  readonly steps: readonly { readonly id: PlanStepId; readonly title: string }[];
  readonly now: IsoTimestamp;
}): Plan {
  assertRunCanDefinePlan(input.run);
  domainInvariant(input.steps.length > 0, "INVALID_ARGUMENT", "计划至少需要一个步骤");
  const ids = new Set(input.steps.map((step) => step.id));
  domainInvariant(ids.size === input.steps.length, "INVALID_ARGUMENT", "计划步骤 ID 不能重复");
  const steps = input.steps.map((step) => {
    const title = step.title.trim();
    domainInvariant(title.length > 0, "INVALID_ARGUMENT", "计划步骤标题不能为空");
    return Object.freeze<PlanStep>({ id: step.id, title, status: "pending" });
  });
  return sealEntity("Plan", {
    id: input.id,
    runId: input.run.id,
    tenantId: input.run.tenantId,
    status: "draft",
    steps: Object.freeze(steps),
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function rehydratePlan(snapshot: unknown, run: Run): Plan {
  const raw = recordValue(snapshot, "Plan");
  const restoredTenantId = tenantId(stringValue(raw, "tenantId"));
  assertSameTenant(restoredTenantId, run.tenantId);
  const restoredRunId = runId(stringValue(raw, "runId"));
  domainInvariant(restoredRunId === run.id, "OWNERSHIP_MISMATCH", "计划运行关联无效");
  const steps = arrayValue(raw, "steps").map((value) => {
    const step = recordValue(value, "PlanStep");
    const title = stringValue(step, "title").trim();
    domainInvariant(title.length > 0, "INVALID_ARGUMENT", "计划步骤标题不能为空");
    return Object.freeze<PlanStep>({
      id: planStepId(stringValue(step, "id")),
      title,
      status: enumValue(step, "status", [
        "pending",
        "in_progress",
        "completed",
        "skipped",
      ] as const),
    });
  });
  domainInvariant(steps.length > 0, "INVALID_ARGUMENT", "计划至少需要一个步骤");
  domainInvariant(
    new Set(steps.map((step) => step.id)).size === steps.length,
    "INVALID_ARGUMENT",
    "计划步骤 ID 不能重复",
  );
  domainInvariant(
    steps.filter((step) => step.status === "in_progress").length <= 1,
    "INVALID_ARGUMENT",
    "同一计划只能有一个执行中的步骤",
  );
  const status = enumValue(raw, "status", ["draft", "active", "completed", "abandoned"] as const);
  if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
    domainInvariant(
      status === "completed" || status === "abandoned",
      "INVALID_ARGUMENT",
      "终态 Run 不能恢复活动计划",
    );
  }
  if (status === "completed") {
    domainInvariant(
      steps.every((step) => step.status === "completed" || step.status === "skipped"),
      "INVALID_ARGUMENT",
      "已完成计划仍包含未结束步骤",
    );
  }
  return sealEntity("Plan", {
    id: planId(stringValue(raw, "id")),
    runId: restoredRunId,
    tenantId: restoredTenantId,
    status,
    steps: Object.freeze(steps),
    createdAt: isoTimestamp(stringValue(raw, "createdAt")),
    updatedAt: isoTimestamp(stringValue(raw, "updatedAt")),
  });
}

const planTransitions: Readonly<Record<PlanStatus, readonly PlanStatus[]>> = {
  draft: ["active", "abandoned"],
  active: ["completed", "abandoned"],
  completed: [],
  abandoned: [],
};

export function transitionPlan(plan: Plan, target: PlanStatus, now: IsoTimestamp): Plan {
  domainInvariant(
    planTransitions[plan.status].includes(target),
    "INVALID_STATE_TRANSITION",
    "计划状态转换不被允许",
  );
  if (target === "completed") {
    domainInvariant(
      plan.steps.every((step) => step.status === "completed" || step.status === "skipped"),
      "INVALID_STATE_TRANSITION",
      "仍有未结束步骤，计划不能完成",
    );
  }
  return sealEntity("Plan", { ...plan, status: target, updatedAt: now });
}

export function transitionPlanStep(
  plan: Plan,
  stepId: PlanStepId,
  target: PlanStepStatus,
  now: IsoTimestamp,
): Plan {
  domainInvariant(plan.status === "active", "INVALID_STATE_TRANSITION", "计划尚未激活");
  const index = plan.steps.findIndex((step) => step.id === stepId);
  domainInvariant(index >= 0, "INVALID_ARGUMENT", "计划步骤不存在");
  const current = plan.steps[index];
  domainInvariant(current !== undefined, "INVALID_ARGUMENT", "计划步骤不存在");
  const allowed: Readonly<Record<PlanStepStatus, readonly PlanStepStatus[]>> = {
    pending: ["in_progress", "skipped"],
    in_progress: ["completed", "pending"],
    completed: [],
    skipped: [],
  };
  domainInvariant(
    allowed[current.status].includes(target),
    "INVALID_STATE_TRANSITION",
    "计划步骤状态转换不被允许",
  );
  if (target === "in_progress") {
    domainInvariant(
      !plan.steps.some((step) => step.status === "in_progress"),
      "INVALID_STATE_TRANSITION",
      "同一计划只能有一个执行中的步骤",
    );
  }
  const steps = plan.steps.map((step, stepIndex) =>
    stepIndex === index ? Object.freeze({ ...step, status: target }) : step,
  );
  return sealEntity("Plan", { ...plan, steps: Object.freeze(steps), updatedAt: now });
}

export function assertRunBelongsToThread(run: Run, thread: Thread): void {
  assertSameTenant(run.tenantId, thread.tenantId);
  domainInvariant(run.threadId === thread.id, "OWNERSHIP_MISMATCH", "运行不属于当前任务");
}

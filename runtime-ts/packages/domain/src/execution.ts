import { assertSameTenant, domainInvariant } from "./errors.js";
import type { IsoTimestamp, PlanId, PlanStepId, RunId, TenantId, ThreadId, UserId } from "./ids.js";
import { assertActiveMembership, type Membership, type Tenant, type User } from "./identity.js";

export type ThreadStatus = "active" | "archived";

export interface Thread {
  readonly id: ThreadId;
  readonly tenantId: TenantId;
  readonly createdByUserId: UserId;
  readonly title: string;
  readonly status: ThreadStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

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
  return Object.freeze({
    id: input.id,
    tenantId: input.tenant.id,
    createdByUserId: input.user.id,
    title,
    status: "active",
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function archiveThread(thread: Thread, now: IsoTimestamp): Thread {
  domainInvariant(thread.status === "active", "INVALID_STATE_TRANSITION", "任务已经归档");
  return Object.freeze({ ...thread, status: "archived", updatedAt: now });
}

export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface Run {
  readonly id: RunId;
  readonly tenantId: TenantId;
  readonly threadId: ThreadId;
  readonly status: RunStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

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
  return Object.freeze({
    id: input.id,
    tenantId: input.thread.tenantId,
    threadId: input.thread.id,
    status: "queued",
    createdAt: input.now,
    updatedAt: input.now,
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
  return Object.freeze({ ...run, status: target, updatedAt: now });
}

export type PlanStatus = "draft" | "active" | "completed" | "abandoned";
export type PlanStepStatus = "pending" | "in_progress" | "completed" | "skipped";

export interface PlanStep {
  readonly id: PlanStepId;
  readonly title: string;
  readonly status: PlanStepStatus;
}

export interface Plan {
  readonly id: PlanId;
  readonly runId: RunId;
  readonly tenantId: TenantId;
  readonly status: PlanStatus;
  readonly steps: readonly PlanStep[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export function createPlan(input: {
  readonly id: PlanId;
  readonly run: Run;
  readonly steps: readonly { readonly id: PlanStepId; readonly title: string }[];
  readonly now: IsoTimestamp;
}): Plan {
  domainInvariant(input.steps.length > 0, "INVALID_ARGUMENT", "计划至少需要一个步骤");
  const ids = new Set(input.steps.map((step) => step.id));
  domainInvariant(ids.size === input.steps.length, "INVALID_ARGUMENT", "计划步骤 ID 不能重复");
  const steps = input.steps.map((step) => {
    const title = step.title.trim();
    domainInvariant(title.length > 0, "INVALID_ARGUMENT", "计划步骤标题不能为空");
    return Object.freeze<PlanStep>({ id: step.id, title, status: "pending" });
  });
  return Object.freeze({
    id: input.id,
    runId: input.run.id,
    tenantId: input.run.tenantId,
    status: "draft",
    steps: Object.freeze(steps),
    createdAt: input.now,
    updatedAt: input.now,
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
  return Object.freeze({ ...plan, status: target, updatedAt: now });
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
  return Object.freeze({ ...plan, steps: Object.freeze(steps), updatedAt: now });
}

export function assertRunBelongsToThread(run: Run, thread: Thread): void {
  assertSameTenant(run.tenantId, thread.tenantId);
  domainInvariant(run.threadId === thread.id, "OWNERSHIP_MISMATCH", "运行不属于当前任务");
}

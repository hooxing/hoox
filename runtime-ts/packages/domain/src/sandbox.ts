import { domainInvariant } from "./errors.js";
import type { Thread } from "./execution.js";
import type { IsoTimestamp, SandboxSessionId, TenantId, ThreadId } from "./ids.js";

export type SandboxSessionStatus = "allocating" | "ready" | "paused" | "failed" | "terminated";

export interface SandboxSession {
  readonly id: SandboxSessionId;
  readonly tenantId: TenantId;
  readonly threadId: ThreadId;
  readonly templateId: string;
  readonly providerSandboxId?: string;
  readonly status: SandboxSessionStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export function createSandboxSession(input: {
  readonly id: SandboxSessionId;
  readonly thread: Thread;
  readonly templateId: string;
  readonly now: IsoTimestamp;
}): SandboxSession {
  domainInvariant(
    input.thread.status === "active",
    "INVALID_STATE_TRANSITION",
    "不能为已归档任务分配沙箱",
  );
  domainInvariant(input.templateId.trim().length > 0, "INVALID_ARGUMENT", "沙箱模板 ID 不能为空");
  return Object.freeze({
    id: input.id,
    tenantId: input.thread.tenantId,
    threadId: input.thread.id,
    templateId: input.templateId,
    status: "allocating",
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function transitionSandboxSession(
  session: SandboxSession,
  target: SandboxSessionStatus,
  now: IsoTimestamp,
  providerSandboxId?: string,
): SandboxSession {
  const transitions: Readonly<Record<SandboxSessionStatus, readonly SandboxSessionStatus[]>> = {
    allocating: ["ready", "failed", "terminated"],
    ready: ["paused", "failed", "terminated"],
    paused: ["ready", "failed", "terminated"],
    failed: ["terminated"],
    terminated: [],
  };
  domainInvariant(
    transitions[session.status].includes(target),
    "INVALID_STATE_TRANSITION",
    "沙箱状态转换不被允许",
  );
  const resolvedProviderId = providerSandboxId ?? session.providerSandboxId;
  if (target === "ready") {
    domainInvariant(
      resolvedProviderId !== undefined && resolvedProviderId.trim().length > 0,
      "INVALID_ARGUMENT",
      "就绪沙箱必须具有厂商实例 ID",
    );
  }
  return Object.freeze({
    ...session,
    ...(resolvedProviderId === undefined ? {} : { providerSandboxId: resolvedProviderId }),
    status: target,
    updatedAt: now,
  });
}

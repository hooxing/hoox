import { sealEntity, type Entity } from "./entity.js";
import { assertSameTenant, domainInvariant } from "./errors.js";
import type { Thread } from "./execution.js";
import {
  isoTimestamp,
  sandboxSessionId,
  tenantId,
  threadId,
  type IsoTimestamp,
  type SandboxSessionId,
  type TenantId,
  type ThreadId,
} from "./ids.js";
import { enumValue, optionalStringValue, recordValue, stringValue } from "./validation.js";

export type SandboxSessionStatus = "allocating" | "ready" | "paused" | "failed" | "terminated";
interface SandboxSessionData {
  readonly id: SandboxSessionId;
  readonly tenantId: TenantId;
  readonly threadId: ThreadId;
  readonly templateId: string;
  readonly providerSandboxId?: string;
  readonly replacesSessionId?: SandboxSessionId;
  readonly status: SandboxSessionStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
export type SandboxSession = Entity<"SandboxSession", SandboxSessionData>;

export function createSandboxSession(input: {
  readonly id: SandboxSessionId;
  readonly thread: Thread;
  readonly templateId: string;
  readonly now: IsoTimestamp;
}): SandboxSession {
  return createSession(input);
}

function createSession(input: {
  readonly id: SandboxSessionId;
  readonly thread: Thread;
  readonly templateId: string;
  readonly now: IsoTimestamp;
  readonly replacesSessionId?: SandboxSessionId;
}): SandboxSession {
  domainInvariant(
    input.thread.status === "active",
    "INVALID_STATE_TRANSITION",
    "不能为已归档任务分配沙箱",
  );
  domainInvariant(input.templateId.trim().length > 0, "INVALID_ARGUMENT", "沙箱模板 ID 不能为空");
  return sealEntity("SandboxSession", {
    id: input.id,
    tenantId: input.thread.tenantId,
    threadId: input.thread.id,
    templateId: input.templateId,
    ...(input.replacesSessionId === undefined
      ? {}
      : { replacesSessionId: input.replacesSessionId }),
    status: "allocating",
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function createReplacementSandboxSession(input: {
  readonly previous: SandboxSession;
  readonly id: SandboxSessionId;
  readonly thread: Thread;
  readonly templateId: string;
  readonly now: IsoTimestamp;
}): SandboxSession {
  assertSameTenant(input.previous.tenantId, input.thread.tenantId);
  domainInvariant(
    input.previous.threadId === input.thread.id,
    "OWNERSHIP_MISMATCH",
    "被替换沙箱不属于当前任务",
  );
  domainInvariant(
    input.previous.status === "failed" || input.previous.status === "terminated",
    "INVALID_STATE_TRANSITION",
    "只有终态沙箱才能被替换",
  );
  return createSession({
    id: input.id,
    thread: input.thread,
    templateId: input.templateId,
    now: input.now,
    replacesSessionId: input.previous.id,
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
  if (providerSandboxId !== undefined && session.providerSandboxId !== undefined) {
    domainInvariant(
      providerSandboxId === session.providerSandboxId,
      "INVALID_STATE_TRANSITION",
      "沙箱厂商实例 ID 首次绑定后不可替换",
    );
  }
  const resolvedProviderId = providerSandboxId ?? session.providerSandboxId;
  if (target === "ready") {
    domainInvariant(
      resolvedProviderId !== undefined && resolvedProviderId.trim().length > 0,
      "INVALID_ARGUMENT",
      "就绪沙箱必须具有厂商实例 ID",
    );
  }
  return sealEntity("SandboxSession", {
    ...session,
    ...(resolvedProviderId === undefined ? {} : { providerSandboxId: resolvedProviderId }),
    status: target,
    updatedAt: now,
  });
}

export function rehydrateSandboxSession(
  snapshot: unknown,
  thread: Thread,
  replacedSession?: SandboxSession,
): SandboxSession {
  const raw = recordValue(snapshot, "SandboxSession");
  const restoredTenantId = tenantId(stringValue(raw, "tenantId"));
  assertSameTenant(restoredTenantId, thread.tenantId);
  const restoredThreadId = threadId(stringValue(raw, "threadId"));
  domainInvariant(restoredThreadId === thread.id, "OWNERSHIP_MISMATCH", "沙箱任务关联无效");
  const providerSandboxId = optionalStringValue(raw, "providerSandboxId");
  const replacesSession = optionalStringValue(raw, "replacesSessionId");
  domainInvariant(
    (replacesSession === undefined) === (replacedSession === undefined),
    "INVALID_ARGUMENT",
    "沙箱替换关联不完整",
  );
  if (replacesSession !== undefined) {
    domainInvariant(replacedSession !== undefined, "INVALID_ARGUMENT", "恢复替换沙箱时缺少原会话");
    domainInvariant(
      sandboxSessionId(replacesSession) === replacedSession.id,
      "OWNERSHIP_MISMATCH",
      "被替换沙箱关联无效",
    );
    assertSameTenant(replacedSession.tenantId, restoredTenantId);
    domainInvariant(
      replacedSession.threadId === restoredThreadId,
      "OWNERSHIP_MISMATCH",
      "被替换沙箱任务关联无效",
    );
    domainInvariant(
      replacedSession.status === "failed" || replacedSession.status === "terminated",
      "INVALID_ARGUMENT",
      "被替换沙箱不是终态",
    );
  }
  const status = enumValue(raw, "status", [
    "allocating",
    "ready",
    "paused",
    "failed",
    "terminated",
  ] as const);
  domainInvariant(
    (status !== "ready" && status !== "paused") || providerSandboxId !== undefined,
    "INVALID_ARGUMENT",
    "已分配沙箱缺少厂商实例 ID",
  );
  const templateId = stringValue(raw, "templateId");
  domainInvariant(templateId.trim().length > 0, "INVALID_ARGUMENT", "沙箱模板 ID 不能为空");
  if (providerSandboxId !== undefined) {
    domainInvariant(
      providerSandboxId.trim().length > 0,
      "INVALID_ARGUMENT",
      "厂商实例 ID 不能为空",
    );
  }
  return sealEntity("SandboxSession", {
    id: sandboxSessionId(stringValue(raw, "id")),
    tenantId: restoredTenantId,
    threadId: restoredThreadId,
    templateId,
    ...(providerSandboxId === undefined ? {} : { providerSandboxId }),
    ...(replacesSession === undefined
      ? {}
      : { replacesSessionId: sandboxSessionId(replacesSession) }),
    status,
    createdAt: isoTimestamp(stringValue(raw, "createdAt")),
    updatedAt: isoTimestamp(stringValue(raw, "updatedAt")),
  });
}

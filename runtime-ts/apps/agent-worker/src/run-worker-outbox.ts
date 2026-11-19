// Sandbox 清理与告警 Outbox 构造；幂等键只由持久身份派生。
import type {
  RuntimeOutboxV1,
  SandboxSessionRef,
  StableWorkerErrorCode,
  ThreadSandboxLeaseRefV1,
} from "./ports.js";
import type { ExecutionContext } from "./run-worker-context.js";

export function cleanupOutbox(
  context: ExecutionContext,
  sandbox: SandboxSessionRef,
  state: "pending" | "started" | "completed",
  disposition?: "pause" | "close",
): RuntimeOutboxV1 {
  const base = {
    schemaVersion: 1,
    kind: "sandbox_cleanup",
    idempotencyKey: cleanupIntentKey(context, sandbox),
    armed: true,
    payload: {
      registryId: sandbox.registryId,
      providerKey: sandbox.providerKey,
      providerSandboxId: sandbox.providerSandboxId,
    },
  } as const;
  if (state === "pending") return { ...base, state };
  if (disposition === undefined) throw new Error("started 后必须一次性决定 cleanup disposition");
  return { ...base, state, payload: { ...base.payload, disposition } };
}

export function recoveryCleanupOutbox(
  context: ExecutionContext,
  sandbox: SandboxSessionRef | undefined,
): readonly RuntimeOutboxV1[] {
  // 普通 Sandbox 已有 pending intent；恢复终止与释放双栅栏必须在同一事务把它推进到
  // started/close，Scheduler 才能立即领取。Thread Sandbox 由独立 lifecycle 状态机收敛。
  return sandbox !== undefined && context.threadSandboxLease === undefined
    ? [cleanupOutbox(context, sandbox, "started", "close")]
    : [];
}

export function terminalSandboxCommand(lease: ThreadSandboxLeaseRefV1) {
  return {
    schemaVersion: 1 as const,
    sessionId: lease.sessionId,
    generation: lease.generation,
    leaseId: lease.leaseId,
    leaseToken: lease.leaseToken,
  };
}

export function cleanupIntentKey(context: ExecutionContext, sandbox: SandboxSessionRef): string {
  return `${context.attemptId}/sandbox/${sandbox.registryId}/cleanup`;
}

export function cleanupUnknownOutbox(
  context: ExecutionContext,
  event: NonNullable<
    Extract<
      RuntimeOutboxV1,
      { kind: "sandbox_cleanup"; state: "unknown" }
    >["payload"]["uncertainEvent"]
  >,
  sandbox?: SandboxSessionRef,
  disposition: "pause" | "close" = "close",
): RuntimeOutboxV1 {
  if (sandbox === undefined) {
    return {
      schemaVersion: 1,
      kind: "sandbox_lifecycle_unknown",
      idempotencyKey: `${context.attemptId}/sandbox/unknown/${event.requestId}`,
      state: "unknown",
      payload: {
        requestId: event.requestId,
        ...(event.sandboxId === undefined ? {} : { sandboxId: event.sandboxId }),
        actualTtlSeconds: event.actualTtlSeconds,
        stage: event.stage,
        uncertainEvent: event,
        retryCode: "SANDBOX_UNKNOWN",
      },
    };
  }
  return {
    schemaVersion: 1,
    kind: "sandbox_cleanup",
    idempotencyKey: cleanupIntentKey(context, sandbox),
    state: "unknown",
    armed: true,
    payload: {
      registryId: sandbox.registryId,
      providerKey: sandbox.providerKey,
      providerSandboxId: sandbox.providerSandboxId,
      disposition,
      uncertainEvent: event,
      retryCode: "SANDBOX_UNKNOWN",
    },
  };
}

export function rawAlertOutbox(attemptId: string, code: StableWorkerErrorCode): RuntimeOutboxV1 {
  return {
    schemaVersion: 1,
    kind: "runtime_alert",
    idempotencyKey: `${attemptId}/alert/${code}`,
    state: "pending",
    payload: { code, attemptId },
  };
}

export function alertOutbox(
  context: ExecutionContext,
  code: StableWorkerErrorCode,
): RuntimeOutboxV1 {
  return rawAlertOutbox(context.attemptId, code);
}

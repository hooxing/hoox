// Run 事件与终态 Thread Context 构造；所有事件在写入前经协议体积校验。
import type { RuntimeAgentEvent } from "@hoox/pi-adapter";
import { digestCanonical } from "./mutation-protocol.js";
import type {
  ExecutionAttemptStatus,
  ExecutionStage,
  RuntimeEventV1,
  StableWorkerErrorCode,
  ThreadContextAppendCommandV1,
  ValidatedWorkspaceChange,
} from "./ports.js";
import { assertProtocolSize } from "./ports.js";
import type { ExecutionContext } from "./run-worker-context.js";

export function terminalFailureEvents(
  context: ExecutionContext,
  status: "failed" | "cancelled" | "recovery_required",
  stage: ExecutionStage,
  code: StableWorkerErrorCode,
  responseAlreadyProvided: boolean,
): readonly RuntimeEventV1[] {
  if (responseAlreadyProvided) return [attemptEvent(context, status, stage, code)];
  return [
    agentEventAt(context.nextEventSequence, {
      type: "runtime.notice",
      level: "error",
      code,
      message: terminalFailureMessage(status, code),
      source: "terminal_fallback",
    }),
    rawAttemptEvent(context.nextEventSequence + 1, status, stage, code),
  ];
}

export function terminalFailureMessage(
  status: "failed" | "cancelled" | "recovery_required" | "waiting" | "succeeded",
  code: StableWorkerErrorCode,
): string {
  if (status === "cancelled" || code === "CANCELLED") {
    return "任务已取消；未完成或未提交的工作不视为成功。";
  }
  const messages: Readonly<Record<StableWorkerErrorCode, string>> = {
    AGENT_REVISION_REVOKED: "此任务使用的 Agent 版本已被撤销，任务已停止。",
    AGENT_SNAPSHOT_INVALID: "无法验证此任务固定的 Agent 版本，任务已停止。",
    AGENT_CONFIGURATION_UNSUPPORTED: "此 Agent 版本要求当前 Worker 不支持的配置，任务未执行。",
    CANCELLED: "任务已取消；未完成或未提交的工作不视为成功。",
    CONTEXT_TOO_LARGE: "上下文仍然超出模型窗口，本次任务未能完成。",
    TIMEOUT: "任务运行超时，本次任务未能完成。",
    PROVIDER: "模型服务调用失败，本次任务未能完成，请稍后重试。",
    PROTOCOL: "模型响应未形成有效终态，本次任务未能完成。",
    EVENT_REJECTED: "运行事件无法可靠保存，本次任务已中断。",
    WORKER_SHUTDOWN: "执行 Worker 已停止，本次任务已中断。",
    PERSISTENCE_UNAVAILABLE: "运行状态暂时无法可靠保存，本次任务已中断。",
    FENCE_LOST: "运行执行权已转移，本次任务已中断，未确认的工作不视为成功。",
    SANDBOX_UNKNOWN: "Sandbox 状态无法确认，本次任务已中断，未确认的修改不视为成功。",
    SANDBOX_FAILED: "Sandbox 连续调用失败，本次任务未能完成。",
    WORKSPACE_CONFLICT: "工作区验证或提交发生冲突，本次修改未确认成功。",
    ARTIFACT_NOT_READY: "交付文件尚未可靠发布，本次交付未确认成功。",
    IDEMPOTENCY_CONFLICT: "运行状态发生幂等冲突，本次任务已中断。",
    INTERNAL: "系统内部处理失败，本次任务未能完成。",
  };
  return messages[code];
}

export function rawAttemptEvent(
  sequence: number,
  status: ExecutionAttemptStatus,
  stage: ExecutionStage,
  code?: StableWorkerErrorCode,
): RuntimeEventV1 {
  return {
    schemaVersion: 1,
    kind: "attempt_state_changed",
    sequence,
    payload: { status, stage, ...(code === undefined ? {} : { code }) },
  };
}

export function attemptEvent(
  context: ExecutionContext,
  status: ExecutionAttemptStatus,
  stage: ExecutionStage,
  code?: StableWorkerErrorCode,
): RuntimeEventV1 {
  const event = rawAttemptEvent(context.nextEventSequence, status, stage, code);
  assertProtocolSize(event);
  return event;
}

export function waitingEvent(
  context: ExecutionContext,
  question: string,
  checkpointId: string,
): RuntimeEventV1 {
  const event: RuntimeEventV1 = {
    schemaVersion: 1,
    kind: "run_waiting",
    sequence: context.nextEventSequence,
    payload: { question: question.slice(0, 4_000), checkpointId },
  };
  assertProtocolSize(event);
  return event;
}

export function terminalContextAppend(
  context: ExecutionContext,
  status: "waiting" | "succeeded" | "failed" | "cancelled",
  workspaceChange?: ValidatedWorkspaceChange,
  code?: StableWorkerErrorCode,
): ThreadContextAppendCommandV1 {
  const key = `${context.attemptId}/context/final/${status}`;
  const entries: ThreadContextAppendCommandV1["entries"][number][] = [];
  if (status === "succeeded") {
    const workspaceBody =
      workspaceChange !== undefined
        ? { outcome: "committed", revisionId: workspaceChange.revisionId }
        : { outcome: "unchanged", revisionId: context.currentRevisionId ?? null };
    entries.push({
      entryId: `${key}/workspace`,
      kind: workspaceChange !== undefined ? "workspace_committed" : "workspace_unchanged",
      body: inlineContextBody(workspaceBody),
    });
  }
  const terminalBody = {
    status,
    ...(code === undefined
      ? {}
      : { code, userFacingMessage: terminalFailureMessage(status, code) }),
  };
  entries.push({
    entryId: `${key}/terminal`,
    kind: "run_terminal",
    body: inlineContextBody(terminalBody),
  });
  return { schemaVersion: 1, idempotencyKey: key, entries };
}

export function inlineContextBody(value: Readonly<Record<string, unknown>>) {
  return {
    storage: "inline" as const,
    value,
    sha256: digestCanonical(value),
    size: Buffer.byteLength(JSON.stringify(value), "utf8"),
  };
}

export function agentEvent(context: ExecutionContext, payload: RuntimeAgentEvent): RuntimeEventV1 {
  return agentEventAt(context.nextEventSequence, payload);
}

export function agentEventAt(sequence: number, payload: RuntimeAgentEvent): RuntimeEventV1 {
  const event: RuntimeEventV1 = {
    schemaVersion: 1,
    kind: "agent_event",
    sequence,
    payload: sanitizeAgentEvent(payload),
  };
  assertProtocolSize(event);
  return event;
}

export function sanitizeAgentEvent(event: RuntimeAgentEvent): RuntimeAgentEvent {
  if (event.type !== "error") return event;
  if (event.code === "CONTEXT_TOO_LARGE") return { ...event, message: "上下文超出模型窗口" };
  const messages: Readonly<Record<typeof event.code, string>> = {
    ABORTED: "模型调用已中止",
    PROVIDER: "模型 Provider 调用失败",
    PROTOCOL: "模型协议响应无效",
  };
  return { ...event, message: messages[event.code] };
}

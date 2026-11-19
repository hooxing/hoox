// 模型事件驱动的执行状态迁移：终答收口、工具开始门与本地停止信号。
import type { RuntimeAgentEvent } from "@hoox/pi-adapter";
import type { ExecutionContext, ToolStartedGate } from "./run-worker-context.js";

export function updateAgentState(context: ExecutionContext, event: RuntimeAgentEvent): void {
  if (event.type === "message.completed") {
    context.modelStopReason = event.stopReason;
    context.modelCompleted = event.stopReason === "stop";
  }
  if (event.type === "error") {
    context.agentFailure = event.code === "ABORTED" ? "CANCELLED" : event.code;
  }
  if (event.type === "compaction.forbidden") context.agentFailure = "PROTOCOL";
}

export type FinalizationTransition = Readonly<{
  phase?: "commentary" | "final_answer";
  event?: Extract<
    RuntimeAgentEvent,
    { type: "finalization.started" | "finalization.cancelled" | "final_answer.committed" }
  >;
  next?: { readonly callId: string };
}>;

export function classifyFinalizationTurn(
  context: ExecutionContext,
  event: Extract<RuntimeAgentEvent, { type: "turn.completed" }>,
): FinalizationTransition {
  const toolCalls = event.assistant.content.filter(
    (item): item is Extract<typeof item, { type: "toolCall" }> => item.type === "toolCall",
  );
  const marker =
    toolCalls.length === 1 &&
    toolCalls[0]?.name === "collapse_process_for_final_answer" &&
    Object.keys(toolCalls[0].arguments).length === 0 &&
    event.toolResults.length === 1 &&
    event.toolResults[0]?.toolCallId === toolCalls[0].id &&
    event.toolResults[0].toolName === "collapse_process_for_final_answer" &&
    !event.toolResults[0].isError
      ? toolCalls[0]
      : undefined;
  if (marker !== undefined) {
    return {
      phase: "commentary",
      event: { type: "finalization.started", callId: marker.id },
      next: { callId: marker.id },
    };
  }

  const active = context.finalization;
  if (active === undefined) return {};
  if (toolCalls.length > 0 || event.assistant.stopReason === "toolUse") {
    return {
      phase: "commentary",
      event: { type: "finalization.cancelled", callId: active.callId, reason: "tool_use" },
    };
  }
  const text = event.assistant.content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n");
  if (text.trim().length === 0) {
    return event.assistant.stopReason === "stop"
      ? {
          event: {
            type: "finalization.cancelled",
            callId: active.callId,
            reason: "empty_answer",
          },
        }
      : { next: active };
  }
  if (event.assistant.stopReason === "length") {
    return { phase: "final_answer", next: active };
  }
  return {
    phase: "final_answer",
    event: { type: "final_answer.committed", callId: active.callId },
  };
}

export function applyFinalizationTransition(
  context: ExecutionContext,
  transition: FinalizationTransition,
): void {
  if (transition.next === undefined) delete context.finalization;
  else context.finalization = transition.next;
}

export function registerToolStarted(
  context: ExecutionContext,
  event: Extract<RuntimeAgentEvent, { type: "tool.started" }>,
): ToolStartedGate {
  const existing = context.toolStartedGates.get(event.callId);
  if (existing !== undefined) {
    context.adapterRejected = true;
    context.agentFailure = "PROTOCOL";
    closeEventAcceptance(context);
    existing.resolve();
    return existing;
  }
  let resolve: () => void = () => undefined;
  const committed = new Promise<void>((done) => {
    resolve = done;
  });
  const gate = {
    name: event.name,
    committed,
    authorizationRequested: false,
    todoWriteRequested: false,
    resolve,
  };
  context.toolStartedGates.set(event.callId, gate);
  return gate;
}

export function closeEventAcceptance(context: ExecutionContext): void {
  context.eventAcceptanceOpen = false;
}

export function refreshLocalStop(
  context: ExecutionContext,
  cancellation: AbortSignal,
  shutdown: AbortSignal | undefined,
): void {
  if (shutdown?.aborted) {
    context.stopped = "shutdown";
  } else if (cancellation.aborted && context.stopped !== "shutdown") {
    context.stopped = "cancelled";
  }
}

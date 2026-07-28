import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type RuntimeAgentEvent =
  | { type: "agent.started" }
  | { type: "agent.settled" }
  | { type: "message.delta"; delta: string }
  | { type: "message.completed"; stopReason: "stop" | "length" | "toolUse" }
  | { type: "tool.started"; callId: string; name: string }
  | { type: "tool.updated"; callId: string; name: string }
  | { type: "tool.completed"; callId: string; name: string; isError: boolean }
  | { type: "queue.updated"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction.forbidden"; source: "pi" }
  | {
      type: "error";
      code: "CONTEXT_TOO_LARGE";
      message: "上下文超出模型窗口";
      action: "rebuild_context";
    }
  | { type: "error"; code: "ABORTED" | "PROVIDER" | "PROTOCOL"; message: string };

/** Pi 事件属于可替换内核协议；此处转换后，上层不需要依赖 Pi 的事件结构。 */
export function mapPiEvent(event: AgentSessionEvent): RuntimeAgentEvent | undefined {
  switch (event.type) {
    case "agent_start":
      return { type: "agent.started" };
    case "agent_settled":
      return { type: "agent.settled" };
    case "message_update":
      return event.assistantMessageEvent.type === "text_delta"
        ? { type: "message.delta", delta: event.assistantMessageEvent.delta }
        : undefined;
    case "message_end": {
      // Pi 会为 user、assistant 和 toolResult 都发 message_end；Runtime 只发布 assistant 终态。
      if (event.message.role !== "assistant") return undefined;
      if (event.message.stopReason === "aborted") {
        return { type: "error", code: "ABORTED", message: "模型调用已中止" };
      }
      if (event.message.stopReason === "error" || event.message.errorMessage) {
        if (event.message.errorMessage === "CONTEXT_TOO_LARGE") {
          return {
            type: "error",
            code: "CONTEXT_TOO_LARGE",
            message: "上下文超出模型窗口",
            action: "rebuild_context",
          };
        }
        return { type: "error", code: "PROVIDER", message: "模型 Provider 调用失败" };
      }
      return {
        type: "message.completed",
        stopReason: event.message.stopReason,
      };
    }
    case "tool_execution_start":
      return { type: "tool.started", callId: event.toolCallId, name: event.toolName };
    case "tool_execution_update":
      return { type: "tool.updated", callId: event.toolCallId, name: event.toolName };
    case "tool_execution_end":
      return {
        type: "tool.completed",
        callId: event.toolCallId,
        name: event.toolName,
        isError: event.isError,
      };
    case "queue_update":
      return { type: "queue.updated", steering: event.steering, followUp: event.followUp };
    case "compaction_start":
    case "compaction_end":
      // 配置层已经关闭 Pi compaction；若仍收到事件，必须作为违反不变量上报而不是静默吞掉。
      return { type: "compaction.forbidden", source: "pi" };
    default:
      return undefined;
  }
}

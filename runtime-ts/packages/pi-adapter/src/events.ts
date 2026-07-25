import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type RuntimeAgentEvent =
  | { type: "agent.started" }
  | { type: "agent.settled" }
  | { type: "message.delta"; delta: string }
  | { type: "message.completed" }
  | { type: "tool.started"; callId: string; name: string }
  | { type: "tool.updated"; callId: string; name: string }
  | { type: "tool.completed"; callId: string; name: string; isError: boolean }
  | { type: "queue.updated"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction.forbidden"; source: "pi" }
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
    case "message_end":
      return { type: "message.completed" };
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

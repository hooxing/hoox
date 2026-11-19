import type { TodoSnapshot } from "@hoox/domain";

/**
 * Runtime 对模型内核事件的稳定投影。具体内核（当前为 Pi）在适配器中转换到此协议，
 * 编排、持久化与诊断只依赖本定义，不感知内核事件结构。
 */
export type ToolFailure = {
  readonly code: string;
  readonly message: string;
};

export type ToolPresentation = {
  readonly action:
    | "search"
    | "read"
    | "create"
    | "write"
    | "edit"
    | "deliver"
    | "command"
    | "other";
  readonly title?: string;
};

export type RuntimeAgentEvent =
  | { type: "agent.started" }
  | { type: "agent.settled" }
  | { type: "thinking.started" }
  | { type: "thinking.delta"; delta: string }
  | { type: "thinking.completed" }
  | { type: "message.delta"; delta: string }
  | { type: "message.completed"; stopReason: "stop" | "length" | "toolUse" }
  | {
      type: "tool.started";
      callId: string;
      name: string;
      presentation?: ToolPresentation;
      parentCallId?: string;
    }
  | { type: "tool.updated"; callId: string; name: string }
  | {
      type: "tool.completed";
      callId: string;
      name: string;
      isError: boolean;
      failure?: ToolFailure;
    }
  | { type: "finalization.started"; callId: string }
  | {
      type: "finalization.cancelled";
      callId: string;
      reason: "tool_use" | "empty_answer";
    }
  | { type: "final_answer.committed"; callId: string }
  | { type: "todo.updated"; snapshot: TodoSnapshot }
  | {
      /** 只在完整 turn_end 后发布；RunWorker 将其写入 Thread Context，不写入 UI run_events。 */
      type: "turn.completed";
      assistant: {
        readonly content: readonly (
          | { readonly type: "text"; readonly text: string }
          | {
              readonly type: "toolCall";
              readonly id: string;
              readonly name: string;
              readonly arguments: Readonly<Record<string, unknown>>;
              readonly thoughtSignature?: string;
            }
          | {
              readonly type: "thinking";
              readonly thinking: string;
              readonly thinkingSignature?: string;
              readonly redacted?: boolean;
            }
        )[];
        readonly api: string;
        readonly provider: string;
        readonly model: string;
        readonly stopReason: "stop" | "length" | "toolUse";
        readonly timestamp: number;
      };
      toolResults: readonly {
        readonly toolCallId: string;
        readonly toolName: string;
        readonly text: string;
        readonly isError: boolean;
        readonly timestamp: number;
      }[];
    }
  | { type: "queue.updated"; steering: readonly string[]; followUp: readonly string[] }
  | {
      /** Runtime 在模型无法安全继续时生成的用户可见兜底；不伪装成模型原话。 */
      type: "runtime.notice";
      level: "error";
      code: string;
      message: string;
      source: "terminal_fallback";
    }
  | { type: "compaction.forbidden"; source: "pi" }
  | {
      type: "error";
      code: "CONTEXT_TOO_LARGE";
      message: "上下文超出模型窗口";
      action: "rebuild_context";
    }
  | { type: "error"; code: "ABORTED" | "PROVIDER" | "PROTOCOL"; message: string };

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { TodoSnapshot } from "@aisay/domain";

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
  | { type: "tool.started"; callId: string; name: string; presentation?: ToolPresentation }
  | { type: "tool.updated"; callId: string; name: string }
  | { type: "tool.completed"; callId: string; name: string; isError: boolean }
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

/** Pi 事件属于可替换内核协议；此处转换后，上层不需要依赖 Pi 的事件结构。 */
export function mapPiEvent(event: AgentSessionEvent): RuntimeAgentEvent | undefined {
  switch (event.type) {
    case "agent_start":
      return { type: "agent.started" };
    case "agent_settled":
      return { type: "agent.settled" };
    case "message_update":
      switch (event.assistantMessageEvent.type) {
        case "thinking_start":
          return { type: "thinking.started" };
        case "thinking_delta":
          return { type: "thinking.delta", delta: event.assistantMessageEvent.delta };
        case "thinking_end":
          return { type: "thinking.completed" };
        case "text_delta":
          return { type: "message.delta", delta: event.assistantMessageEvent.delta };
        default:
          return undefined;
      }
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
        // Pi 会把 turn hook 抛错包装成 assistant error；Runtime 自身协议错误不能伪装成 Provider 故障。
        if (
          event.message.errorMessage?.includes("THREAD_CONTEXT_") === true ||
          event.message.errorMessage?.includes("Pi turn 安全点事件无效") === true ||
          event.message.errorMessage === "MODEL_CONTINUATION_REJECTED" ||
          event.message.errorMessage === "PROVIDER_BINDING_DRIFT"
        ) {
          return { type: "error", code: "PROTOCOL", message: "模型协议响应无效" };
        }
        return { type: "error", code: "PROVIDER", message: "模型 Provider 调用失败" };
      }
      return {
        type: "message.completed",
        stopReason: event.message.stopReason,
      };
    }
    case "tool_execution_start": {
      const presentation = projectToolPresentation(event.toolName, event.args);
      return {
        type: "tool.started",
        callId: event.toolCallId,
        name: event.toolName,
        ...(presentation === undefined ? {} : { presentation }),
      };
    }
    case "tool_execution_update":
      return { type: "tool.updated", callId: event.toolCallId, name: event.toolName };
    case "tool_execution_end":
      return {
        type: "tool.completed",
        callId: event.toolCallId,
        name: event.toolName,
        isError: event.isError,
      };
    case "turn_end": {
      if (event.message.role !== "assistant") return undefined;
      if (
        event.message.stopReason === "aborted" ||
        event.message.stopReason === "error" ||
        event.message.errorMessage
      ) {
        return undefined;
      }
      const content: Extract<
        RuntimeAgentEvent,
        { type: "turn.completed" }
      >["assistant"]["content"] = event.message.content.map((item) => {
        if (item.type === "text") return { type: "text" as const, text: item.text };
        if (item.type === "thinking") {
          return {
            type: "thinking" as const,
            thinking: item.thinking,
            ...(item.thinkingSignature === undefined
              ? {}
              : { thinkingSignature: item.thinkingSignature }),
            ...(item.redacted === undefined ? {} : { redacted: item.redacted }),
          };
        }
        if (item.type === "toolCall") {
          return {
            type: "toolCall" as const,
            id: item.id,
            name: item.name,
            arguments: item.arguments as Readonly<Record<string, unknown>>,
            ...(item.thoughtSignature === undefined
              ? {}
              : { thoughtSignature: item.thoughtSignature }),
          };
        }
        item satisfies never;
        throw new TypeError("THREAD_CONTEXT_UNSUPPORTED_ASSISTANT_ITEM");
      });
      const toolResults = event.toolResults.map((result) => {
        // 图片字节只进入当前工具循环的 Provider 请求；Thread Context 保留同一结果中的
        // 文本说明，不把 Base64 复制进长期历史或 durable Rollout。
        const texts = result.content.flatMap((item) => (item.type === "text" ? [item.text] : []));
        return {
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          text: texts.join("\n"),
          isError: result.isError,
          timestamp: result.timestamp,
        };
      });
      return {
        type: "turn.completed",
        assistant: {
          content,
          api: event.message.api,
          provider: event.message.provider,
          model: event.message.model,
          stopReason: event.message.stopReason,
          timestamp: event.message.timestamp,
        },
        toolResults,
      };
    }
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

function projectToolPresentation(name: string, unsafeArgs: unknown): ToolPresentation | undefined {
  const args =
    typeof unsafeArgs === "object" && unsafeArgs !== null
      ? (unsafeArgs as Readonly<Record<string, unknown>>)
      : undefined;
  const safeText = (value: unknown, maxLength = 160) =>
    typeof value === "string" && value.trim().length > 0
      ? value.trim().replace(/\s+/gu, " ").slice(0, maxLength)
      : undefined;
  const workspacePath = (value: unknown) => {
    const path = safeText(value, 4096);
    if (path === undefined) return undefined;
    return path.replace(/^\/workspace\//u, "").slice(0, 240);
  };
  const filePresentation = (action: "read" | "write" | "edit") => {
    const title = workspacePath(args?.path);
    return { action, ...(title === undefined ? {} : { title }) };
  };
  if (name === "read") return filePresentation("read");
  if (name === "write") return filePresentation("write");
  if (name === "edit") return filePresentation("edit");
  if (name === "exec_command") {
    const purpose = safeText(args?.user_facing_purpose);
    return { action: "command", ...(purpose === undefined ? {} : { title: purpose }) };
  }
  if (name === "deliver_file") {
    const title = safeText(args?.name, 255) ?? workspacePath(args?.path);
    return { action: "deliver", ...(title === undefined ? {} : { title }) };
  }
  if (name === "todo_write") return { action: "other", title: "更新任务清单" };
  if (name === "automation_update") return { action: "other", title: "管理定时任务" };
  if (name === "publish_artifact") {
    const title = safeText(args?.name, 255);
    return { action: "deliver", ...(title === undefined ? {} : { title }) };
  }
  if (name === "declare_deliverables") {
    const declarations = Array.isArray(args?.declarations) ? args.declarations : [];
    const names = declarations.flatMap((item) => {
      const name =
        typeof item === "object" && item !== null
          ? safeText((item as Readonly<Record<string, unknown>>).name, 255)
          : undefined;
      return name === undefined ? [] : [name];
    });
    const title = names.slice(0, 3).join("、");
    return { action: "other", ...(title.length === 0 ? {} : { title: `准备交付 ${title}` }) };
  }
  return undefined;
}

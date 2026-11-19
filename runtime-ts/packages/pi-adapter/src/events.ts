import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { RuntimeAgentEvent, ToolPresentation } from "@hoox/run-contracts/runtime-agent-event";
import { projectToolFailure } from "./tool-failure.js";

// 事件协议定义位于 run-contracts；重导出以保持 @hoox/pi-adapter 的既有公开面。
export type { RuntimeAgentEvent, ToolPresentation } from "@hoox/run-contracts/runtime-agent-event";

/** settled 由 Runtime 在底层完成及事务回滚后补发，不把 agent_end 当作空闲屏障。 */
export type PiAgentEvent =
  | AgentEvent
  | { type: "agent_settled" }
  | {
      type: "runtime_tool_event";
      event: Extract<
        RuntimeAgentEvent,
        { type: "tool.started" | "tool.updated" | "tool.completed" }
      >;
    };

/** Pi 事件属于可替换内核协议；此处转换后，上层不需要依赖 Pi 的事件结构。 */
export function mapPiEvent(event: PiAgentEvent): RuntimeAgentEvent | undefined {
  switch (event.type) {
    case "runtime_tool_event":
      return event.event;
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
        ...(event.isError
          ? {
              failure: projectToolFailure(
                new Error(
                  event.result.content.find(
                    (item: { type: string; text?: string }) => item.type === "text",
                  )?.text ?? "",
                ),
              ),
            }
          : {}),
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
    default:
      return undefined;
  }
}

/** 两种模式共用白名单投影；禁止把程序、命令、消息正文和完整参数放入公开事件。 */
export function projectToolPresentation(
  name: string,
  unsafeArgs: unknown,
): ToolPresentation | undefined {
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
  if (name === "run_code") return { action: "other", title: "编排工具调用" };
  if (name === "skill") {
    const skill = safeText(args?.skill, 128);
    return { action: "read", title: skill === undefined ? "加载技能" : `加载技能 ${skill}` };
  }
  const collaborationTitles: Readonly<Record<string, string>> = {
    list_agents: "查看协作智能体",
    spawn_agent: "启动协作任务",
    wait_agent: "等待协作任务",
    send_message: "发送协作消息",
    followup_task: "追加协作任务",
    interrupt_agent: "中断协作任务",
  };
  const collaborationTitle = Object.hasOwn(collaborationTitles, name)
    ? collaborationTitles[name]
    : undefined;
  if (collaborationTitle !== undefined) return { action: "other", title: collaborationTitle };
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

import type { RunEvent } from "./api.js";

export type UserFacingStep = {
  readonly id: string;
  readonly label: string;
  readonly status: "running" | "completed" | "failed";
  readonly count: number;
};

export type RunProgress = {
  readonly currentAction: string;
  readonly steps: readonly UserFacingStep[];
  readonly thinking:
    | { readonly text: string; readonly status: "running" | "completed" }
    | undefined;
  readonly finalMessage: string | undefined;
  readonly waitingQuestion: string | undefined;
};

export type ConversationBlock =
  | {
      readonly id: string;
      readonly type: "thinking";
      readonly text: string;
      readonly status: "running" | "completed";
    }
  | {
      readonly id: string;
      readonly type: "answer";
      readonly text: string;
      readonly status: "streaming" | "completed";
    }
  | {
      readonly id: string;
      readonly type: "tool";
      readonly action: ToolAction;
      readonly title?: string;
      readonly status: "running" | "completed" | "failed";
      readonly callId: string;
    };

export type ToolAction = "search" | "read" | "create" | "write" | "edit" | "command" | "other";

export type ConversationSection =
  | Extract<ConversationBlock, { type: "answer" | "tool" }>
  | {
      readonly id: string;
      readonly type: "activity";
      readonly items: readonly (
        | Extract<ConversationBlock, { type: "thinking" }>
        | Extract<ConversationBlock, { type: "tool" }>
      )[];
    };

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, 500)
    : undefined;
}

/** waiting 问题是用户可见正文，不能沿用工具字段的展示截断。 */
function waitingQuestionText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizedWholeText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

/** 工具名只用于归类，不把调用标识或工具协议直接暴露给用户。 */
export function toolActionLabel(name: string | undefined): string {
  const normalized = name?.toLowerCase() ?? "";
  if (/(search|web|browse|fetch|crawl)/u.test(normalized)) return "正在搜索网页…";
  if (/(write|artifact|export|generate.*file|create.*file)/u.test(normalized)) {
    return "正在生成文件…";
  }
  if (/(shell|command|code|python|node|execute|run)/u.test(normalized)) {
    return "正在执行代码…";
  }
  if (/(read|list|inspect|open)/u.test(normalized)) return "正在读取资料…";
  return "正在处理任务…";
}

function toolAction(name: string | undefined): ToolAction {
  const normalized = name?.toLowerCase() ?? "";
  if (/(search|web|browse|fetch|crawl)/u.test(normalized)) return "search";
  if (/(write|artifact|export|generate.*file|create.*file|deliver_file)/u.test(normalized)) {
    return "create";
  }
  if (/(shell|command|code|python|node|execute|run)/u.test(normalized)) return "command";
  if (/(read|list|inspect|open)/u.test(normalized)) return "read";
  return "other";
}

function toolPresentationAction(
  payload: Readonly<Record<string, unknown>> | undefined,
): ToolAction | undefined {
  const action = text(object(payload?.presentation)?.action);
  return action === "search" ||
    action === "read" ||
    action === "create" ||
    action === "write" ||
    action === "edit" ||
    action === "command" ||
    action === "other"
    ? action
    : undefined;
}

/** 展示标题只能来自服务端显式提供的安全摘要，前端不解析或泄露原始工具参数。 */
function toolPresentationTitle(payload: Readonly<Record<string, unknown>> | undefined) {
  const presentation = object(payload?.presentation);
  return text(presentation?.title);
}

/**
 * 保留模型回复、思考与工具调用的原始先后关系；callId 只用于更新对应工具块。
 */
export function buildConversationBlocks(events: readonly RunEvent[]): readonly ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  const tools = new Map<string, number>();
  let activeThinking: number | undefined;
  let activeAnswer: number | undefined;

  for (const event of events) {
    const payload = object(event.payload);
    if (event.type === "thinking.started") {
      activeAnswer = undefined;
      activeThinking = blocks.length;
      blocks.push({ id: event.eventId, type: "thinking", text: "", status: "running" });
      continue;
    }
    if (event.type === "thinking.delta") {
      activeAnswer = undefined;
      if (activeThinking === undefined) {
        activeThinking = blocks.length;
        blocks.push({ id: event.eventId, type: "thinking", text: "", status: "running" });
      }
      const block = blocks[activeThinking];
      const delta = payload?.delta;
      if (block?.type === "thinking" && typeof delta === "string") {
        blocks[activeThinking] = { ...block, text: `${block.text}${delta}` };
      }
      continue;
    }
    if (event.type === "thinking.completed") {
      const index = activeThinking;
      const block = index === undefined ? undefined : blocks[index];
      if (index !== undefined && block?.type === "thinking") {
        blocks[index] = { ...block, status: "completed" };
      }
      activeThinking = undefined;
      continue;
    }
    if (event.type === "message.delta") {
      activeThinking = undefined;
      const delta = payload?.delta;
      if (typeof delta !== "string") continue;
      if (activeAnswer === undefined) {
        activeAnswer = blocks.length;
        blocks.push({ id: event.eventId, type: "answer", text: "", status: "streaming" });
      }
      const block = blocks[activeAnswer];
      if (block?.type === "answer")
        blocks[activeAnswer] = { ...block, text: `${block.text}${delta}` };
      continue;
    }
    if (event.type === "message.completed") {
      const answerIndex = activeAnswer;
      const answer = answerIndex === undefined ? undefined : blocks[answerIndex];
      if (answerIndex !== undefined && answer?.type === "answer") {
        blocks[answerIndex] = { ...answer, status: "completed" };
      }
      const thinkingIndex = activeThinking;
      const thinking = thinkingIndex === undefined ? undefined : blocks[thinkingIndex];
      if (thinkingIndex !== undefined && thinking?.type === "thinking") {
        blocks[thinkingIndex] = { ...thinking, status: "completed" };
      }
      activeAnswer = undefined;
      activeThinking = undefined;
      continue;
    }
    if (!event.type.startsWith("tool.")) continue;
    activeAnswer = undefined;
    activeThinking = undefined;
    const name = text(payload?.name);
    const callId = text(payload?.callId) ?? `${name ?? "unknown"}:${event.sequence}`;
    const index = tools.get(callId);
    const status =
      event.type === "tool.failed" || payload?.isError === true
        ? "failed"
        : event.type === "tool.completed"
          ? "completed"
          : "running";
    if (index === undefined) {
      const title = toolPresentationTitle(payload);
      tools.set(callId, blocks.length);
      blocks.push({
        id: event.eventId,
        type: "tool",
        action: toolPresentationAction(payload) ?? toolAction(name),
        status,
        callId,
        ...(title === undefined ? {} : { title }),
      });
    } else {
      const block = blocks[index];
      if (block?.type === "tool") {
        const title = toolPresentationTitle(payload) ?? block.title;
        blocks[index] = {
          ...block,
          status,
          ...(title === undefined ? {} : { title }),
        };
      }
    }
  }

  return blocks.filter((block) => block.type === "tool" || block.text.length > 0);
}

/**
 * 回答是执行阶段的硬边界；创建和修改文件保持直出，其余过程在相邻区间内折叠聚合。
 */
export function buildConversationSections(
  blocks: readonly ConversationBlock[],
): readonly ConversationSection[] {
  const sections: ConversationSection[] = [];
  let grouped: Array<
    Extract<ConversationBlock, { type: "thinking" }> | Extract<ConversationBlock, { type: "tool" }>
  > = [];
  const flush = () => {
    if (grouped.length === 0) return;
    sections.push({
      id: `activity-${grouped[0]?.id ?? sections.length}`,
      type: "activity",
      items: grouped,
    });
    grouped = [];
  };

  for (const block of blocks) {
    if (block.type === "answer") {
      flush();
      sections.push(block);
    } else if (
      block.type === "tool" &&
      (block.action === "create" || block.action === "write" || block.action === "edit")
    ) {
      flush();
      sections.push(block);
    } else {
      grouped.push(block);
    }
  }
  flush();
  return sections;
}

function toolDescriptor(
  event: RunEvent,
): { readonly key: string; readonly label: string } | undefined {
  if (!event.type.startsWith("tool.")) return undefined;
  const payload = object(event.payload);
  const name = text(payload?.name);
  // callId 仅作前端聚合键，不能进入可见文案。
  const key = text(payload?.callId) ?? `${name ?? "unknown"}:${event.sequence}`;
  return { key, label: toolActionLabel(name) };
}

/**
 * 将底层事件投影为有限的用户动作。未知生命周期事件被刻意忽略，避免页面成为调试日志。
 */
export function buildRunProgress(events: readonly RunEvent[]): RunProgress {
  const byTool = new Map<string, number>();
  const steps: UserFacingStep[] = [];
  const messageDeltas: string[] = [];
  const thinkingBlocks: string[] = [];
  let activeThinkingBlock = -1;
  let thinkingActive = false;
  let messageActive = false;
  let waitingQuestion: string | undefined;

  for (const event of events) {
    if (event.type === "thinking.started") {
      thinkingBlocks.push("");
      activeThinkingBlock = thinkingBlocks.length - 1;
      thinkingActive = true;
      continue;
    }
    if (event.type === "thinking.delta") {
      const delta = object(event.payload)?.delta;
      if (typeof delta === "string") {
        if (activeThinkingBlock < 0 || !thinkingActive) {
          thinkingBlocks.push("");
          activeThinkingBlock = thinkingBlocks.length - 1;
        }
        thinkingBlocks[activeThinkingBlock] =
          `${thinkingBlocks[activeThinkingBlock] ?? ""}${delta}`;
        thinkingActive = true;
      }
      continue;
    }
    if (event.type === "thinking.completed") {
      thinkingActive = false;
      activeThinkingBlock = -1;
      continue;
    }
    if (event.type === "message.delta") {
      const delta = object(event.payload)?.delta;
      // 每个字符串片段（包括独立空格和换行）都是 Markdown 结构的一部分。
      if (typeof delta === "string") {
        messageDeltas.push(delta);
        messageActive = true;
      }
      continue;
    }
    if (event.type === "message.completed") {
      // 兼容缺少 thinking_end 的 Provider：assistant message 结束即视为本轮思考结束。
      thinkingActive = false;
      activeThinkingBlock = -1;
      messageActive = false;
      continue;
    }
    if (event.type === "run_waiting") {
      waitingQuestion =
        waitingQuestionText(object(event.payload)?.question) ?? "请补充所需信息后继续。";
      continue;
    }
    const descriptor = toolDescriptor(event);
    if (descriptor === undefined) continue;
    const index = byTool.get(descriptor.key);
    const nextStatus =
      event.type === "tool.failed" || object(event.payload)?.isError === true
        ? "failed"
        : event.type === "tool.completed"
          ? "completed"
          : "running";
    if (index === undefined) {
      byTool.set(descriptor.key, steps.length);
      steps.push({ id: descriptor.key, label: descriptor.label, status: nextStatus, count: 1 });
    } else {
      const previous = steps[index];
      if (previous !== undefined) steps[index] = { ...previous, status: nextStatus };
    }
  }

  // 相邻的同类完成动作压缩为一步，降低重复工具调用的视觉噪声。
  const compacted: UserFacingStep[] = [];
  for (const step of steps) {
    const previous = compacted.at(-1);
    if (
      previous?.label === step.label &&
      previous.status === step.status &&
      step.status !== "running"
    ) {
      compacted[compacted.length - 1] = { ...previous, count: previous.count + step.count };
    } else {
      compacted.push(step);
    }
  }
  const active = [...compacted].reverse().find((step) => step.status === "running");
  const finalMessage = messageDeltas.join("");
  const thinkingText = thinkingBlocks.filter((block) => block.length > 0).join("\n\n");
  return {
    currentAction:
      thinkingActive === true
        ? "正在思考…"
        : (active?.label ?? (messageActive ? "正在回复…" : "正在准备任务…")),
    steps: compacted,
    thinking:
      thinkingText.length === 0
        ? undefined
        : { text: thinkingText, status: thinkingActive ? "running" : "completed" },
    finalMessage: messageDeltas.length > 0 ? finalMessage : undefined,
    waitingQuestion:
      waitingQuestion !== undefined &&
      normalizedWholeText(finalMessage) !== normalizedWholeText(waitingQuestion)
        ? waitingQuestion
        : undefined,
  };
}

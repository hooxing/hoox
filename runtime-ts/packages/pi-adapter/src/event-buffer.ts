import type { RuntimeAgentEvent } from "./events.js";

type DeltaEvent = Extract<RuntimeAgentEvent, { type: "thinking.delta" | "message.delta" }>;
const FLUSH_BYTES = 1_024;
const MESSAGE_FLUSH_MS = 50;
// 每次刷新都是一笔串行持久化事务；思考增量通常折叠展示且单片只有几十字节，
// 用更长窗口合并可把事务数降到约五分之一，正文窗口保持不变以免影响打字体感。
const THINKING_FLUSH_MS = 500;

/**
 * 每个订阅独占公开增量缓冲；首段正文立即发布，控制事件始终先排空前驱文字。
 * 原始轨迹不经过此路径，取消订阅会丢弃尚未发布的增量并释放计时器。
 */
export function subscribeBufferedRuntimeEvents(
  subscribe: (listener: (event: RuntimeAgentEvent) => void) => () => void,
  listener: (event: RuntimeAgentEvent) => void,
): () => void {
  let pending: DeltaEvent | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  let messageStarted = false;
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const flush = () => {
    clearTimer();
    const event = pending;
    pending = undefined;
    if (active && event !== undefined) listener(event);
  };
  const unsubscribe = subscribe((event) => {
    if (!active) return;
    if (event.type !== "thinking.delta" && event.type !== "message.delta") {
      flush();
      if (
        event.type === "message.completed" ||
        event.type === "turn.completed" ||
        event.type === "agent.started" ||
        event.type === "agent.settled" ||
        event.type === "error"
      ) {
        messageStarted = false;
      }
      if (active) listener(event);
      return;
    }
    if (pending !== undefined && pending.type !== event.type) flush();
    if (!active || event.delta.length === 0) return;
    if (event.type === "message.delta" && !messageStarted) {
      messageStarted = true;
      listener(event);
      return;
    }
    // 不切割 Provider 单个大增量，也不与缓冲拼成更大事件，保留 Worker 原有大小拒绝边界。
    if (Buffer.byteLength(event.delta, "utf8") >= FLUSH_BYTES) {
      flush();
      if (active) listener(event);
      return;
    }
    if (
      pending !== undefined &&
      Buffer.byteLength(pending.delta + event.delta, "utf8") > FLUSH_BYTES
    ) {
      flush();
    }
    if (!active) return;
    const buffered = { type: event.type, delta: (pending?.delta ?? "") + event.delta };
    pending = buffered;
    if (Buffer.byteLength(buffered.delta, "utf8") >= FLUSH_BYTES) flush();
    else
      timer ??= setTimeout(
        flush,
        event.type === "message.delta" ? MESSAGE_FLUSH_MS : THINKING_FLUSH_MS,
      );
  });
  return () => {
    if (!active) return;
    active = false;
    clearTimer();
    pending = undefined;
    unsubscribe();
  };
}

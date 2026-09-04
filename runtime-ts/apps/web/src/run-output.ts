import { ApiError, type Run, type RunEventPage, type RuntimeApi } from "./api.js";
import { drainEventPages } from "./polling.js";

/** 首批与控制事件立即发布；文字合并由 50ms 定时器兜底，隐藏标签页不依赖动画帧排空。 */
export class RunOutputBuffer {
  private pending: RunEventPage | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frame: number | undefined;
  private published = false;

  constructor(private readonly publish: (page: RunEventPage) => void) {}

  push(page: RunEventPage): void {
    const previous = this.pending;
    this.pending =
      previous !== undefined && previous.attemptId === page.attemptId
        ? { ...page, items: [...previous.items, ...page.items] }
        : page;
    if (
      !this.published ||
      page.items.some((event) => event.type !== "message.delta" && event.type !== "thinking.delta")
    ) {
      this.flush();
      return;
    }
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => this.flush(), 50);
    if (typeof requestAnimationFrame === "function") {
      let remaining = 3;
      const next = () => {
        remaining -= 1;
        if (remaining === 0) this.flush();
        else this.frame = requestAnimationFrame(next);
      };
      this.frame = requestAnimationFrame(next);
    }
  }

  flush(): void {
    const page = this.pending;
    this.cancel();
    if (page === undefined) return;
    this.published ||= page.items.length > 0;
    this.publish(page);
  }

  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.timer = undefined;
    this.frame = undefined;
    this.pending = undefined;
  }
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

/** 一个消费者拥有游标和重连；辅助接口与这个循环没有等待关系。 */
export async function followRunOutput(options: {
  readonly api: Pick<RuntimeApi, "streamEvents" | "listEvents" | "getRun">;
  readonly threadId: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly onPage: (page: RunEventPage) => void;
  readonly onRun: (run: Run) => void;
  readonly onSettled: () => void;
  readonly onError: (error: ApiError) => void;
}): Promise<void> {
  const { api, threadId, runId, signal } = options;
  let after = -1;
  let attemptId: string | undefined;
  let fallback = false;
  let failures = 0;
  const buffer = new RunOutputBuffer(options.onPage);
  const receive = (page: RunEventPage, run: Run) => {
    if (signal.aborted) return;
    let nextAfter = attemptId === page.attemptId ? after : -1;
    const fresh = page.items.filter((item) => item.sequence > nextAfter);
    for (const item of fresh) {
      if (item.sequence !== nextAfter + 1) throw new ApiError("实时事件序列不连续", 502, true);
      nextAfter = item.sequence;
    }
    // 整页验证成功才能推进游标，避免错误帧中的前半页在重连时被跳过。
    attemptId = page.attemptId;
    after = nextAfter;
    options.onRun(run);
    buffer.push({ ...page, items: fresh });
  };
  try {
    while (!signal.aborted) {
      try {
        if (fallback) {
          const page = await drainEventPages(
            (cursor, limit) => api.listEvents(threadId, runId, cursor, limit),
            after,
            attemptId,
          );
          if (signal.aborted) return;
          // 正文先发布，状态查询的耗时不能重新进入文字关键路径。
          attemptId = page.attemptId;
          after = page.nextAfter;
          buffer.push(page);
          const run = await api.getRun(threadId, runId);
          if (signal.aborted) return;
          options.onRun(run);
          if (
            !page.hasMore &&
            (!["queued", "running"].includes(run.status) ||
              run.executionStatus === "recovery_required")
          ) {
            buffer.flush();
            options.onSettled();
            return;
          }
          if (!page.hasMore) await pause(1_000, signal);
        } else {
          const deadline = AbortSignal.timeout(45_000);
          const reason = await api.streamEvents(
            threadId,
            runId,
            { after, attemptId },
            AbortSignal.any([signal, deadline]),
            receive,
          );
          if (signal.aborted) return;
          buffer.flush();
          if (reason === "settled") {
            options.onSettled();
            return;
          }
        }
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        buffer.flush();
        if (error instanceof ApiError && error.status === 404 && !fallback) {
          fallback = true;
          continue;
        }
        const failure =
          error instanceof ApiError ? error : new ApiError("实时输出暂时中断，正在重连", 0, true);
        if (!failure.retryable) {
          options.onError(failure);
          return;
        }
        failures += 1;
        if (failures >= 3) options.onError(failure);
        await pause(Math.min(5_000, 250 * 2 ** Math.min(failures - 1, 5)), signal);
      }
    }
  } finally {
    buffer.cancel();
  }
}

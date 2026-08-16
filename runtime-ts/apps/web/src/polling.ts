import { EVENT_PAGE_LIMIT, type RunEvent, type RunEventPage } from "./api.js";

export type DrainedEventPage = {
  readonly attemptId: string | undefined;
  readonly items: readonly RunEvent[];
  /** 本轮最后确认的游标；达到页数上限时由下一轮从这里继续。 */
  readonly nextAfter: number;
  readonly hasMore: boolean;
};

export const MAX_EVENT_PAGES_PER_POLL = 8;

export type RunPollGeneration = {
  readonly threadId: string;
  readonly runId: string;
  readonly generation: number;
};

/** 同步代次闩锁：网络响应只能更新创建它时仍为 current 的 Run。 */
export class CurrentRunPoll {
  #generation = 0;
  #current: RunPollGeneration | undefined;

  activate(threadId: string, runId: string): RunPollGeneration {
    const current = Object.freeze({ threadId, runId, generation: ++this.#generation });
    this.#current = current;
    return current;
  }

  invalidate(expected?: RunPollGeneration): void {
    if (expected !== undefined && !this.isCurrent(expected)) return;
    this.#generation += 1;
    this.#current = undefined;
  }

  isCurrent(expected: RunPollGeneration): boolean {
    return (
      this.#current?.generation === expected.generation &&
      this.#current.threadId === expected.threadId &&
      this.#current.runId === expected.runId
    );
  }
}

/**
 * 拉空当前 Attempt 的事件页。Attempt 在请求间变化时，旧游标对新 Attempt 无效，
 * 必须从 -1 重新读取，不能把一次被旧 after 过滤的空页误判为完成。
 */
export async function drainEventPages(
  listPage: (after: number, limit: number) => Promise<RunEventPage>,
  initialAfter: number,
  expectedAttemptId: string | undefined,
): Promise<DrainedEventPage> {
  let after = initialAfter;
  let attemptId = expectedAttemptId;
  let items: RunEvent[] = [];

  for (let pageNumber = 0; pageNumber < MAX_EVENT_PAGES_PER_POLL; pageNumber += 1) {
    const page = await listPage(after, EVENT_PAGE_LIMIT);
    if (page.attemptId !== attemptId) {
      attemptId = page.attemptId;
      items = [];
      if (after !== -1) {
        after = -1;
        continue;
      }
    }

    items.push(...page.items);
    const hasMore = page.hasMore ?? page.items.length >= EVENT_PAGE_LIMIT;
    const nextAfter = page.items.at(-1)?.sequence ?? after;
    if (!hasMore) return { attemptId, items, nextAfter, hasMore: false };

    // 服务端声明还有数据却没有推进游标时终止，避免协议异常形成无界请求。
    if (nextAfter <= after) return { attemptId, items, nextAfter: after, hasMore: false };
    after = nextAfter;
  }
  return { attemptId, items, nextAfter: after, hasMore: true };
}

/** 历史过程只在用户展开时读取；游标必须持续推进，避免异常分页形成无界请求。 */
export async function loadAllRunEvents(
  listPage: (after: number, limit: number) => Promise<RunEventPage>,
): Promise<readonly RunEvent[]> {
  let after = -1;
  let attemptId: string | undefined;
  let items: RunEvent[] = [];
  for (;;) {
    const page = await drainEventPages(listPage, after, attemptId);
    if (page.attemptId !== attemptId) items = [];
    attemptId = page.attemptId;
    items.push(...page.items);
    if (!page.hasMore) return items;
    if (page.nextAfter <= after) throw new Error("历史 Run 事件分页游标未推进");
    after = page.nextAfter;
  }
}

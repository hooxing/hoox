import { EVENT_PAGE_LIMIT, type RunEvent, type RunEventPage } from "./api.js";

export type DrainedEventPage = {
  readonly attemptId: string | undefined;
  readonly items: readonly RunEvent[];
};

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

  for (;;) {
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
    if (!hasMore) return { attemptId, items };

    const nextAfter = page.items.at(-1)?.sequence;
    // 服务端声明还有数据却没有推进游标时终止，避免协议异常形成无界请求。
    if (nextAfter === undefined || nextAfter <= after) return { attemptId, items };
    after = nextAfter;
  }
}

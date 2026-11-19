import { Readable } from "node:stream";
import type { RunDto, RunEventStreamQuery } from "@hoox/protocol";
import type { RunExperienceReadPort } from "@hoox/persistence/postgres";

type EventRead = Extract<
  Awaited<ReturnType<RunExperienceReadPort["listEvents"]>>,
  { outcome: "found" }
>;
export type RunEventStreamRead = { readonly run: RunDto; readonly page: EventRead };

/** 通知只唤醒受背压约束的补读；每次读取均由调用方重新验证凭据与归属。 */
export async function openRunEventStream(options: {
  readonly cursor: RunEventStreamQuery;
  readonly signal: AbortSignal;
  readonly read: (after: number) => Promise<RunEventStreamRead>;
  readonly watch: (wake: () => void) => () => void;
  readonly publicType: (kind: string, payload: Readonly<Record<string, unknown>>) => string;
  readonly retryMs?: number;
  readonly lifetimeMs?: number;
}): Promise<Readable> {
  let revision = 0;
  let resume: (() => void) | undefined;
  const wake = () => {
    revision += 1;
    resume?.();
  };
  const unwatch = options.watch(wake);
  const { signal } = options;
  signal.addEventListener("abort", wake);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unwatch();
    signal.removeEventListener("abort", wake);
    resume?.();
  };
  let after = options.cursor.after ?? -1;
  let attemptId = options.cursor.attemptId;
  const read = async () => {
    for (let resets = 0; resets < 8; resets += 1) {
      const value = await options.read(after);
      if (value.page.attemptId !== attemptId) {
        attemptId = value.page.attemptId;
        if (after !== -1) {
          after = -1;
          continue;
        }
      }
      return value;
    }
    throw new Error("Run Attempt 持续变化，需重新建立事件流");
  };
  let first: RunEventStreamRead;
  let readRevision = revision;
  try {
    first = await read();
  } catch (error) {
    dispose();
    throw error;
  }
  const startedAt = Date.now();
  const wait = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, options.retryMs ?? 1_000);
      function done() {
        clearTimeout(timer);
        resume = undefined;
        resolve();
      }
      resume = done;
      if (signal.aborted || disposed || revision !== readRevision) done();
    });
  const frame = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  async function* frames() {
    let value = first;
    try {
      while (!signal.aborted && !disposed) {
        const { page, run } = value;
        const items = page.events.map((event) => ({
          eventId: `${page.attemptId ?? "pending"}-${event.sequence}`,
          sequence: event.sequence,
          kind: event.kind,
          type: options.publicType(event.kind, event.payload),
          payload: event.payload,
          occurredAt: event.occurredAt,
        }));
        yield frame("run-events", {
          run,
          page: { attemptId: page.attemptId, items, hasMore: page.hasMore },
        });
        after = items.at(-1)?.sequence ?? after;
        if (
          !page.hasMore &&
          (run.executionStatus === "recovery_required" ||
            !["queued", "running"].includes(run.status))
        ) {
          yield frame("end", { reason: "settled" });
          return;
        }
        if (Date.now() - startedAt >= (options.lifetimeMs ?? 30_000)) {
          yield frame("end", { reason: "renew" });
          return;
        }
        if (!page.hasMore) await wait();
        if (signal.aborted || disposed) return;
        readRevision = revision;
        value = await read();
      }
    } finally {
      dispose();
    }
  }
  const stream = Readable.from(frames(), { objectMode: false, highWaterMark: 16_384 });
  const abort = () => {
    stream.destroy();
  };
  signal.addEventListener("abort", abort, { once: true });
  stream.once("close", () => {
    signal.removeEventListener("abort", abort);
    dispose();
  });
  if (signal.aborted) stream.destroy();
  return stream;
}

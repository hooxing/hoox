/** 所有子任务结束后才报告维护结果，确保停机 drain 覆盖每个已经启动的副作用。 */
export async function performWorkerMaintenance(input: {
  readonly recoverResourceBlobs: () => Promise<{
    readonly claimed: number;
    readonly converged: number;
  }>;
  readonly drainMemory: () => Promise<unknown>;
  readonly drainTitles?: () => Promise<unknown>;
  readonly drainScheduledTasks: () => Promise<unknown>;
  readonly resourceBlobBatchLimit: number;
}): Promise<void> {
  const [blobs, memory, tasks, titles] = await Promise.allSettled([
    Promise.resolve().then(input.recoverResourceBlobs),
    Promise.resolve().then(input.drainMemory),
    Promise.resolve().then(input.drainScheduledTasks),
    Promise.resolve().then(() => input.drainTitles?.()),
  ]);
  if (
    blobs.status === "rejected" ||
    memory.status === "rejected" ||
    tasks.status === "rejected" ||
    titles.status === "rejected" ||
    blobs.value.claimed > blobs.value.converged ||
    blobs.value.claimed >= input.resourceBlobBatchLimit
  ) {
    throw new Error("WORKER_MAINTENANCE_INCOMPLETE");
  }
}

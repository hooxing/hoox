import type {
  Artifact,
  ModelWireTracePage,
  ModelWireTraceRecord,
  Run,
  RunEvent,
  RunEventPage,
  Thread,
  ThreadContextMessage,
} from "./api.js";

export type WorkspaceState = {
  readonly threads: readonly Thread[];
  readonly selectedThreadId: string | undefined;
  /** 同一 Thread 被再次选中也递增，拒绝跨导航边界的迟到恢复响应。 */
  readonly selectionGeneration: number;
  readonly run: Run | undefined;
  readonly eventAttemptId: string | undefined;
  readonly events: readonly RunEvent[];
  readonly threadContext: readonly ThreadContextMessage[] | undefined;
  readonly artifacts: readonly Artifact[];
  readonly modelWireTraces: readonly ModelWireTraceRecord[];
  /** 最近一次无游标首屏包含的复合身份；刷新首屏时只替换这一段。 */
  readonly modelWireTraceHeadKeys: readonly string[];
  /** 用户已沿游标加载过后续页；后续首屏轮询不得把分页位置退回第一页。 */
  readonly modelWireTracePaginationAdvanced: boolean;
  /** 已经抵达过尾页；后续新增突发即使跨页也持续沿尾游标追赶。 */
  readonly modelWireTraceTailFollowing: boolean;
  readonly modelWireTraceHasMore: boolean;
  readonly modelWireTraceUnavailable: boolean;
  readonly modelWireTraceNextCursor: string | undefined;
};

export const initialWorkspaceState: WorkspaceState = {
  threads: [],
  selectedThreadId: undefined,
  selectionGeneration: 0,
  run: undefined,
  eventAttemptId: undefined,
  events: [],
  threadContext: undefined,
  artifacts: [],
  modelWireTraces: [],
  modelWireTraceHeadKeys: [],
  modelWireTracePaginationAdvanced: false,
  modelWireTraceTailFollowing: false,
  modelWireTraceHasMore: false,
  modelWireTraceUnavailable: false,
  modelWireTraceNextCursor: undefined,
};

export function mergeEvents(
  existing: readonly RunEvent[],
  incoming: readonly RunEvent[],
): readonly RunEvent[] {
  const unique = new Map<number, RunEvent>();
  for (const event of [...existing, ...incoming]) unique.set(event.sequence, event);
  return [...unique.values()].sort((left, right) => left.sequence - right.sequence);
}

export function workspaceReducer(
  state: WorkspaceState,
  action:
    | { readonly type: "threads"; readonly threads: readonly Thread[] }
    | { readonly type: "threadCreated"; readonly thread: Thread }
    | { readonly type: "threadUpdated"; readonly thread: Thread }
    | { readonly type: "threadArchived"; readonly threadId: string }
    | { readonly type: "select"; readonly threadId: string | undefined }
    | {
        readonly type: "recoverLatestRun";
        readonly threadId: string;
        readonly selectionGeneration: number;
        readonly run: Run | undefined;
      }
    | { readonly type: "startRun"; readonly run: Run }
    | { readonly type: "run"; readonly run: Run }
    | { readonly type: "events"; readonly page: RunEventPage }
    | {
        readonly type: "threadContext";
        readonly items: readonly ThreadContextMessage[] | undefined;
      }
    | { readonly type: "artifacts"; readonly artifacts: readonly Artifact[] }
    | {
        readonly type: "modelWireTraces";
        readonly page: ModelWireTracePage;
        readonly mode: "replace" | "refreshHead" | "append";
      },
): WorkspaceState {
  switch (action.type) {
    case "threads":
      return { ...state, threads: action.threads };
    case "threadCreated":
      return {
        ...state,
        threads: [
          action.thread,
          ...state.threads.filter((thread) => thread.id !== action.thread.id),
        ],
      };
    case "threadUpdated":
      return {
        ...state,
        threads: state.threads.map((thread) =>
          thread.id === action.thread.id ? action.thread : thread,
        ),
      };
    case "threadArchived":
      return {
        ...state,
        threads: state.threads.filter((thread) => thread.id !== action.threadId),
      };
    case "select":
      return {
        ...state,
        selectedThreadId: action.threadId,
        selectionGeneration: state.selectionGeneration + 1,
        run: undefined,
        eventAttemptId: undefined,
        events: [],
        threadContext: undefined,
        artifacts: [],
        modelWireTraces: [],
        modelWireTraceHeadKeys: [],
        modelWireTracePaginationAdvanced: false,
        modelWireTraceTailFollowing: false,
        modelWireTraceHasMore: false,
        modelWireTraceUnavailable: false,
        modelWireTraceNextCursor: undefined,
      };
    case "recoverLatestRun":
      // 仅接受本次选择代次发起的恢复；切走再切回同一 Thread 时旧响应也必须失效。
      if (
        state.selectedThreadId !== action.threadId ||
        state.selectionGeneration !== action.selectionGeneration
      ) {
        return state;
      }
      return {
        ...state,
        run: action.run,
        eventAttemptId: undefined,
        events: [],
        artifacts: [],
        modelWireTraces: [],
        modelWireTraceHeadKeys: [],
        modelWireTracePaginationAdvanced: false,
        modelWireTraceTailFollowing: false,
        modelWireTraceHasMore: false,
        modelWireTraceUnavailable: false,
        modelWireTraceNextCursor: undefined,
      };
    case "run":
      return { ...state, run: action.run };
    case "startRun":
      return {
        ...state,
        run: action.run,
        eventAttemptId: undefined,
        events: [],
        artifacts: [],
        modelWireTraces: [],
        modelWireTraceHeadKeys: [],
        modelWireTracePaginationAdvanced: false,
        modelWireTraceTailFollowing: false,
        modelWireTraceHasMore: false,
        modelWireTraceUnavailable: false,
        modelWireTraceNextCursor: undefined,
      };
    case "events":
      return action.page.attemptId !== state.eventAttemptId
        ? { ...state, eventAttemptId: action.page.attemptId, events: action.page.items }
        : { ...state, events: mergeEvents(state.events, action.page.items) };
    case "threadContext":
      return { ...state, threadContext: action.items };
    case "artifacts":
      return { ...state, artifacts: action.artifacts };
    case "modelWireTraces": {
      if (action.mode === "refreshHead" && action.page.unavailable === true) {
        return { ...state, modelWireTraceUnavailable: true };
      }
      const pageKeys = action.page.items.map(modelWireTraceKey);
      if (action.mode === "replace") {
        return {
          ...state,
          modelWireTraces: mergeModelWireTraces([], action.page.items),
          modelWireTraceHeadKeys: pageKeys,
          modelWireTracePaginationAdvanced: false,
          modelWireTraceTailFollowing: false,
          modelWireTraceHasMore: action.page.hasMore,
          modelWireTraceUnavailable: action.page.unavailable === true,
          modelWireTraceNextCursor: action.page.nextCursor,
        };
      }
      if (action.mode === "refreshHead") {
        const previousHeadKeys = new Set(state.modelWireTraceHeadKeys);
        const loadedTail = state.modelWireTraces.filter(
          (record) => !previousHeadKeys.has(modelWireTraceKey(record)),
        );
        return {
          ...state,
          modelWireTraces: mergeModelWireTraces(loadedTail, action.page.items),
          modelWireTraceHeadKeys: pageKeys,
          modelWireTraceHasMore: state.modelWireTracePaginationAdvanced
            ? state.modelWireTraceHasMore
            : action.page.hasMore,
          modelWireTraceUnavailable: false,
          modelWireTraceNextCursor: state.modelWireTracePaginationAdvanced
            ? state.modelWireTraceNextCursor
            : action.page.nextCursor,
        };
      }
      return {
        ...state,
        modelWireTraces: mergeModelWireTraces(state.modelWireTraces, action.page.items),
        modelWireTracePaginationAdvanced: true,
        modelWireTraceTailFollowing: state.modelWireTraceTailFollowing || !action.page.hasMore,
        modelWireTraceHasMore: action.page.hasMore,
        modelWireTraceUnavailable: action.page.unavailable === true,
        // 到尾后的空增量页没有自身末项；保留上次终点，下一轮继续从同一事实位置追新记录。
        modelWireTraceNextCursor: action.page.nextCursor ?? state.modelWireTraceNextCursor,
      };
    }
  }
}

function modelWireTraceKey(record: ModelWireTraceRecord): string {
  return `${record.attemptId}\u0000${record.modelTurn}\u0000${record.transportAttempt}\u0000${record.part}`;
}

function mergeModelWireTraces(
  existing: readonly ModelWireTraceRecord[],
  incoming: readonly ModelWireTraceRecord[],
): readonly ModelWireTraceRecord[] {
  const records = new Map<string, ModelWireTraceRecord>();
  for (const record of [...existing, ...incoming]) {
    records.set(modelWireTraceKey(record), record);
  }
  return [...records.values()].sort(compareModelWireTraces);
}

function compareModelWireTraces(left: ModelWireTraceRecord, right: ModelWireTraceRecord): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.attemptId.localeCompare(right.attemptId) ||
    left.modelTurn - right.modelTurn ||
    left.transportAttempt - right.transportAttempt ||
    left.part.localeCompare(right.part)
  );
}

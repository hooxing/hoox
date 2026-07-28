import type { Artifact, Run, RunEvent, RunEventPage, Thread } from "./api.js";

export type WorkspaceState = {
  readonly threads: readonly Thread[];
  readonly selectedThreadId: string | undefined;
  /** 同一 Thread 被再次选中也递增，拒绝跨导航边界的迟到恢复响应。 */
  readonly selectionGeneration: number;
  readonly run: Run | undefined;
  readonly eventAttemptId: string | undefined;
  readonly events: readonly RunEvent[];
  readonly artifacts: readonly Artifact[];
};

export const initialWorkspaceState: WorkspaceState = {
  threads: [],
  selectedThreadId: undefined,
  selectionGeneration: 0,
  run: undefined,
  eventAttemptId: undefined,
  events: [],
  artifacts: [],
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
    | { readonly type: "artifacts"; readonly artifacts: readonly Artifact[] },
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
        artifacts: [],
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
      };
    case "events":
      return action.page.attemptId !== state.eventAttemptId
        ? { ...state, eventAttemptId: action.page.attemptId, events: action.page.items }
        : { ...state, events: mergeEvents(state.events, action.page.items) };
    case "artifacts":
      return { ...state, artifacts: action.artifacts };
  }
}

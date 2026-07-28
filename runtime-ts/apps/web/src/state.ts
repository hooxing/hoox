import type { Artifact, Run, RunEvent, Thread } from "./api.js";

export type WorkspaceState = {
  readonly threads: readonly Thread[];
  readonly selectedThreadId: string | undefined;
  readonly run: Run | undefined;
  readonly events: readonly RunEvent[];
  readonly artifacts: readonly Artifact[];
};

export const initialWorkspaceState: WorkspaceState = {
  threads: [],
  selectedThreadId: undefined,
  run: undefined,
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
    | { readonly type: "select"; readonly threadId: string }
    | { readonly type: "run"; readonly run: Run }
    | { readonly type: "events"; readonly events: readonly RunEvent[] }
    | { readonly type: "artifacts"; readonly artifacts: readonly Artifact[] },
): WorkspaceState {
  switch (action.type) {
    case "threads":
      return { ...state, threads: action.threads };
    case "select":
      return {
        ...state,
        selectedThreadId: action.threadId,
        run: undefined,
        events: [],
        artifacts: [],
      };
    case "run":
      return { ...state, run: action.run };
    case "events":
      return { ...state, events: mergeEvents(state.events, action.events) };
    case "artifacts":
      return { ...state, artifacts: action.artifacts };
  }
}

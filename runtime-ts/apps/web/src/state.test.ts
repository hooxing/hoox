import { describe, expect, it } from "vitest";
import type { ModelWireTraceRecord } from "./api.js";
import { initialWorkspaceState, mergeEvents, workspaceReducer } from "./state.js";

function modelWireTrace(index: number): ModelWireTraceRecord {
  return {
    attemptId: "attempt_1",
    modelTurn: index,
    transportAttempt: 0,
    part: "request",
    captureStatus: "complete",
    persistenceStatus: "stored",
    bodyAvailable: true,
    createdAt: new Date(Date.UTC(2026, 6, 30, 0, 0, 0, index)).toISOString(),
    expiresAt: "2026-08-06T00:00:00.000Z",
  };
}

describe("mergeEvents", () => {
  it("按序号去重并保持事件顺序", () => {
    const event = (sequence: number) => ({
      eventId: `evt_${sequence}`,
      sequence,
      occurredAt: "2026-01-01T00:00:00Z",
      kind: "agent_event",
      type: "text",
      payload: "x",
    });
    expect(
      mergeEvents([event(2)], [event(1), event(2), event(3)]).map((value) => value.sequence),
    ).toEqual([1, 2, 3]);
  });

  it("Attempt 变化时替换同 sequence 的旧事件", () => {
    const oldEvent = {
      eventId: "event-1",
      sequence: 1,
      occurredAt: "",
      kind: "agent_event",
      type: "message.delta",
      payload: { delta: "旧" },
    };
    const newEvent = { ...oldEvent, payload: { delta: "新" } };
    const afterFirst = workspaceReducer(initialWorkspaceState, {
      type: "events",
      page: { attemptId: "attempt_1", items: [oldEvent] },
    });
    const afterRecovery = workspaceReducer(afterFirst, {
      type: "events",
      page: { attemptId: "attempt_2", items: [newEvent] },
    });
    expect(afterRecovery).toMatchObject({ eventAttemptId: "attempt_2", events: [newEvent] });
  });

  it("startRun 原子清空上一 Run 的事件、Attempt、产物和诊断分页", () => {
    const run = {
      id: "run_2",
      threadId: "thread_1",
      status: "queued" as const,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const dirty = {
      ...initialWorkspaceState,
      eventAttemptId: "attempt_1",
      events: [
        {
          eventId: "event-9",
          sequence: 9,
          occurredAt: "",
          kind: "agent_event",
          type: "message.delta",
          payload: { delta: "旧" },
        },
      ],
      artifacts: [
        {
          id: "artifact_1",
          name: "旧产物",
          status: "published" as const,
          createdAt: "",
          updatedAt: "",
        },
      ],
      modelWireTraces: [modelWireTrace(0)],
      modelWireTraceHeadKeys: ["旧首屏"],
      modelWireTracePaginationAdvanced: true,
      modelWireTraceTailFollowing: true,
      modelWireTraceHasMore: true,
      modelWireTraceNextCursor: "旧游标",
    };
    expect(workspaceReducer(dirty, { type: "startRun", run })).toMatchObject({
      run,
      eventAttemptId: undefined,
      events: [],
      artifacts: [],
      modelWireTraces: [],
      modelWireTraceHeadKeys: [],
      modelWireTracePaginationAdvanced: false,
      modelWireTraceTailFollowing: false,
      modelWireTraceHasMore: false,
      modelWireTraceNextCursor: undefined,
    });
  });

  it("恢复只接受当前 Thread 的当前选择代次，并清空旧 Run 投影", () => {
    const selected = workspaceReducer(initialWorkspaceState, {
      type: "select",
      threadId: "thread_1",
    });
    const recoveredRun = {
      id: "run_2",
      threadId: "thread_1",
      status: "succeeded" as const,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const stale = workspaceReducer(selected, {
      type: "recoverLatestRun",
      threadId: "thread_1",
      selectionGeneration: 0,
      run: recoveredRun,
    });
    expect(stale).toBe(selected);
    const recovered = workspaceReducer(selected, {
      type: "recoverLatestRun",
      threadId: "thread_1",
      selectionGeneration: selected.selectionGeneration,
      run: recoveredRun,
    });
    expect(recovered).toMatchObject({ run: recoveredRun, events: [], artifacts: [] });
  });

  it("迟到的 Thread 创建与归档只更新列表，不隐式改写当前选择", () => {
    const thread = {
      id: "thread_2",
      title: "新线程",
      status: "active" as const,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const selected = { ...initialWorkspaceState, selectedThreadId: "thread_1" };
    const afterCreate = workspaceReducer(selected, { type: "threadCreated", thread });
    expect(afterCreate).toMatchObject({
      selectedThreadId: "thread_1",
      threads: [thread],
    });
    expect(
      workspaceReducer(afterCreate, { type: "threadArchived", threadId: "thread_2" }),
    ).toMatchObject({ selectedThreadId: "thread_1", threads: [] });
  });

  it("首屏500条追加第501条后，轮询更新首屏且保留后续页、去重并不回退游标", () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => modelWireTrace(index));
    const first = workspaceReducer(initialWorkspaceState, {
      type: "modelWireTraces",
      mode: "replace",
      page: { items: firstPage, hasMore: true, nextCursor: "cursor_500" },
    });
    const tail = modelWireTrace(500);
    const appended = workspaceReducer(first, {
      type: "modelWireTraces",
      mode: "append",
      page: {
        items: [firstPage[499] as ModelWireTraceRecord, tail],
        hasMore: false,
        nextCursor: "cursor_501",
      },
    });
    const refreshedHead = firstPage.map((record, index) =>
      index === 0
        ? {
            ...record,
            captureStatus: "truncated" as const,
            persistenceStatus: "unavailable" as const,
            bodyAvailable: false,
          }
        : record,
    );
    const refreshed = workspaceReducer(appended, {
      type: "modelWireTraces",
      mode: "refreshHead",
      page: { items: refreshedHead, hasMore: true, nextCursor: "cursor_new_head" },
    });

    expect(refreshed.modelWireTraces).toHaveLength(501);
    expect(refreshed.modelWireTraces.filter((record) => record.modelTurn === 499)).toHaveLength(1);
    expect(refreshed.modelWireTraces).toContain(tail);
    expect(refreshed.modelWireTraces[0]).toMatchObject({
      captureStatus: "truncated",
      persistenceStatus: "unavailable",
      bodyAvailable: false,
    });
    expect(refreshed.modelWireTraceHasMore).toBe(false);
    expect(refreshed.modelWireTraceNextCursor).toBe("cursor_501");

    const burstTail = modelWireTrace(501);
    const burst = workspaceReducer(refreshed, {
      type: "modelWireTraces",
      mode: "append",
      page: { items: [burstTail], hasMore: true, nextCursor: "cursor_502" },
    });
    expect(burst.modelWireTraceTailFollowing).toBe(true);
    const finalTail = modelWireTrace(502);
    const advanced = workspaceReducer(burst, {
      type: "modelWireTraces",
      mode: "append",
      page: { items: [finalTail], hasMore: false, nextCursor: "cursor_503" },
    });
    const emptyTailPoll = workspaceReducer(advanced, {
      type: "modelWireTraces",
      mode: "append",
      page: { items: [], hasMore: false },
    });
    const polledAgain = workspaceReducer(emptyTailPoll, {
      type: "modelWireTraces",
      mode: "refreshHead",
      page: { items: refreshedHead, hasMore: true, nextCursor: "cursor_newer_head" },
    });
    expect(polledAgain.modelWireTraceHasMore).toBe(false);
    expect(polledAgain.modelWireTraceNextCursor).toBe("cursor_503");
    expect(polledAgain.modelWireTraces).toHaveLength(503);
    expect(polledAgain.modelWireTraces).toContain(burstTail);
    expect(polledAgain.modelWireTraces).toContain(finalTail);
  });

  it("首屏刷新删除旧首屏残留但保留明确加载的后续页", () => {
    const head = modelWireTrace(0);
    const tail = modelWireTrace(1);
    const first = workspaceReducer(initialWorkspaceState, {
      type: "modelWireTraces",
      mode: "replace",
      page: { items: [head], hasMore: true, nextCursor: "cursor_1" },
    });
    const appended = workspaceReducer(first, {
      type: "modelWireTraces",
      mode: "append",
      page: { items: [tail], hasMore: false, nextCursor: "cursor_2" },
    });
    const refreshed = workspaceReducer(appended, {
      type: "modelWireTraces",
      mode: "refreshHead",
      page: { items: [], hasMore: false },
    });
    expect(refreshed.modelWireTraces).toEqual([tail]);
  });
});

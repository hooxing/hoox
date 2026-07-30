import { describe, expect, it } from "vitest";
import { initialWorkspaceState, mergeEvents, workspaceReducer } from "./state.js";

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

  it("startRun 原子清空上一 Run 的事件、Attempt 和产物", () => {
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
    };
    expect(workspaceReducer(dirty, { type: "startRun", run })).toMatchObject({
      run,
      eventAttemptId: undefined,
      events: [],
      artifacts: [],
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

  it("模型网络诊断后续页按复合身份追加并推进游标", () => {
    const trace = {
      attemptId: "attempt_1",
      modelTurn: 0,
      transportAttempt: 0,
      part: "request" as const,
      captureStatus: "complete" as const,
      persistenceStatus: "stored" as const,
      bodyAvailable: true,
      createdAt: "2026-07-30T00:00:00.000Z",
      expiresAt: "2026-08-06T00:00:00.000Z",
    };
    const first = workspaceReducer(initialWorkspaceState, {
      type: "modelWireTraces",
      page: { items: [trace], hasMore: true, nextCursor: "cursor_1" },
    });
    const secondTrace = { ...trace, part: "response" as const };
    const second = workspaceReducer(first, {
      type: "modelWireTraces",
      mode: "append",
      page: { items: [trace, secondTrace], hasMore: false },
    });
    expect(second.modelWireTraces).toEqual([trace, secondTrace]);
    expect(second.modelWireTraceHasMore).toBe(false);
    expect(second.modelWireTraceNextCursor).toBeUndefined();
  });
});

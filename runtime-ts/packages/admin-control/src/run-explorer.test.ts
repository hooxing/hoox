import { describe, expect, it, vi } from "vitest";
import {
  controlCapabilities,
  decodeRunExplorerCursor,
  encodeRunExplorerCursor,
  type RunExplorerEventRow,
  type RunExplorerRepository,
  type RunExplorerRunRecord,
  RunExplorerService,
} from "./run-explorer.js";

const secret = "SECRET-用户正文";

function run(overrides: Partial<RunExplorerRunRecord> = {}): RunExplorerRunRecord {
  return {
    tenantId: "tenant_a",
    runId: "run_1",
    threadId: "thread_1",
    threadTitle: "故障排查问题",
    userInput: "SECRET-用户正文 问题",
    status: "succeeded",
    createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:01:00.000Z",
    agentDefinitionId: null,
    agentRevisionId: null,
    origin: null,
    attemptCount: 2,
    attempts: [
      {
        attemptId: "attempt_1",
        status: "failed",
        stage: "finished",
        createdAt: "2026-11-19T00:00:01.000Z",
      },
      {
        attemptId: "attempt_2",
        status: "succeeded",
        stage: "finished",
        createdAt: "2026-11-19T00:00:30.000Z",
      },
    ],
    latestAttemptId: "attempt_2",
    latestAttemptStatus: "succeeded",
    modelCalls: 2,
    toolCalls: 1,
    failedToolCalls: 0,
    errorCount: 0,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, generationDurationMs: 100 },
    ...overrides,
  };
}

const fullEvents: readonly RunExplorerEventRow[] = [
  {
    attemptId: "attempt_2",
    sequence: 0,
    kind: "agent_event",
    occurredAt: "2026-11-19T00:00:31.000Z",
    payload: { type: "message.delta", delta: secret },
  },
  {
    attemptId: "attempt_2",
    sequence: 1,
    kind: "agent_event",
    occurredAt: "2026-11-19T00:00:32.000Z",
    payload: { type: "message.completed", stopReason: "stop" },
  },
];

function repository(role: "viewer" | "operator" | "admin" | undefined) {
  return {
    resolveRole: vi.fn(async () => role),
    listRuns: vi.fn(async (_input: Parameters<RunExplorerRepository["listRuns"]>[0]) => [
      run(),
      run({ runId: "run_2" }),
      run({ runId: "run_3" }),
    ]),
    getRun: vi.fn(async (input: { readonly runId: string }) =>
      input.runId === "missing" ? undefined : run(),
    ),
    // 即使存储返回含正文的行，结构详情也必须经 outline 剥离。
    readOutline: vi.fn(async () => fullEvents),
    readContent: vi.fn(
      async (_input: Parameters<RunExplorerRepository["readContent"]>[0]) => fullEvents,
    ),
  } satisfies RunExplorerRepository;
}

describe("Run 浏览器权限", () => {
  it("正文权限默认只授予 admin", () => {
    expect(controlCapabilities("viewer")).not.toContain("run_content.read");
    expect(controlCapabilities("operator")).not.toContain("run_content.read");
    expect(controlCapabilities("admin")).toContain("run_content.read");
    expect(controlCapabilities(undefined)).toEqual([]);
  });

  it("非控制面成员不能读取任何 Run 数据", async () => {
    const store = repository(undefined);
    const service = new RunExplorerService(store, () => "run_content_audit");
    await expect(service.listRuns("user_x")).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    await expect(service.getRunDetail("user_x", "tenant_a", "run_1")).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
    });
    expect(store.listRuns).not.toHaveBeenCalled();
  });

  it.each(["viewer", "operator"] as const)(
    "%s 只能看到结构，正文接口拒绝且不写审计",
    async (role) => {
      const store = repository(role);
      const service = new RunExplorerService(store, () => "run_content_audit");

      const detail = await service.getRunDetail("user_x", "tenant_a", "run_1");
      expect(detail.contentAccess).toBe(false);
      expect(detail.attemptId).toBe("attempt_2");
      expect(JSON.stringify(detail)).not.toContain(secret);
      expect(detail.timeline.records.map((record) => record.summary)).toEqual(["模型回复"]);

      await expect(service.readRunContent("user_x", "tenant_a", "run_1")).rejects.toMatchObject({
        code: "NOT_AUTHORIZED",
      });
      expect(store.readContent).not.toHaveBeenCalled();
    },
  );

  it("admin 打开详情直接读取正文且每次写入审计", async () => {
    const store = repository("admin");
    let sequence = 0;
    const service = new RunExplorerService(store, () => `run_content_${++sequence}`);

    const first = await service.getRunDetail("user_admin", "tenant_a", "run_1", "attempt_1");
    const second = await service.getRunDetail("user_admin", "tenant_a", "run_1");

    expect(first.auditId).toBe("run_content_1");
    expect(second.auditId).toBe("run_content_2");
    expect(store.readContent).toHaveBeenNthCalledWith(1, {
      actorUserId: "user_admin",
      tenantId: "tenant_a",
      runId: "run_1",
      attemptId: "attempt_1",
      auditId: "run_content_1",
    });
    expect(store.readContent.mock.calls[1]?.[0]).toMatchObject({ attemptId: "attempt_2" });
    expect(JSON.stringify(first.timeline)).toContain(secret);
    expect(store.readContent).toHaveBeenCalledTimes(2);
  });

  it("不存在的 Run 或不属于该 Run 的 Attempt 返回 NOT_FOUND 且不写审计", async () => {
    const store = repository("admin");
    const service = new RunExplorerService(store, () => "run_content_audit");
    await expect(service.readRunContent("user_admin", "tenant_a", "missing")).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    await expect(
      service.readRunContent("user_admin", "tenant_a", "run_1", "attempt_other"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(store.readContent).not.toHaveBeenCalled();
  });
});

describe("Run 列表查询", () => {
  it("多取一条判断下一页并返回不透明游标", async () => {
    const store = repository("viewer");
    const service = new RunExplorerService(store, () => "run_content_audit");

    const page = await service.listRuns("user_x", {
      tenantId: "tenant_a",
      status: "succeeded",
      createdFrom: "2026-11-18T00:00:00+08:00",
      limit: 2,
    });

    expect(store.listRuns).toHaveBeenCalledWith({
      actorUserId: "user_x",
      tenantId: "tenant_a",
      status: "succeeded",
      createdFrom: "2026-11-17T16:00:00.000Z",
      limit: 3,
    });
    expect(page.items.map((item) => item.runId)).toEqual(["run_1", "run_2"]);
    expect(page.contentAccess).toBe(false);
    expect(decodeRunExplorerCursor(page.nextCursor ?? "")).toEqual({
      createdAt: "2026-11-19T00:00:00.000Z",
      tenantId: "tenant_a",
      runId: "run_2",
    });
  });

  it("把预留的 Agent 与来源筛选原样交给存储层", async () => {
    const store = repository("admin");
    const service = new RunExplorerService(store, () => "run_content_audit");
    const cursor = encodeRunExplorerCursor({
      createdAt: "2026-11-19T00:00:00.000Z",
      tenantId: "tenant_a",
      runId: "run_9",
    });
    const page = await service.listRuns("user_admin", {
      agentDefinitionId: "agent_default",
      agentRevisionId: "rev_1",
      origin: "playground",
      search: "退款失败",
      cursor,
    });
    expect(page.contentAccess).toBe(true);
    expect(store.listRuns.mock.calls[0]?.[0]).toMatchObject({
      agentDefinitionId: "agent_default",
      agentRevisionId: "rev_1",
      origin: "playground",
      search: "退款失败",
      after: { createdAt: "2026-11-19T00:00:00.000Z", tenantId: "tenant_a", runId: "run_9" },
    });
  });

  it("拒绝无效筛选与游标", async () => {
    const service = new RunExplorerService(repository("admin"), () => "run_content_audit");
    await expect(service.listRuns("u", { limit: 0 })).rejects.toThrow(TypeError);
    await expect(service.listRuns("u", { createdFrom: "not-a-date" })).rejects.toThrow(TypeError);
    await expect(
      service.listRuns("u", {
        createdFrom: "2026-11-19T00:00:00Z",
        createdTo: "2026-11-18T00:00:00Z",
      }),
    ).rejects.toThrow("时间范围无效");
    await expect(service.listRuns("u", { tenantId: "bad tenant" })).rejects.toThrow(TypeError);
    await expect(service.listRuns("u", { cursor: "not-base64-json" })).rejects.toThrow(
      "分页游标无效",
    );
  });
});

// @vitest-environment jsdom

import { act } from "react";
import type { InternalTrajectoryEventV1 } from "@hoox/trajectory";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillAdminApiContract } from "./api.js";
import { App } from "./app.js";
import {
  DeepSeekTrajectoryDebugger,
  loadTrajectoryPages,
  RunExplorerDetail,
  RunExplorerList,
} from "./run-explorer.js";
import {
  RunExplorerApi,
  type RunExplorerApiContract,
  type RunDetailDto,
  type RunSummaryDto,
  type RunTrajectoryPageDto,
} from "./run-explorer-api.js";

const roots: Root[] = [];
const secret = "SECRET-模型正文";

const summary: RunSummaryDto = {
  tenantId: "tenant_a",
  runId: "run_1",
  threadId: "thread_1",
  threadTitle: "无法导出报告",
  userInput: "运行后无法导出报告",
  userEmail: "operator@example.invalid",
  agentDisplayName: "报表助手",
  status: "failed",
  createdAt: "2026-11-19T00:00:00.000Z",
  updatedAt: "2026-11-19T00:00:12.000Z",
  agentDefinitionId: null,
  agentRevisionId: null,
  origin: null,
  attemptCount: 1,
  latestAttemptId: "attempt_1",
  finishedAt: "2026-11-19T00:00:12.000Z",
  durationMs: 12_000,
  modelCalls: 3,
  toolCalls: 2,
  failedToolCalls: 1,
  errorCount: 1,
  usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800, generationDurationMs: 900 },
};

function detail(contentAccess: boolean): RunDetailDto {
  return {
    run: {
      ...summary,
      attempts: [
        {
          attemptId: "attempt_1",
          status: "failed",
          stage: "finished",
          createdAt: "2026-11-19T00:00:01.000Z",
        },
      ],
    },
    attemptId: "attempt_1",
    contentAccess,
    timeline: {
      records: [
        {
          id: "assistant-0",
          sequence: 0,
          endSequence: 1,
          step: 1,
          kind: "assistant",
          event: "message",
          summary: "模型回复",
          status: "completed",
          startedAt: "2026-11-19T00:00:02.000Z",
          durationMs: 1000,
          detail: { stopReason: "stop" },
        },
      ],
      stats: {
        eventCount: 2,
        recordCount: 1,
        modelSteps: 1,
        toolCalls: 0,
        failedToolCalls: 0,
        errors: 0,
        durationMs: 1000,
      },
    },
  };
}

function apiFixture(contentAccess: boolean) {
  return {
    listRuns: vi.fn(async (filters: Parameters<RunExplorerApiContract["listRuns"]>[0]) => ({
      items: [{ ...summary, runId: filters.cursor === undefined ? "run_1" : "run_2" }],
      ...(filters.cursor === undefined ? { nextCursor: "cursor-1" } : {}),
      contentAccess,
    })),
    getRun: vi.fn(async () => {
      const base = detail(contentAccess);
      return contentAccess
        ? {
            ...base,
            auditId: "run_content_audit_1",
            timeline: {
              ...base.timeline,
              records: base.timeline.records.map((record) => ({
                ...record,
                summary: secret,
                detail: { text: secret },
              })),
            },
          }
        : base;
    }),
    readRunContent: vi.fn(async () => {
      const base = detail(true);
      return {
        ...base,
        auditId: "run_content_audit_1",
        timeline: {
          ...base.timeline,
          records: base.timeline.records.map((record) => ({
            ...record,
            summary: secret,
            detail: { text: secret },
          })),
        },
      };
    }),
  } satisfies RunExplorerApiContract;
}

function render(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(element));
  return container;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await act(async () => Promise.resolve());
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (match === undefined) throw new Error(`未找到按钮：${text}`);
  return match;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("运行记录列表", () => {
  it("展示结构化指标、提交筛选并按游标加载下一页", async () => {
    const api = apiFixture(false);
    const onOpen = vi.fn();
    const container = render(<RunExplorerList api={api} onOpen={onOpen} />);
    await settle();

    const row = container.querySelector("tbody tr");
    expect(row?.querySelector('[title="run_1"]')).not.toBeNull();
    expect(row?.textContent).toContain("失败");
    expect(row?.textContent).toContain("12.0 s");
    expect(row?.textContent).toContain("2,000 / 300");
    expect(row?.textContent).toContain("运行后无法导出报告");
    expect(row?.textContent).toContain("报表助手");

    const search = container.querySelector<HTMLInputElement>('[aria-label="搜索用户问题"]');
    if (!search) throw new Error("缺少用户问题搜索字段");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        search,
        "导出报告",
      );
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(container, "查询").click());
    await settle();
    expect(api.listRuns).toHaveBeenLastCalledWith({ search: "导出报告" });

    const status = container.querySelector<HTMLSelectElement>('select[aria-label="状态"]');
    if (status === null) throw new Error("缺少状态筛选");
    act(() => {
      status.value = "failed";
      status.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button(container, "查询").click());
    await settle();
    expect(api.listRuns).toHaveBeenLastCalledWith({ status: "failed", search: "导出报告" });

    await act(async () => button(container, "加载更多").click());
    await settle();
    expect(api.listRuns).toHaveBeenLastCalledWith({
      status: "failed",
      search: "导出报告",
      cursor: "cursor-1",
    });
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);

    act(() => button(container, "查看").click());
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ runId: "run_1" }));
  });
});

describe("运行详情", () => {
  it("非管理员详情只展示结构且不含正文", async () => {
    const api = apiFixture(false);
    const container = render(
      <RunExplorerDetail api={api} tenantId="tenant_a" runId="run_1" onBack={vi.fn()} />,
    );
    await settle();

    expect(container.textContent).toContain("模型回复");
    expect(container.textContent).not.toContain(secret);
    expect(container.textContent).not.toContain("查看正文");
    expect(api.readRunContent).not.toHaveBeenCalled();
  });

  it("管理员打开详情即展示正文，后台静默记录审计", async () => {
    const api = apiFixture(true);
    const container = render(
      <RunExplorerDetail api={api} tenantId="tenant_a" runId="run_1" onBack={vi.fn()} />,
    );
    await settle();
    expect(container.textContent).toContain(secret);
    expect(container.querySelector(".run-timeline-content")?.textContent).toBe(secret);
    expect(container.textContent).not.toContain("查看正文");
  });

  it("显示按轮分组的轨迹并联动搜索、展开、复制与汇总", async () => {
    const rawEvents = [
      {
        schemaVersion: 1 as const,
        sequence: 1,
        occurredAt: "2026-11-19T00:00:01.000Z",
        monotonicOffsetMs: 0,
        source: "runtime" as const,
        type: "prompt",
        event: { type: "prompt", text: "生成月报" },
      },
      {
        schemaVersion: 1 as const,
        sequence: 2,
        occurredAt: "2026-11-19T00:00:01.100Z",
        monotonicOffsetMs: 100,
        source: "pi" as const,
        type: "turn_start",
        event: { type: "turn_start" },
      },
      {
        schemaVersion: 1 as const,
        sequence: 3,
        occurredAt: "2026-11-19T00:00:01.200Z",
        monotonicOffsetMs: 200,
        source: "pi" as const,
        type: "message_start",
        event: { type: "message_start", message: { role: "assistant" } },
      },
      {
        schemaVersion: 1 as const,
        sequence: 4,
        occurredAt: "2026-11-19T00:00:03.200Z",
        monotonicOffsetMs: 2200,
        source: "pi" as const,
        type: "message_end",
        event: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "已完成" }],
            usage: { input: 120, output: 60, cacheRead: 30, cacheWrite: 0 },
          },
        },
      },
      {
        schemaVersion: 1 as const,
        sequence: 5,
        occurredAt: "2026-11-19T00:00:03.300Z",
        monotonicOffsetMs: 2300,
        source: "pi" as const,
        type: "tool_execution_start",
        event: { type: "tool_execution_start", toolName: "bash", toolCallId: "call-1" },
      },
      {
        schemaVersion: 1 as const,
        sequence: 6,
        occurredAt: "2026-11-19T00:00:03.325Z",
        monotonicOffsetMs: 2325,
        source: "pi" as const,
        type: "tool_execution_end",
        event: {
          type: "tool_execution_end",
          toolName: "bash",
          toolCallId: "call-1",
          args: { command: "pwd" },
          result: "/workspace",
        },
      },
    ].map((event) => ({
      ...event,
      agentThreadId: "agent-a",
    })) as unknown as RunTrajectoryPageDto["events"];
    const api = {
      ...apiFixture(true),
      readTrajectory: vi.fn(async (_tenantId, _runId, _attemptId, cursor) =>
        cursor === undefined
          ? {
              events: rawEvents.slice(0, 3),
              bytes: 100,
              hasMore: true,
              nextCursor: "cursor-1",
            }
          : { events: rawEvents.slice(3), bytes: 100, hasMore: false },
      ),
    } satisfies RunExplorerApiContract;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const container = render(<RunExplorerDetail api={api} tenantId="tenant_a" runId="run_1" />);
    await settle();

    expect(api.readTrajectory).toHaveBeenNthCalledWith(
      1,
      "tenant_a",
      "run_1",
      "attempt_1",
      undefined,
    );
    expect(api.readTrajectory).toHaveBeenNthCalledWith(
      2,
      "tenant_a",
      "run_1",
      "attempt_1",
      "cursor-1",
    );
    expect(api.readTrajectory).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("第 1 轮");
    expect(container.textContent).toContain("30.0 tok/s");
    expect(container.textContent).toContain("20%");
    const bar = container.querySelector<HTMLButtonElement>('[aria-label^="bash"]');
    if (bar === null) throw new Error("缺少轨迹泳道记录");
    act(() => bar.click());
    expect(container.querySelector(".trajectory-entry.selected")?.textContent).toContain("bash");

    const toggle = [
      ...container.querySelectorAll<HTMLButtonElement>(".trajectory-entry-toggle"),
    ].find((candidate) => candidate.textContent?.includes("bash"));
    if (toggle === undefined) throw new Error("缺少轨迹账本行");
    act(() => toggle.click());
    expect(container.textContent).toContain('"command": "pwd"');
    await act(async () => button(container, "复制 JSON").click());
    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify(
        {
          type: "tool_execution",
          sequenceStart: 5,
          sequenceEnd: 6,
          rawEventCount: 2,
          callId: "call-1",
          name: "bash",
          start: {
            type: "tool_execution_start",
            toolName: "bash",
            toolCallId: "call-1",
          },
          updates: [],
          end: {
            type: "tool_execution_end",
            toolName: "bash",
            toolCallId: "call-1",
            args: { command: "pwd" },
            result: "/workspace",
          },
        },
        null,
        2,
      ),
    );

    const search = container.querySelector<HTMLInputElement>('[aria-label="搜索轨迹"]');
    if (search === null) throw new Error("缺少轨迹搜索框");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        search,
        "bash",
      );
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelectorAll(".trajectory-entry-toggle")).toHaveLength(1);
  });

  it("跨页聚合完整记录并在读取上限处标记部分汇总", async () => {
    const event = (sequence: number, type: string, body: Record<string, unknown>) => ({
      schemaVersion: 1 as const,
      sequence,
      occurredAt: "2026-11-19T00:00:01.000Z",
      monotonicOffsetMs: sequence * 10,
      source: "pi" as const,
      type,
      event: body as InternalTrajectoryEventV1["event"],
      agentThreadId: "agent-a",
    });
    const pages = [
      {
        events: [
          event(1, "message_start", { type: "message_start", message: { role: "assistant" } }),
        ],
        bytes: 50,
        hasMore: true,
        nextCursor: "cursor-1",
      },
      {
        events: [
          event(2, "message_update", {
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              delta: "跨页",
              partial: { role: "assistant" },
            },
          }),
          event(3, "message_end", {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "跨页完成" }],
              usage: { input: 2, output: 4 },
            },
          }),
        ],
        bytes: 80,
        hasMore: false,
      },
    ];
    const firstPage = pages[0];
    const secondPage = pages[1];
    if (firstPage === undefined || secondPage === undefined) {
      throw new Error("轨迹分页夹具不完整");
    }
    const readPage = vi.fn(
      async (_tenantId: string, _runId: string, _attemptId: string, cursor?: string) =>
        cursor === undefined ? firstPage : secondPage,
    );
    const progress: { events: number; bytes: number }[] = [];
    const complete = await loadTrajectoryPages(
      readPage,
      "tenant_a",
      "run_a",
      "attempt_a",
      (value) => progress.push(value),
    );
    expect(readPage).toHaveBeenCalledTimes(2);
    expect(complete.partial).toBe(false);
    expect(complete.stats.events).toBe(3);
    expect(complete.records).toHaveLength(1);
    expect(complete.stats.outputTokens).toBe(4);
    expect(progress.at(-1)?.events).toBe(3);

    const capped = await loadTrajectoryPages(
      readPage,
      "tenant_a",
      "run_a",
      "attempt_a",
      () => undefined,
      {
        events: 2,
        bytes: 60,
      },
    );
    expect(capped.partial).toBe(true);
    expect(capped.loadedEvents).toBe(1);
    expect(capped.stats.events).toBe(1);
    const partialView = render(<DeepSeekTrajectoryDebugger trajectory={capped} />);
    expect(partialView.textContent).toContain("汇总仅覆盖已加载部分");
  });

  it("超大事件占位明确标记部分汇总", async () => {
    const oversized = {
      schemaVersion: 1 as const,
      sequence: 1,
      occurredAt: "2026-11-22T00:00:00.000Z",
      monotonicOffsetMs: 1,
      source: "pi" as const,
      type: "large_event",
      event: { $cubeInternalType: "truncated", originalSize: 3_000_000 },
      agentThreadId: "agent-a",
      truncated: true,
    };
    const trajectory = await loadTrajectoryPages(
      async () => ({ events: [oversized], bytes: 0, hasMore: false }),
      "tenant_a",
      "run_a",
      "attempt_a",
      () => undefined,
    );
    expect(trajectory.partial).toBe(true);
    expect(trajectory.truncatedEvents).toBe(1);
    const partialView = render(<DeepSeekTrajectoryDebugger trajectory={trajectory} />);
    expect(partialView.textContent).toContain("超大事件仅显示有界占位");
    expect(partialView.textContent).toContain("汇总仅覆盖已加载部分");
  });

  it("轨迹接口故障明确提示，不伪装成旧 Run", async () => {
    const api = {
      ...apiFixture(true),
      readTrajectory: vi.fn(async () => {
        throw new Error("unavailable");
      }),
    } satisfies RunExplorerApiContract;
    const container = render(<RunExplorerDetail api={api} tenantId="tenant_a" runId="run_1" />);
    await settle();
    expect(container.textContent).toContain("完整轨迹读取失败");
    expect(container.textContent).not.toContain("早于完整轨迹记录");
    expect(container.querySelector(".run-timeline")).not.toBeNull();
  });

  it("实时侧栏从排队串行刷新到终态", async () => {
    vi.useFakeTimers();
    const api = apiFixture(true);
    const base = detail(true);
    api.getRun
      .mockResolvedValueOnce({ ...base, run: { ...base.run, status: "queued" } })
      .mockResolvedValueOnce({ ...base, run: { ...base.run, status: "waiting" } })
      .mockResolvedValueOnce({ ...base, run: { ...base.run, status: "succeeded", modelCalls: 5 } });
    const container = render(
      <RunExplorerDetail api={api} tenantId="tenant_a" runId="run_1" live />,
    );
    await settle();
    expect(container.textContent).toContain("排队中");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(container.textContent).toContain("等待回答");
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(api.getRun).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("成功");
    expect(api.readRunContent).not.toHaveBeenCalled();
    expect(container.textContent).toContain("模型回复");
  });

  it("刷新发现操作者失去正文权限后只显示结构", async () => {
    vi.useFakeTimers();
    const api = apiFixture(true);
    const base = detail(true);
    api.getRun
      .mockResolvedValueOnce({ ...base, run: { ...base.run, status: "running" } })
      .mockResolvedValueOnce(detail(false));
    const container = render(
      <RunExplorerDetail api={api} tenantId="tenant_a" runId="run_1" live />,
    );
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(container.textContent).toContain("模型回复");
    expect(container.textContent).not.toContain(secret);
    expect(container.textContent).not.toContain("run_content_audit_1");
    expect(api.readRunContent).not.toHaveBeenCalled();
  });

  it("慢请求不重叠；离开侧栏后迟到的结构响应不再排队刷新", async () => {
    vi.useFakeTimers();
    const api = apiFixture(false);
    const pending = Promise.withResolvers<RunDetailDto>();
    api.getRun.mockReturnValueOnce(pending.promise);
    render(<RunExplorerDetail api={api} tenantId="tenant_a" runId="run_1" live />);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(api.getRun).toHaveBeenCalledTimes(1);
    act(() => roots.pop()?.unmount());
    const base = detail(false);
    await act(async () => pending.resolve({ ...base, run: { ...base.run, status: "running" } }));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(api.getRun).toHaveBeenCalledTimes(1);
    expect(api.readRunContent).not.toHaveBeenCalled();
  });

  it("管理台路由在运营分组下挂载运行记录详情", async () => {
    const api = apiFixture(false);
    const container = render(
      <App
        apiClient={{} as SkillAdminApiContract}
        runApi={api}
        initialPath="/runs/tenant_a/run_1"
      />,
    );
    await settle();

    expect(api.getRun).toHaveBeenCalledWith("tenant_a", "run_1", undefined);
    expect(container.querySelector(".platform-page-context")?.textContent).toContain("运行记录");
    expect(container.querySelector(".ant-menu-item-selected")?.textContent).toContain("运行记录");
  });
});

describe("运行记录 API 客户端", () => {
  it("筛选放在 POST 请求体且不进入 URL，并对路径参数编码且禁用缓存", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: { items: [], contentAccess: false } }), {
          status: 200,
        }),
    );
    const api = new RunExplorerApi(fetcher, "/v1/admin/control", () => "Bearer token");

    await api.listRuns({
      tenantId: "tenant_a",
      status: "failed",
      search: "PRIVATE SEARCH",
      createdFrom: "",
    });
    await api.readRunContent("tenant/a", "run 1", "attempt_1");

    expect(fetcher.mock.calls[0]?.[0]).toBe("/v1/admin/control/runs");
    expect(fetcher.mock.calls[0]?.[0]).not.toContain("PRIVATE SEARCH");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST", cache: "no-store" });
    expect(fetcher.mock.calls[0]?.[1]?.body).toContain("PRIVATE SEARCH");
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "/v1/admin/control/runs/tenant%2Fa/run%201/content?attemptId=attempt_1",
    );
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "GET", cache: "no-store" });
  });

  it("把 401 映射为无权限提示", async () => {
    const api = new RunExplorerApi(
      async () => new Response("{}", { status: 401 }),
      "/v1/admin/control",
      () => undefined,
    );
    await expect(api.readRunContent("tenant_a", "run_1")).rejects.toMatchObject({
      status: 401,
      message: "当前账号没有执行该操作的权限。",
    });
  });
});

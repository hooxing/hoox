// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillAdminApiContract } from "./api.js";
import { App } from "./app.js";
import { RunExplorerDetail, RunExplorerList } from "./run-explorer.js";
import {
  RunExplorerApi,
  type RunExplorerApiContract,
  type RunDetailDto,
  type RunSummaryDto,
} from "./run-explorer-api.js";

const roots: Root[] = [];
const secret = "SECRET-模型正文";

const summary: RunSummaryDto = {
  tenantId: "tenant_a",
  runId: "run_1",
  threadId: "thread_1",
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
    getRun: vi.fn(async () => detail(contentAccess)),
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
    expect(row?.textContent).toContain("run_1");
    expect(row?.textContent).toContain("失败");
    expect(row?.textContent).toContain("12.0 s");
    expect(row?.textContent).toContain("2,000 / 300");
    expect(row?.textContent).toContain("未记录");

    const status = container.querySelector<HTMLSelectElement>('select[aria-label="状态"]');
    if (status === null) throw new Error("缺少状态筛选");
    act(() => {
      status.value = "failed";
      status.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button(container, "查询").click());
    await settle();
    expect(api.listRuns).toHaveBeenLastCalledWith({ status: "failed" });

    await act(async () => button(container, "加载更多").click());
    await settle();
    expect(api.listRuns).toHaveBeenLastCalledWith({ status: "failed", cursor: "cursor-1" });
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);

    act(() => button(container, "查看").click());
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ runId: "run_1" }));
  });
});

describe("运行详情", () => {
  it("没有正文权限时只展示结构，不提供正文入口", async () => {
    const api = apiFixture(false);
    const container = render(
      <RunExplorerDetail api={api} tenantId="tenant_a" runId="run_1" onBack={vi.fn()} />,
    );
    await settle();

    expect(container.textContent).toContain("模型回复");
    expect(container.textContent).toContain("没有“查看运行正文”权限");
    expect(container.textContent).not.toContain("查看正文");
    expect(api.readRunContent).not.toHaveBeenCalled();
  });

  it("持有正文权限时需主动打开正文，并显示审计号", async () => {
    const api = apiFixture(true);
    const container = render(
      <RunExplorerDetail api={api} tenantId="tenant_a" runId="run_1" onBack={vi.fn()} />,
    );
    await settle();
    expect(container.textContent).not.toContain(secret);
    expect(api.readRunContent).not.toHaveBeenCalled();

    await act(async () => button(container, "查看正文").click());
    await settle();

    expect(api.readRunContent).toHaveBeenCalledWith("tenant_a", "run_1", "attempt_1");
    expect(container.querySelector(".run-timeline-content")?.textContent).toBe(secret);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "run_content_audit_1",
    );
  });

  it("实时侧栏从排队串行刷新到终态，人工查看正文只写一次审计", async () => {
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
    expect(api.readRunContent).not.toHaveBeenCalled();
    await act(async () => button(container, "查看正文").click());
    expect(container.textContent).toContain("run_content_audit_1");
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(api.getRun).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("成功");
    expect(api.readRunContent).toHaveBeenCalledTimes(1);
    act(() => button(container, "收起正文").click());
    expect(container.textContent).not.toContain(secret);
    expect(container.textContent).toContain("模型回复");
  });

  it("刷新发现正文权限已收回，丢弃在途的旧正文响应", async () => {
    vi.useFakeTimers();
    const api = apiFixture(true);
    const base = detail(true);
    api.getRun
      .mockResolvedValueOnce({ ...base, run: { ...base.run, status: "running" } })
      .mockResolvedValueOnce(detail(false));
    const result = await api.readRunContent();
    const pending = Promise.withResolvers<typeof result>();
    api.readRunContent.mockClear().mockReturnValueOnce(pending.promise);
    const container = render(
      <RunExplorerDetail api={api} tenantId="tenant_a" runId="run_1" live />,
    );
    await settle();
    act(() => button(container, "查看正文").click());
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await act(async () => pending.resolve(result));
    expect(container.textContent).toContain("只显示结构与指标");
    expect(container.textContent).not.toContain(secret);
    expect(container.textContent).not.toContain("run_content_audit_1");
    expect(api.readRunContent).toHaveBeenCalledTimes(1);
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
  it("只发送非空筛选，并对路径参数编码且禁用缓存", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: { items: [], contentAccess: false } }), {
          status: 200,
        }),
    );
    const api = new RunExplorerApi(fetcher, "/v1/admin/control", () => "Bearer token");

    await api.listRuns({ tenantId: "tenant_a", status: "failed", createdFrom: "" });
    await api.readRunContent("tenant/a", "run 1", "attempt_1");

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/v1/admin/control/runs?tenantId=tenant_a&status=failed",
    );
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

// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type Artifact,
  type ModelWireTraceRecord,
  type Run,
  type Thread,
} from "./api.js";
import {
  App,
  chooseInitialThread,
  compactThreadTitle,
  deriveThreadTitle,
  nextExpectedUserOccurrence,
  shouldContinueRunPolling,
  shouldFollowLatest,
} from "./main.js";

type AppApi = NonNullable<ComponentProps<typeof App>["apiClient"]>;

const thread = (id: string, status: Thread["status"] = "active"): Thread => ({
  id,
  title: `会话 ${id}`,
  status,
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
});

const run = (id: string, threadId: string): Run => ({
  id,
  threadId,
  status: "succeeded",
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
});

const textArtifact = (): Artifact => ({
  id: "artifact_text",
  name: "report.txt",
  mediaType: "text/plain; charset=utf-8",
  sizeBytes: 41,
  status: "published",
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
});

const modelWireTrace = (index = 0): ModelWireTraceRecord => ({
  attemptId: "attempt_poll",
  modelTurn: index,
  transportAttempt: 0,
  part: "request",
  captureStatus: "complete",
  persistenceStatus: "stored",
  bodyAvailable: true,
  createdAt: new Date(Date.UTC(2026, 6, 30, 0, 0, index)).toISOString(),
  expiresAt: "2026-08-06T00:00:00.000Z",
});

function apiFixture(overrides: Partial<AppApi> = {}): AppApi {
  const defaultThread = thread("thread_default");
  const defaultRun = run("run_default", defaultThread.id);
  return {
    listThreads: vi.fn(async () => []),
    listLatestRuns: vi.fn(async () => []),
    getRun: vi.fn(async () => defaultRun),
    listEvents: vi.fn(async () => ({ attemptId: undefined, items: [] })),
    listArtifacts: vi.fn(async () => []),
    listModelWireTraces: vi.fn(async () => ({ items: [], hasMore: false })),
    createThread: vi.fn(async () => defaultThread),
    archiveThread: vi.fn(async () => defaultThread),
    createRun: vi.fn(async () => defaultRun),
    cancelRun: vi.fn(async () => defaultRun),
    downloadArtifact: vi.fn(async () => "https://example.invalid/download"),
    previewArtifact: vi.fn(async () => ({
      kind: "url" as const,
      url: "https://example.invalid/preview",
    })),
    uploadResource: vi.fn(async (file: File) => ({
      resourceId: "resource_uploaded",
      versionId: "resource_version_uploaded",
      name: file.name,
      path: `/resources/resource_uploaded/resource_version_uploaded/${file.name}`,
      mediaType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    })),
    ...overrides,
  };
}

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const mountedRoots: Root[] = [];

function mount(apiClient: AppApi): { readonly container: HTMLDivElement; readonly root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() => root.render(<App apiClient={apiClient} />));
  return { container, root };
}

async function settleEffects(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => Promise.resolve());
  }
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: "(max-width: 820px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe("Agent 工作台恢复接入", () => {
  it("重复文本只计算尚未落入 Thread 上下文的消息，拒绝项不占用序号", () => {
    expect(
      nextExpectedUserOccurrence(
        [{ role: "user", text: "继续" }],
        [
          {
            text: "继续",
            disposition: "queued",
            expectedUserOccurrence: 1,
          },
          {
            text: "继续",
            disposition: "rejected",
            expectedUserOccurrence: 2,
          },
        ],
        "继续",
      ),
    ).toBe(2);
    expect(
      nextExpectedUserOccurrence(
        [{ role: "user", text: "继续" }],
        [
          {
            text: "继续",
            disposition: "queued",
            expectedUserOccurrence: 2,
          },
        ],
        "继续",
      ),
    ).toBe(3);
  });

  it("从首条有效请求生成确定性、紧凑的会话标题", () => {
    expect(deriveThreadTitle("  # 调研\nOpenAI *最新* 模型，并给出建议  ")).toBe(
      "调研 OpenAI 最新 模型，并给…",
    );
    expect(deriveThreadTitle("甲".repeat(40))).toBe(`${"甲".repeat(18)}…`);
    expect(deriveThreadTitle(" \n ")).toBe("新任务");
    expect(compactThreadTitle("帮我起草一份投诉信，要求电信退款的，docx")).toBe(
      "帮我起草一份投诉信，要求电信退款…",
    );
  });

  it("waiting 不启动无限短轮询，但未读事件页仍会被排空", () => {
    expect(shouldContinueRunPolling(false, "waiting")).toBe(false);
    expect(shouldContinueRunPolling(true, "waiting")).toBe(true);
    expect(shouldContinueRunPolling(false, "running")).toBe(true);
  });

  it("Run 终态后继续追踪 Sandbox 瞬时态，稳定或 UNKNOWN 后停止短轮询", () => {
    expect(shouldContinueRunPolling(false, "succeeded", "pausing")).toBe(true);
    expect(shouldContinueRunPolling(false, "succeeded", "resuming")).toBe(true);
    expect(shouldContinueRunPolling(false, "succeeded", "paused")).toBe(false);
    expect(shouldContinueRunPolling(false, "succeeded", "unknown")).toBe(false);
  });

  it("只在用户仍停留于底部附近时自动跟随最新进展", () => {
    expect(shouldFollowLatest(1_000, 500, 400)).toBe(false);
    expect(shouldFollowLatest(1_000, 510, 400)).toBe(true);
    expect(shouldFollowLatest(1_000, 600, 400)).toBe(true);
  });

  it("首条请求自动创建会话并使用派生标题，用户无需预先填写标题", async () => {
    const createdThread = thread("thread_created");
    const createdRun = run("run_created", createdThread.id);
    const apiClient = apiFixture({
      listThreads: vi.fn(async () => []),
      createThread: vi.fn(async () => createdThread),
      createRun: vi.fn(async () => createdRun),
      getRun: vi.fn(async () => createdRun),
    });
    const { container } = mount(apiClient);
    await settleEffects();
    const textarea = container.querySelector("textarea");
    const form = container.querySelector("form");
    if (textarea === null || form === null) throw new Error("未渲染任务输入区");
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(textarea, "  生成一份周报  ");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settleEffects();

    expect(apiClient.createThread).toHaveBeenCalledWith("生成一份周报");
    expect(apiClient.createThread).toHaveBeenCalledTimes(1);
    expect(apiClient.createRun).toHaveBeenCalledWith(createdThread.id, "生成一份周报");
    expect(container.querySelector("h1")?.textContent).toBe(createdThread.title);
  });

  it("刷新后稳定选择第一个活跃 Thread，恢复最新 Run 并启动投影读取", async () => {
    const archived = thread("thread_archived", "archived");
    const active = thread("thread_active");
    const latest = run("run_latest", active.id);
    const apiClient = apiFixture({
      listThreads: vi.fn(async () => [archived, active]),
      listLatestRuns: vi.fn(async () => [latest]),
      getRun: vi.fn(async () => latest),
    });
    const { container } = mount(apiClient);

    await settleEffects();

    expect(apiClient.listLatestRuns).toHaveBeenCalledWith(active.id, 1);
    expect(apiClient.getRun).toHaveBeenCalledWith(active.id, latest.id);
    expect(container.querySelector("h1")?.textContent).toBe(active.title);
    expect(container.querySelector(".conversation-header")?.getAttribute("data-run-id")).toBe(
      "run_latest",
    );
    expect(apiClient.listEvents).toHaveBeenCalledWith(active.id, latest.id, -1, 100);
    expect(apiClient.listArtifacts).toHaveBeenCalledWith(active.id, latest.id);
  });

  it("运行读取同时保留模型报文诊断出口", async () => {
    const active = thread("thread_trace");
    const latest = run("run_trace", active.id);
    const apiClient = apiFixture({
      listThreads: vi.fn(async () => [active]),
      listLatestRuns: vi.fn(async () => [latest]),
      getRun: vi.fn(async () => latest),
      listModelWireTraces: vi.fn(async () => ({ items: [modelWireTrace()], hasMore: false })),
    });
    const { container } = mount(apiClient);

    await settleEffects();

    expect(apiClient.listModelWireTraces).toHaveBeenCalledWith(active.id, latest.id);
    expect(container.textContent).not.toContain("模型网络报文");
    expect(container.querySelector(".activity-panel")).toBeNull();
  });

  it("诊断索引暂不可用时不阻断 Run、事件与交付物投影", async () => {
    const selectedThread = thread("thread_trace_unavailable");
    const latest = run("run_trace_unavailable", selectedThread.id);
    const apiClient = apiFixture({
      listThreads: vi.fn(async () => [selectedThread]),
      listLatestRuns: vi.fn(async () => [latest]),
      getRun: vi.fn(async () => latest),
      listModelWireTraces: vi.fn(async () => {
        throw new ApiError("依赖服务暂时不可用", 503, true);
      }),
    });
    const { container } = mount(apiClient);
    await settleEffects();

    expect(apiClient.getRun).toHaveBeenCalledWith(selectedThread.id, latest.id);
    expect(apiClient.listEvents).toHaveBeenCalled();
    expect(apiClient.listArtifacts).toHaveBeenCalled();
    expect(container.textContent).not.toContain("诊断索引暂不可用");
    expect(container.querySelector(".activity-panel")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.skip("终态轮询保留已加载页并沿尾游标追完跨页新增诊断", async () => {
    vi.useFakeTimers();
    const selectedThread = thread("thread_trace_poll");
    const activeRun = { ...run("run_trace_poll", selectedThread.id), status: "running" as const };
    const terminalRun = { ...activeRun, status: "succeeded" as const };
    const firstPage = [modelWireTrace(0), modelWireTrace(1)];
    const tail = modelWireTrace(2);
    const burstTail = [modelWireTrace(3), modelWireTrace(4)];
    const finalTail = modelWireTrace(5);
    let headRequestCount = 0;
    const listModelWireTraces = vi.fn(
      async (_threadId: string, _runId: string, cursor?: string) => {
        if (cursor === "cursor_2") {
          return {
            items: [firstPage[1] as ModelWireTraceRecord, tail],
            hasMore: false,
            nextCursor: "cursor_3",
          };
        }
        if (cursor === "cursor_3") {
          return { items: burstTail, hasMore: true, nextCursor: "cursor_5" };
        }
        if (cursor === "cursor_5") {
          return { items: [finalTail], hasMore: false, nextCursor: "cursor_6" };
        }
        headRequestCount += 1;
        return {
          items:
            headRequestCount === 1
              ? firstPage
              : firstPage.map((record, index) =>
                  index === 0
                    ? {
                        ...record,
                        captureStatus: "truncated" as const,
                        persistenceStatus: "unavailable" as const,
                        bodyAvailable: false,
                      }
                    : record,
                ),
          hasMore: true,
          nextCursor: headRequestCount === 1 ? "cursor_2" : "cursor_refreshed_head",
        };
      },
    );
    let runPollCount = 0;
    const apiClient = apiFixture({
      listThreads: vi.fn(async () => [selectedThread]),
      listLatestRuns: vi.fn(async () => [activeRun]),
      getRun: vi.fn(async () => {
        runPollCount += 1;
        return runPollCount === 1 ? activeRun : terminalRun;
      }),
      listModelWireTraces,
    });
    const { container } = mount(apiClient);
    await settleEffects();

    expect(container.querySelectorAll(".model-wire-record")).toHaveLength(2);
    const loadMore = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "加载更多",
    );
    if (loadMore === undefined) throw new Error("未渲染模型网络诊断加载更多按钮");
    await act(async () => loadMore.click());
    await settleEffects();
    expect(container.querySelectorAll(".model-wire-record")).toHaveLength(3);
    expect(container.querySelectorAll('[aria-label="模型轮次 2"]')).toHaveLength(1);

    await act(async () => vi.advanceTimersByTimeAsync(1_200));
    await settleEffects();

    expect(listModelWireTraces).toHaveBeenCalledTimes(4);
    expect(listModelWireTraces).toHaveBeenCalledWith(selectedThread.id, activeRun.id, "cursor_3");
    expect(container.querySelectorAll(".model-wire-record")).toHaveLength(5);
    expect(container.querySelectorAll('[aria-label="模型轮次 2"]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label="模型轮次 4"]')).toHaveLength(1);
    expect(container.querySelectorAll(".model-wire-record.is-truncated")).toHaveLength(1);

    await act(async () => vi.advanceTimersByTimeAsync(1_200));
    await settleEffects();

    expect(listModelWireTraces).toHaveBeenCalledTimes(6);
    expect(listModelWireTraces).toHaveBeenCalledWith(selectedThread.id, activeRun.id, "cursor_5");
    expect(container.querySelectorAll(".model-wire-record")).toHaveLength(6);
    expect(container.querySelectorAll('[aria-label="模型轮次 5"]')).toHaveLength(1);
    expect(container.textContent).not.toContain("加载更多");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("切换和切回都会重新恢复，迟到错误与加载不会污染其他 Thread", async () => {
    const first = thread("thread_1");
    const second = thread("thread_2");
    const recoveries: Array<{
      readonly threadId: string;
      readonly request: Deferred<readonly Run[]>;
    }> = [];
    const apiClient = apiFixture({
      listThreads: vi.fn(async () => [first, second]),
      listLatestRuns: vi.fn((threadId: string) => {
        const request = deferred<readonly Run[]>();
        recoveries.push({ threadId, request });
        return request.promise;
      }),
    });
    const { container } = mount(apiClient);

    await settleEffects();
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]?.threadId).toBe(first.id);

    const secondButton = [...container.querySelectorAll<HTMLButtonElement>(".thread")].find(
      (button) => button.textContent?.includes(second.title),
    );
    if (secondButton === undefined) throw new Error("未找到第二个会话按钮");
    act(() => secondButton.click());
    await settleEffects();
    expect(recoveries).toHaveLength(2);
    expect(container.textContent).toContain("正在恢复最新运行");

    await act(async () => recoveries[0]?.request.reject(new ApiError("旧恢复失败", 503, true)));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe(second.title);

    await act(async () => recoveries[1]?.request.resolve([]));
    expect(container.textContent).toContain("就绪");
    expect(container.textContent).toContain("从一个明确的目标开始");

    const firstButton = [...container.querySelectorAll<HTMLButtonElement>(".thread")].find(
      (button) => button.textContent?.includes(first.title),
    );
    if (firstButton === undefined) throw new Error("未找到第一个会话按钮");
    act(() => firstButton.click());
    await settleEffects();
    expect(recoveries).toHaveLength(3);
    expect(recoveries[2]?.threadId).toBe(first.id);
    await act(async () => recoveries[2]?.request.resolve([]));
    expect(container.querySelector("h1")?.textContent).toBe(first.title);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("同 Thread 新建 Run 后使在途恢复失效，迟到空结果不能覆盖新 Run", async () => {
    const selectedThread = thread("thread_1");
    const newRun = run("run_new", selectedThread.id);
    const pendingRecovery = deferred<readonly Run[]>();
    const apiClient = apiFixture({
      listThreads: vi.fn(async () => [selectedThread]),
      listLatestRuns: vi.fn(() => pendingRecovery.promise),
      createRun: vi.fn(async () => newRun),
      getRun: vi.fn(async () => newRun),
    });
    const { container } = mount(apiClient);
    await settleEffects();
    expect(apiClient.listLatestRuns).toHaveBeenCalledWith(selectedThread.id, 1);

    const textarea = container.querySelector("textarea");
    const form = container.querySelector("form");
    if (textarea === null || form === null) throw new Error("未渲染会话输入区");
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(textarea, "启动新的分析");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settleEffects();
    expect(apiClient.createRun).toHaveBeenCalledWith(selectedThread.id, "启动新的分析");
    expect(container.querySelector(".conversation-header")?.getAttribute("data-run-id")).toBe(
      "run_new",
    );

    await act(async () => pendingRecovery.resolve([]));
    await settleEffects();
    expect(container.querySelector(".conversation-header")?.getAttribute("data-run-id")).toBe(
      "run_new",
    );
    expect(apiClient.getRun).toHaveBeenCalledWith(selectedThread.id, newRun.id);
  });

  it("恶意 HTML 文本只渲染为 pre 的文本节点，且不打开或导航弹窗", async () => {
    const selectedThread = thread("thread_text");
    const latest = run("run_text", selectedThread.id);
    const payload = "<script>window.pwned=true</script>";
    const open = vi.spyOn(window, "open");
    const apiClient = apiFixture({
      listThreads: vi.fn(async () => [selectedThread]),
      listLatestRuns: vi.fn(async () => [latest]),
      getRun: vi.fn(async () => latest),
      listArtifacts: vi.fn(async () => [textArtifact()]),
      previewArtifact: vi.fn(async () => ({ kind: "text" as const, text: payload })),
    });
    const { container } = mount(apiClient);
    await settleEffects();
    const preview = container.querySelector<HTMLButtonElement>("[aria-label='预览 report.txt']");
    if (preview === null) throw new Error("未渲染纯文本预览按钮");
    await act(async () => preview.click());

    const rendered = container.querySelector(".artifact-text-preview pre");
    expect(rendered?.textContent).toBe(payload);
    expect(rendered?.querySelector("script")).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("初始选择策略跳过归档 Thread，并在无活跃 Thread 时保持空选择", () => {
    expect(chooseInitialThread([thread("archived", "archived"), thread("active")])).toBe("active");
    expect(chooseInitialThread([thread("archived", "archived")])).toBeUndefined();
  });
});

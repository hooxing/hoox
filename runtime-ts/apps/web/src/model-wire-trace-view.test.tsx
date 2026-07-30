// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ModelWireTraceRecord } from "./api.js";
import { groupModelWireTraces, ModelWireTracePanel } from "./model-wire-trace-view.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const base: ModelWireTraceRecord = {
  attemptId: "attempt_1",
  modelTurn: 0,
  transportAttempt: 0,
  part: "request",
  captureStatus: "complete",
  persistenceStatus: "stored",
  sha256: "a".repeat(64),
  size: 18,
  bodyAvailable: true,
  createdAt: "2026-07-30T00:00:00.000Z",
  expiresAt: "2026-08-06T00:00:00.000Z",
};

describe("模型网络报文诊断面", () => {
  it("按模型轮次和 HTTP 重试分组，并标出非 2xx、截断和采集错误", () => {
    const records: readonly ModelWireTraceRecord[] = [
      base,
      { ...base, part: "response", httpStatus: 429 },
      { ...base, transportAttempt: 1, part: "request", captureStatus: "truncated" },
      {
        ...base,
        transportAttempt: 1,
        part: "response",
        captureStatus: "aborted",
        persistenceStatus: "not_captured",
        captureErrorCode: "BODY_UNREADABLE",
        bodyAvailable: false,
      },
      { ...base, modelTurn: 1, part: "response", httpStatus: 200 },
    ];
    expect(groupModelWireTraces(records)).toMatchObject([
      {
        modelTurn: 0,
        transports: [{ transportAttempt: 0 }, { transportAttempt: 1 }],
      },
      { modelTurn: 1, transports: [{ transportAttempt: 0 }] },
    ]);
    const html = renderToStaticMarkup(
      <ModelWireTracePanel
        records={records}
        hasMore
        unavailable={false}
        onLoadBody={async () => new Uint8Array()}
        onLoadMore={async () => undefined}
      />,
    );
    expect(html).toContain("模型轮次 0");
    expect(html).toContain("HTTP 尝试 1 · 重试");
    expect(html).toContain("HTTP 429（非 2xx）");
    expect(html).toContain("已截断");
    expect(html).toContain("正文不可读");
    expect(html).toContain("Prompt、工具参数及模型可见的工具回执");
    expect(html).toContain("仍有后续记录，当前已显示 5 条");
    expect(html).toContain("加载更多");
  });

  it("正文读取失败时显示统一过期/不可用错误，不把内容当 HTML", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const onLoad = vi.fn(async () => {
      throw new Error("诊断正文不可用或已过期");
    });
    act(() =>
      root.render(
        <ModelWireTracePanel
          records={[base]}
          hasMore={false}
          unavailable={false}
          onLoadBody={onLoad}
          onLoadMore={async () => undefined}
        />,
      ),
    );
    const button = container.querySelector<HTMLButtonElement>("button[aria-label^='查看模型轮次']");
    if (button === null) throw new Error("未渲染诊断正文按钮");
    await act(async () => button.click());
    expect(onLoad).toHaveBeenCalledWith(base);
    expect(container.querySelector("[role='alert']")?.textContent).toBe("诊断正文不可用或已过期");
    act(() => root.unmount());
  });

  it("有后续游标时可显式加载更多诊断记录", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const onLoadMore = vi.fn(async () => undefined);
    act(() =>
      root.render(
        <ModelWireTracePanel
          records={[base]}
          hasMore
          unavailable={false}
          onLoadBody={async () => new Uint8Array()}
          onLoadMore={onLoadMore}
        />,
      ),
    );
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === "加载更多",
    );
    if (button === undefined) throw new Error("未渲染加载更多按钮");
    await act(async () => button.click());
    expect(onLoadMore).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it("文本视图以文本节点展示，且同时显示实际字节数与 SHA-256", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const payload = new TextEncoder().encode("<script>window.pwned=true</script>");
    act(() =>
      root.render(
        <ModelWireTracePanel
          records={[{ ...base, size: payload.byteLength }]}
          hasMore={false}
          unavailable={false}
          onLoadBody={async () => payload}
          onLoadMore={async () => undefined}
        />,
      ),
    );
    const button = container.querySelector<HTMLButtonElement>("button[aria-label^='查看模型轮次']");
    if (button === null) throw new Error("未渲染诊断正文按钮");
    await act(async () => button.click());
    expect(container.querySelector(".model-wire-preview pre")?.textContent).toBe(
      "<script>window.pwned=true</script>",
    );
    expect(container.querySelector(".model-wire-preview pre script")).toBeNull();
    expect(container.textContent).toContain(`实际 ${payload.byteLength} 字节`);
    expect(container.textContent).toContain(`SHA-256 ${"a".repeat(64)}`);
    act(() => root.unmount());
  });
});

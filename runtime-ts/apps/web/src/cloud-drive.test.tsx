// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryFile, HistoryFilePage } from "./api.js";
import { CloudDrivePanel, type CloudDriveApi } from "./cloud-drive.js";

const file: HistoryFile = {
  threadId: "thread_contract",
  taskName: "采购合同审查",
  resourceId: "resource_contract",
  versionId: "version_contract",
  name: "采购合同.docx",
  entryName: "采购合同.docx",
  path: "/resources/resource_contract/version_contract/采购合同.docx",
  mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  sizeBytes: 2048,
  attachedAt: "2026-08-07T08:00:00.000Z",
};

function page(overrides: Partial<HistoryFilePage> = {}): HistoryFilePage {
  return {
    items: [
      {
        threadId: file.threadId,
        name: file.taskName,
        createdAt: "2026-08-07T07:00:00.000Z",
        lastFileAt: file.attachedAt,
        fileCount: 1,
        files: [file],
      },
    ],
    range: { activeAfter: "2026-02-07T00:00:00.000Z" },
    hasMore: false,
    hasOlder: true,
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("云盘历史文件面板", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await act(async () => root.unmount());
    container.remove();
  });

  it("按任务和月份展示最近六个月文件，并可加入当前输入", async () => {
    const api: CloudDriveApi = {
      listHistoryFiles: vi.fn(async () => page()),
      downloadHistoryFile: vi.fn(async () => "http://127.0.0.1:19000/history-download"),
    };
    const onSelectFile = vi.fn();
    await act(async () => root.render(<CloudDrivePanel api={api} onSelectFile={onSelectFile} />));
    await settle();

    expect(container.textContent).toContain("默认显示最近六个月活跃任务");
    expect(container.textContent).toContain("2026 年 8 月");
    expect(container.textContent).toContain("采购合同审查");
    expect(container.textContent).toContain("采购合同.docx");
    const add = container.querySelector<HTMLButtonElement>(
      '[aria-label="加入当前输入 采购合同.docx"]',
    );
    await act(async () => add?.click());
    expect(onSelectFile).toHaveBeenCalledWith(file);
  });

  it("搜索会刷新结果，加载更早任务沿用六个月边界", async () => {
    const listHistoryFiles = vi
      .fn<CloudDriveApi["listHistoryFiles"]>()
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(
        page({
          range: { activeBefore: "2026-02-07T00:00:00.000Z" },
          hasOlder: false,
        }),
      );
    const api: CloudDriveApi = {
      listHistoryFiles,
      downloadHistoryFile: vi.fn(async () => "http://127.0.0.1:19000/history-download"),
    };
    await act(async () => root.render(<CloudDrivePanel api={api} />));
    await settle();

    const search = container.querySelector<HTMLInputElement>('[aria-label="搜索历史文件"]');
    if (search === null) throw new Error("未渲染历史文件搜索框");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(search, "合同");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = search.closest("form");
    await act(async () =>
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await settle();
    expect(listHistoryFiles).toHaveBeenNthCalledWith(2, { query: "合同", limit: 24 });

    const older = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "加载更早任务",
    );
    await act(async () => older?.click());
    await settle();
    expect(listHistoryFiles).toHaveBeenNthCalledWith(3, {
      query: "合同",
      activeBefore: "2026-02-07T00:00:00.000Z",
      limit: 24,
    });
  });

  it("下载先同步打开空窗，再写入后端返回的短期地址", async () => {
    const replace = vi.fn();
    const popup = { close: vi.fn(), location: { replace }, opener: {} };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const api: CloudDriveApi = {
      listHistoryFiles: vi.fn(async () => page()),
      downloadHistoryFile: vi.fn(async () => "http://127.0.0.1:19000/history-download"),
    };
    await act(async () => root.render(<CloudDrivePanel api={api} />));
    await settle();

    const download = container.querySelector<HTMLButtonElement>(
      '[aria-label="下载 采购合同.docx"]',
    );
    await act(async () => download?.click());
    await settle();
    expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(api.downloadHistoryFile).toHaveBeenCalledWith(file);
    expect(replace).toHaveBeenCalledWith("http://127.0.0.1:19000/history-download");
    expect(popup.opener).toBeNull();
  });
});

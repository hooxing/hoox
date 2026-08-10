// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryFile, HistoryFilePage } from "./api.js";
import { CloudDriveDialog, CloudDrivePanel, type CloudDriveApi } from "./cloud-drive.js";

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

  it("云盘使用独立对话框并可关闭", async () => {
    const onClose = vi.fn();
    const api: CloudDriveApi = {
      listHistoryFiles: vi.fn(async () => page()),
      downloadHistoryFile: vi.fn(async () => "http://127.0.0.1/history-download"),
    };
    await act(async () => root.render(<CloudDriveDialog api={api} onClose={onClose} />));
    await settle();

    expect(container.querySelector("#cloud-drive-title")?.textContent).toBe("云盘");
    expect(container.textContent).not.toContain("技能中心");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="关闭云盘"]')?.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("个人与团队云盘使用标签切换，团队标签内只展示一个团队", async () => {
    const onSwitch = vi.fn();
    const api: CloudDriveApi = {
      listHistoryFiles: vi.fn(async () => page()),
      downloadHistoryFile: vi.fn(async () => "http://127.0.0.1/history-download"),
    };
    await act(async () =>
      root.render(
        <CloudDriveDialog
          api={api}
          teams={[
            { id: "tenant_product", name: "产品团队", api },
            { id: "tenant_sales", name: "销售团队", api },
          ]}
          selectedTeamId="tenant_product"
          onSwitchTeam={onSwitch}
          onClose={() => undefined}
        />,
      ),
    );
    await settle();

    expect(container.querySelectorAll('.cloud-drive-tabs [role="tab"]')).toHaveLength(2);
    expect(container.querySelector('[aria-label="个人云盘历史文件"]')).not.toBeNull();
    const teamTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (button) => button.textContent === "团队云盘",
    );
    await act(async () => teamTab?.click());
    await settle();
    const select = container.querySelector<HTMLSelectElement>(".cloud-drive-team-selector select");
    expect(select?.value).toBe("tenant_product");
    expect(container.querySelectorAll(".cloud-drive-team-view .cloud-drive-panel")).toHaveLength(1);
    await act(async () => {
      if (select !== null) {
        select.value = "tenant_sales";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(onSwitch).toHaveBeenCalledWith("tenant_sales");
  });

  it("独立搜索可按范围查询个人及全部团队文件", async () => {
    const personalList = vi.fn(async () => page());
    const productList = vi.fn(async () => page());
    const salesList = vi.fn(async () => page());
    const downloadHistoryFile = vi.fn(async () => "http://127.0.0.1/history-download");
    await act(async () =>
      root.render(
        <CloudDriveDialog
          api={{ listHistoryFiles: personalList, downloadHistoryFile }}
          teams={[
            {
              id: "tenant_product",
              name: "产品团队",
              api: { listHistoryFiles: productList, downloadHistoryFile },
            },
            {
              id: "tenant_sales",
              name: "销售团队",
              api: { listHistoryFiles: salesList, downloadHistoryFile },
            },
          ]}
          onClose={() => undefined}
        />,
      ),
    );
    await settle();

    const range = container.querySelector<HTMLSelectElement>('[aria-label="搜索范围"]');
    expect(Array.from(range?.options ?? []).map((option) => option.text)).toEqual([
      "全部空间",
      "仅个人云盘",
      "全部团队",
      "产品团队",
      "销售团队",
    ]);
    const search = container.querySelector<HTMLInputElement>('[aria-label="搜索个人及团队文件"]');
    if (search === null) throw new Error("未渲染跨空间搜索框");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        search,
        "合同",
      );
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      search
        .closest("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await settle();

    expect(personalList).toHaveBeenLastCalledWith({ query: "合同", limit: 24 });
    expect(productList).toHaveBeenLastCalledWith({ query: "合同", limit: 24 });
    expect(salesList).toHaveBeenLastCalledWith({ query: "合同", limit: 24 });
    expect(container.textContent).toContain("已搜索 3 个空间");
    expect(container.textContent).toContain("个人云盘");
    expect(container.textContent).toContain("产品团队云盘");
    expect(container.textContent).toContain("销售团队云盘");
    expect(
      container.querySelectorAll(".cloud-drive-search-results .cloud-drive-panel"),
    ).toHaveLength(0);

    const personalCallCount = personalList.mock.calls.length;
    const productCallCount = productList.mock.calls.length;
    const salesCallCount = salesList.mock.calls.length;
    await act(async () => {
      if (range !== null) {
        range.value = "teams";
        range.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await settle();
    expect(personalList).toHaveBeenCalledTimes(personalCallCount);
    expect(productList).toHaveBeenCalledTimes(productCallCount + 1);
    expect(salesList).toHaveBeenCalledTimes(salesCallCount + 1);
    expect(container.textContent).toContain("已搜索 2 个空间");
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

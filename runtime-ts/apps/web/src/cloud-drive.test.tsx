// @vitest-environment jsdom

import { act, useState } from "react";
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

  it("云盘最近文件为空时提供原对话回找指引", async () => {
    const api: CloudDriveApi = {
      listHistoryFiles: vi.fn(async () => page({ items: [] })),
      downloadHistoryFile: vi.fn(),
    };
    await act(async () => root.render(<CloudDriveDialog api={api} onClose={vi.fn()} />));
    await settle();

    expect(container.textContent).toContain("最近还没有可用文件");
    expect(container.textContent).toContain("回到原对话预览或下载");
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
    expect(container.textContent).not.toContain("回到原对话预览或下载");
    expect(container.textContent).not.toContain("技能中心");
    expect(container.textContent).toContain("搜索和浏览个人云盘文件");
    expect(container.querySelector('[aria-label="搜索个人文件"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="搜索范围"]')).toBeNull();
    expect(container.querySelector('[aria-label="云盘空间"]')).toBeNull();
    expect(container.querySelector(".cloud-drive-global-search.is-personal-only")).not.toBeNull();
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
    const scopeLabel = container.querySelector(".cloud-drive-search-scope > span");
    expect(scopeLabel?.textContent).toBe("搜索范围");
    const select = container.querySelector<HTMLSelectElement>(
      '.cloud-drive-team-selector select[aria-label="选择团队"]',
    );
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

  it("按 Escape 或点击关闭均可关闭云盘弹窗，约束 Tab 焦点并将焦点归还触发按钮", async () => {
    const api: CloudDriveApi = {
      listHistoryFiles: vi.fn(async () => page()),
      downloadHistoryFile: vi.fn(async () => "http://127.0.0.1/history-download"),
    };
    const onCloseSpy = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" className="trigger-button" onClick={() => setOpen(true)}>
            云盘
          </button>
          {open && (
            <CloudDriveDialog
              api={api}
              teams={[{ id: "tenant_product", name: "产品团队", api }]}
              onClose={() => {
                onCloseSpy();
                setOpen(false);
              }}
            />
          )}
        </>
      );
    }

    await act(async () => root.render(<Harness />));
    const trigger = container.querySelector<HTMLButtonElement>(".trigger-button");
    if (trigger === null) throw new Error("未渲染云盘触发按钮");
    trigger.focus();
    await act(async () => trigger.click());
    await settle();

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.getAttribute("aria-labelledby")).toBe("cloud-drive-title");
    expect(document.activeElement).toBe(dialog);

    const controls = [
      ...(dialog?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
      ) ?? []),
    ];
    expect(controls.length).toBeGreaterThan(2);
    controls.at(-1)?.focus();
    await act(async () =>
      controls
        .at(-1)
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
        ),
    );
    expect(document.activeElement).toBe(controls[0]);
    await act(async () =>
      controls[0]?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.activeElement).toBe(controls.at(-1));

    const search = dialog?.querySelector<HTMLInputElement>('[aria-label="搜索个人及团队文件"]');
    search?.focus();
    await act(async () =>
      search?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    trigger.focus();
    await act(async () => trigger.click());
    await settle();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="关闭云盘"]')?.click(),
    );
    expect(onCloseSpy).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("输入法合成中、内部已处理的 Escape 或存在上层嵌套弹窗时先关闭最内层", async () => {
    const onClose = vi.fn();
    const api: CloudDriveApi = {
      listHistoryFiles: vi.fn(async () => page()),
      downloadHistoryFile: vi.fn(async () => "http://127.0.0.1/history-download"),
    };
    const outer = document.createElement("div");
    const outerKeyDown = vi.fn();
    outer.addEventListener("keydown", outerKeyDown);
    document.body.append(outer);
    outer.append(container);
    const underlyingDocListener = vi.fn();
    document.addEventListener("keydown", underlyingDocListener);

    try {
      await act(async () => root.render(<CloudDriveDialog api={api} onClose={onClose} />));
      await settle();

      const search = container.querySelector<HTMLInputElement>('[aria-label="搜索个人文件"]');
      if (search === null) throw new Error("未渲染搜索框");
      search.focus();

      await act(async () =>
        search.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
            isComposing: true,
          }),
        ),
      );
      expect(onClose).not.toHaveBeenCalled();

      const innerPrevent = (event: KeyboardEvent) => event.preventDefault();
      search.addEventListener("keydown", innerPrevent, { once: true });
      await act(async () =>
        search.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        ),
      );
      expect(onClose).not.toHaveBeenCalled();

      const nestedDialog = document.createElement("div");
      nestedDialog.setAttribute("role", "dialog");
      nestedDialog.setAttribute("aria-modal", "true");
      document.body.append(nestedDialog);
      try {
        await act(async () =>
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })),
        );
        expect(onClose).not.toHaveBeenCalled();
      } finally {
        nestedDialog.remove();
      }

      outerKeyDown.mockClear();
      underlyingDocListener.mockClear();
      await act(async () =>
        search.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        ),
      );
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(outerKeyDown).not.toHaveBeenCalled();
      expect(underlyingDocListener).not.toHaveBeenCalled();

      // 当焦点脱离对话框落回 document.body（如点击了变为禁用的按钮或遮罩）时，仍可关闭且不穿透到底层。
      await act(async () =>
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        ),
      );
      expect(onClose).toHaveBeenCalledTimes(2);
      expect(underlyingDocListener).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", underlyingDocListener);
      document.body.append(container);
      outer.remove();
    }
  });
});

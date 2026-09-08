// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useActionDialog } from "./action-dialog.js";

let container: HTMLDivElement;
let root: Root;
const result = vi.fn();
function Harness({ choices = false }: { readonly choices?: boolean }) {
  const { ask, dialog } = useActionDialog();
  return (
    <>
      {dialog}
      <button
        type="button"
        onClick={() =>
          void ask({
            title: "重命名个人任务",
            confirmLabel: "保存",
            field: {
              label: "任务名称",
              initialValue: "原名称",
              ...(choices
                ? {
                    choices: [
                      { value: "one", label: "同名团队" },
                      { value: "two", label: "同名团队" },
                    ],
                    initialValue: "one",
                  }
                : {}),
            },
          }).then(result)
        }
      >
        打开
      </button>
    </>
  );
}
async function click(selector: string) {
  await act(async () => document.querySelector<HTMLButtonElement>(selector)?.click());
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  result.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it("聚焦并选中原名称，限制 Tab 焦点，Esc 取消后恢复焦点和背景", async () => {
  await act(async () => root.render(<Harness />));
  const trigger = container.querySelector("button");
  trigger?.focus();
  await click("button");
  const input = document.querySelector<HTMLInputElement>(".action-dialog input");
  expect(document.activeElement).toBe(input);
  expect(input?.selectionEnd).toBe(3);
  expect(container.inert).toBe(true);
  const first = document.querySelector<HTMLButtonElement>(".action-dialog button");
  const last = document.querySelector<HTMLButtonElement>('.action-dialog button[type="submit"]');
  last?.focus();
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true })),
  );
  expect(document.activeElement).toBe(first);
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true }),
    ),
  );
  expect(document.activeElement).toBe(last);
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })),
  );
  expect(result).toHaveBeenCalledWith(null);
  expect(document.activeElement).toBe(trigger);
  expect(container.inert).toBeFalsy();
  expect(document.querySelector(".action-dialog")).toBeNull();
});
it("空名称留在弹窗内提示，表单提交返回去除首尾空白后的名称", async () => {
  await act(async () => root.render(<Harness />));
  await click("button");
  const input = document.querySelector<HTMLInputElement>(".action-dialog input");
  const change = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await change("   ");
  await click('.action-dialog button[type="submit"]');
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("任务名称不能为空");
  expect(result).not.toHaveBeenCalled();
  await change(" 新名称 ");
  await act(async () =>
    document
      .querySelector(".action-dialog form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(result).toHaveBeenCalledExactlyOnceWith("新名称");
});
it("同名团队按 ID 选择，关闭按钮和卸载均取消操作", async () => {
  await act(async () => root.render(<Harness choices />));
  await click("button");
  const select = document.querySelector<HTMLSelectElement>(".action-dialog select");
  await act(async () => {
    if (select) {
      select.value = "two";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await click('.action-dialog button[type="submit"]');
  expect(result).toHaveBeenLastCalledWith("two");
  await click("button");
  await click('.action-dialog button[aria-label="关闭弹窗"]');
  expect(result).toHaveBeenLastCalledWith(null);
  await click("button");
  await act(async () => root.render(null));
  expect(result).toHaveBeenCalledTimes(3);
  expect(result).toHaveBeenLastCalledWith(null);
});

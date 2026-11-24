// @vitest-environment jsdom

import {
  DEFAULT_BRANDING,
  type BrandConfiguration,
  type SaveBrandingRequest,
} from "@hoox/protocol";
import { BrandingProvider } from "@hoox/ui-theme/branding";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrandingSettings } from "./branding-settings.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});
function click(host: HTMLElement, text: string) {
  const target = Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === text,
  );
  if (!target) throw new Error(`找不到按钮：${text}`);
  act(() => target.click());
}
function edit(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function mount(configuration: BrandConfiguration = DEFAULT_BRANDING) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const api = {
    getBranding: vi.fn(async () => ({ generation: 2, configuration })),
    saveBranding: vi.fn(async (input: SaveBrandingRequest) => ({
      generation: input.expectedGeneration + 1,
      configuration: input.configuration,
    })),
  };
  await act(async () =>
    root.render(
      <BrandingProvider load={false}>
        <BrandingSettings api={api} />
      </BrandingProvider>,
    ),
  );
  return { host, api };
}
describe("品牌设置页", () => {
  it("编辑、局部预览、保存后应用、恢复默认仍需保存", async () => {
    const { host, api } = await mount();
    edit(host.querySelector<HTMLInputElement>('input[maxlength="60"]')!, "<script>示例</script>");
    edit(host.querySelector<HTMLInputElement>('input[aria-label="主题主色"]')!, "#ffff00");
    click(host, "预览");
    expect(host.querySelector('[aria-label="品牌预览"]')?.textContent).toContain(
      "<script>示例</script>",
    );
    expect(host.querySelector("script")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--action-primary")).toBe("");
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(api.saveBranding).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGeneration: 2,
        configuration: expect.objectContaining({
          productName: "<script>示例</script>",
          primaryColor: "#ffff00",
        }),
      }),
    );
    expect(document.documentElement.style.getPropertyValue("--action-primary")).toBe("#ffff00");
    click(host, "恢复默认");
    expect(api.saveBranding).toHaveBeenCalledTimes(1);
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(api.saveBranding).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedGeneration: 3, configuration: DEFAULT_BRANDING }),
    );
    expect(document.documentElement.style.getPropertyValue("--action-primary")).toBe("");
  });
  it("校验链接和主色，保存未知结果时保留幂等请求并允许重试", async () => {
    const { host, api } = await mount();
    edit(host.querySelector<HTMLInputElement>('input[aria-label="主题主色"]')!, "red");
    click(host, "预览");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("品牌配置无效");
    expect(host.querySelector('[aria-label="品牌预览"]')).toBeNull();
    edit(host.querySelector<HTMLInputElement>('input[aria-label="主题主色"]')!, "#123456");
    api.saveBranding.mockRejectedValueOnce(new Error("暂时无法确认保存结果，请重试"));
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    const first = api.saveBranding.mock.calls[0]![0];
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(api.saveBranding.mock.calls[1]![0]).toEqual(first);
  });
  it("文件选择器只接收位图，拒绝 SVG 与超限 Logo", async () => {
    const { host } = await mount();
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe("image/png,image/jpeg,image/webp");
    for (const file of [
      new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }),
      new File([new Uint8Array(49153)], "logo.png", { type: "image/png" }),
    ]) {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
      expect(host.querySelector('[role="status"]')?.textContent).toContain("不支持 SVG");
    }
  });
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SiteRoot } from "./site-root.js";
vi.mock("./main.js", () => ({ App: () => <p>工作台</p> }));
let root: Root;
let container: HTMLDivElement;
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", fetcher);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  fetcher.mockReset();
});
describe("工作台的安装状态", () => {
  it("等待安装状态时不加载工作台", async () => {
    fetcher.mockImplementation(() => new Promise(() => {}));
    await act(async () => root.render(<SiteRoot />));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("正在检查 Hoox 安装状态…");
    expect(fetcher).toHaveBeenCalledWith("/api/v1/installation", { cache: "no-store" });
  });
  it("API 故障时工作台展示连接失败", async () => {
    fetcher.mockRejectedValue(new Error("offline"));
    await act(async () => root.render(<SiteRoot />));
    expect(container.textContent).toContain("无法连接 Hoox 服务");
  });
  it("已初始化后加载工作台", async () => {
    fetcher.mockResolvedValue(Response.json({ data: { initialized: true } }));
    await act(async () => root.render(<SiteRoot />));
    expect(container.textContent).toBe("工作台");
  });
});

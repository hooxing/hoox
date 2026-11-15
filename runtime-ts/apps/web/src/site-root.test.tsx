// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SiteRoot } from "./site-root.js";
vi.mock("./landing-page.js", () => ({ LandingPage: () => <p>公开首页</p> }));
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
describe("安装状态与公开入口", () => {
  it("API 故障时公开首页仍可访问", async () => {
    fetcher.mockRejectedValue(new Error("offline"));
    await act(async () => root.render(<SiteRoot surface="landing" />));
    expect(container.textContent).toBe("公开首页");
  });
  it("API 故障时工作台展示连接失败", async () => {
    fetcher.mockRejectedValue(new Error("offline"));
    await act(async () => root.render(<SiteRoot surface="workspace" />));
    expect(container.textContent).toContain("无法连接 Hoox 服务");
  });
  it("已初始化后加载工作台", async () => {
    fetcher.mockResolvedValue(Response.json({ data: { initialized: true } }));
    await act(async () => root.render(<SiteRoot surface="workspace" />));
    expect(container.textContent).toBe("工作台");
  });
});

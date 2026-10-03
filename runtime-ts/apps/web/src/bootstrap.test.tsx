// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
const render = vi.hoisted(() => vi.fn());
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render }) }));
vi.mock("./site-root.js", () => ({ SiteRoot: () => null }));
afterEach(() => {
  vi.resetModules();
  render.mockClear();
  document.body.innerHTML = "";
  document.querySelectorAll('meta[name="robots"]').forEach((meta) => {
    meta.remove();
  });
});

describe("Web 入口装配", () => {
  it.each([
    ["/", "landing"],
    ["/app", "workspace"],
    ["/app/", "workspace"],
    ["/?error=access_denied", "workspace"],
  ])("%s 装配对应页面并隔离滚动样式", async (url, surface) => {
    window.history.replaceState(null, "", url);
    document.title = "Hoox — 你说，它做。";
    document.body.innerHTML = '<div id="root"></div>';
    await import("./bootstrap.js");
    expect(document.documentElement.dataset.surface).toBe(surface);
    expect(render.mock.calls[0]?.[0].props.surface).toBe(surface);
    expect(document.title).toBe(surface === "workspace" ? "Hoox 工作台" : "Hoox — 你说，它做。");
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
      surface === "workspace" ? "noindex, nofollow" : undefined,
    );
  });
  it("缺少根节点时不尝试挂载", async () => {
    await import("./bootstrap.js");
    expect(render).not.toHaveBeenCalled();
  });
});

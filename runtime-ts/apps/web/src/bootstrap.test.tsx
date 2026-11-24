// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { LandingPage } from "./landing-page.js";
import { SiteRoot } from "./site-root.js";
import { BrandingProvider } from "@hoox/ui-theme/branding";

const { hydrateRoot, render } = vi.hoisted(() => ({ hydrateRoot: vi.fn(), render: vi.fn() }));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render }), hydrateRoot }));
vi.mock("./landing-page.js", () => ({ LandingPage: () => null }));
vi.mock("./site-root.js", () => ({ SiteRoot: () => null }));
afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  delete document.documentElement.dataset.surface;
});

describe("Web 入口装配", () => {
  it("开发首页没有预渲染标记，直接挂载首页", async () => {
    window.history.replaceState(null, "", "/?utm_source=github");
    document.documentElement.dataset.surface = "landing";
    document.body.innerHTML = '<div id="root"></div>';
    await import("./bootstrap.js");
    expect(render.mock.calls[0]?.[0].type).toBe(LandingPage);
    expect(hydrateRoot).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.surface).toBe("landing");
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
  });
  it("生产首页使用预渲染标记和页脚配置进行水合", async () => {
    window.history.replaceState(null, "", "/");
    document.body.innerHTML =
      '<div id="root" data-prerendered data-privacy-url="https://hoox.example.org/privacy"></div>';
    await import("./bootstrap.js");
    expect(hydrateRoot).toHaveBeenCalledOnce();
    expect(hydrateRoot.mock.calls[0]?.[0]).toBe(document.getElementById("root"));
    expect(hydrateRoot.mock.calls[0]?.[1].type).toBe(LandingPage);
    expect(hydrateRoot.mock.calls[0]?.[1].props.privacyUrl).toBe(
      "https://hoox.example.org/privacy",
    );
    expect(render).not.toHaveBeenCalled();
  });
  it.each(["/app", "/app/"])("%s 直接装配工作台", async (url) => {
    window.history.replaceState(null, "", url);
    document.body.innerHTML = '<div id="root"></div>';
    await import("./workspace-bootstrap.js");
    expect(document.documentElement.dataset.surface).toBe("workspace");
    expect(render.mock.calls[0]?.[0].type.name).toBe(BrandingProvider.name);
    expect(render.mock.calls[0]?.[0].props.children.type).toBe(SiteRoot);
    expect(document.title).toBe("Hoox 工作台");
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
      "noindex, nofollow",
    );
  });
  it("首页外壳收到旧 OAuth 错误回调时，不水合首页而是装配工作台", async () => {
    window.history.replaceState(null, "", "/?error=access_denied");
    document.body.innerHTML = '<div id="root" data-prerendered></div>';
    document.head.innerHTML =
      '<meta property="og:type" content="website"><link rel="canonical" href="/">';
    await import("./bootstrap.js");
    await vi.dynamicImportSettled();
    expect(document.documentElement.dataset.surface).toBe("workspace");
    expect(render.mock.calls[0]?.[0].type.name).toBe(BrandingProvider.name);
    expect(render.mock.calls[0]?.[0].props.children.type).toBe(SiteRoot);
    expect(hydrateRoot).not.toHaveBeenCalled();
    expect(
      document.head.querySelector('link[rel="canonical"], meta[property="og:type"]'),
    ).toBeNull();
  });
  it("缺少根节点时不尝试挂载", async () => {
    window.history.replaceState(null, "", "/");
    await import("./bootstrap.js");
    expect(render).not.toHaveBeenCalled();
    expect(hydrateRoot).not.toHaveBeenCalled();
  });
});

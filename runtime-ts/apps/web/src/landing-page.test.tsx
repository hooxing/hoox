// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bookArtifacts } from "./landing-case.js";
import { LandingPage } from "./landing-page.js";
import { resolveSiteSurface } from "./site-route.js";
import { InlineArtifactDelivery } from "./workspace-view.js";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("正式产品首页", () => {
  it("无需会话或 API，以真实组件展示经过授权的公开案例", async () => {
    const fetch = vi.fn(() => {
      throw new Error("首页不得访问运行 API");
    });
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(<LandingPage />));
    expect(fetch).not.toHaveBeenCalled();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.textContent).toContain("国富论.epub");
    expect(container.textContent).toContain("国富论-思维导图.html");
    expect(container.textContent).toContain("国富论-思维导图.md");
    expect(container.querySelector(".assistant-transcript")).not.toBeNull();
    expect(container.querySelector(".inline-artifact-delivery")).not.toBeNull();
    expect(container.querySelector(".artifact-actions")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).not.toMatch(
      /DESIGN STUDY|设计切换|申请内测|虚构样例|demo@|HooxDemo/u,
    );
  });
  it("同域工作台入口不回环，所有开源入口采用安全外链", async () => {
    await act(async () => root.render(<LandingPage />));
    const links = [...container.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.filter((link) => link.pathname === "/app").length).toBeGreaterThanOrEqual(3);
    const external = links.filter((link) => link.target === "_blank");
    expect(external.length).toBeGreaterThan(8);
    for (const link of external) {
      expect(link.href).toMatch(/^https:\/\/github\.com\/hooxing\/hoox(?:\/|$)/u);
      expect(link.rel).toBe("noopener noreferrer");
    }
    for (const link of links.filter((link) => link.getAttribute("href")?.startsWith("#"))) {
      expect(container.querySelector(link.getAttribute("href") ?? "")).not.toBeNull();
    }
    expect(container.textContent).toContain("Skills 不扩张工具或权限");
    expect(container.textContent).toContain("当前为 0.x 早期开发阶段");
  });
  it("只读交付卡片没有预览下载控制，工作台默认行为保持不变", async () => {
    const onDownload = vi.fn();
    const onPreview = vi.fn();
    await act(async () =>
      root.render(
        <InlineArtifactDelivery
          artifacts={bookArtifacts}
          readOnly
          onPreview={onPreview}
          onDownload={onDownload}
        />,
      ),
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
    await act(async () =>
      root.render(
        <InlineArtifactDelivery
          artifacts={bookArtifacts}
          onPreview={onPreview}
          onDownload={onDownload}
        />,
      ),
    );
    const download = container.querySelector<HTMLButtonElement>(
      '[aria-label="下载 国富论-思维导图.md"]',
    );
    expect(download).not.toBeNull();
    await act(async () => download?.click());
    expect(onDownload).toHaveBeenCalledWith("public-book-md");
  });
});

describe("公开首页与工作台入口边界", () => {
  it.each(["/", "/index.html"])("%s 默认展示首页，不因普通参数触发身份请求", (pathname) => {
    expect(resolveSiteSurface({ pathname, search: "" })).toBe("landing");
    expect(resolveSiteSurface({ pathname, search: "?utm_source=github" })).toBe("landing");
  });
  it.each(["/app", "/app/", "/existing-path"])("%s 保留工作台 SPA 入口", (pathname) => {
    expect(resolveSiteSurface({ pathname, search: "" })).toBe("workspace");
  });
  it("旧根路径的 OAuth 错误回调继续进入身份界面", () => {
    expect(resolveSiteSurface({ pathname: "/", search: "?error=access_denied" })).toBe("workspace");
  });
});

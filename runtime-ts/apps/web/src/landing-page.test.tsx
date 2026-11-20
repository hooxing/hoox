// @vitest-environment jsdom
import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bookArtifacts } from "./landing-case.js";
import { LandingPage } from "./landing-page.js";
import { renderLanding } from "./landing-prerender.js";
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
  it("在保留预渲染节点的情况下水合首页交互，不发起安装请求", async () => {
    await act(async () => root.unmount());
    const links = { privacyUrl: "https://hoox.example.org/privacy?a=1&b=2" };
    container.innerHTML = renderLanding(links);
    const heading = container.querySelector("h1");
    const onRecoverableError = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await act(async () => {
      root = hydrateRoot(container, <LandingPage {...links} />, { onRecoverableError });
    });
    expect(container.querySelector("h1")).toBe(heading);
    const button = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("原生工具调用"),
    );
    await act(async () => button?.click());
    expect(button?.getAttribute("aria-pressed")).toBe("true");
    expect(fetch).not.toHaveBeenCalled();
    expect(onRecoverableError).not.toHaveBeenCalled();
  });
  it("窄屏披露菜单覆盖所有桌面导航，保留独立工作台入口", async () => {
    await act(async () => root.render(<LandingPage />));
    const menu = container.querySelector<HTMLDetailsElement>("details.landing-nav-menu");
    expect(menu?.open).toBe(false);
    expect(menu?.querySelector("summary")?.textContent).toBe("菜单");
    const hrefs = (selector: string) =>
      [...container.querySelectorAll(selector)].map((link) => link.getAttribute("href"));
    expect(hrefs(".landing-nav-menu a")).toEqual(hrefs(".landing-nav-sections a"));
    expect(hrefs(".landing-nav-app")).toEqual(["/app"]);
  });
  it("页脚链接指向维护入口，隐私和条款分别按配置显示", async () => {
    await act(async () => root.render(<LandingPage />));
    const footerLinks = () =>
      Object.fromEntries(
        [...container.querySelectorAll("footer nav a")].map((link) => [
          link.textContent,
          link.getAttribute("href"),
        ]),
      );
    expect(footerLinks()).toMatchObject({
      文档: "https://github.com/hooxing/hoox/blob/main/docs/README.md",
      变更记录: "https://github.com/hooxing/hoox/blob/main/CHANGELOG.md",
      GitHub: "https://github.com/hooxing/hoox",
      Issue: "https://github.com/hooxing/hoox/issues",
    });
    expect(footerLinks()).not.toHaveProperty("隐私");
    expect(footerLinks()).not.toHaveProperty("条款");
    await act(async () =>
      root.render(<LandingPage privacyUrl="https://hoox.example.org/privacy" />),
    );
    expect(footerLinks()).toHaveProperty("隐私", "https://hoox.example.org/privacy");
    expect(footerLinks()).not.toHaveProperty("条款");
    await act(async () => root.render(<LandingPage termsUrl="https://hoox.example.org/terms" />));
    expect(footerLinks()).not.toHaveProperty("隐私");
    expect(footerLinks()).toHaveProperty("条款", "https://hoox.example.org/terms");
  });
  it("调用模式、生命周期与供应商切换只更新本地演示，保留能力边界", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(<LandingPage />));
    const choose = async (group: string, text: string) => {
      const fieldset = container.querySelector(`[aria-label="${group}"]`);
      const target = [...(fieldset?.querySelectorAll("button") ?? [])].find((button) =>
        button.textContent?.includes(text),
      );
      expect(target).toBeDefined();
      await act(async () => target?.click());
      expect(target?.getAttribute("aria-pressed")).toBe("true");
      expect(fieldset?.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    };
    expect(container.textContent).toContain("当前内部工具串行执行");
    await choose("工具调用模式演示", "原生工具调用");
    expect(container.querySelector(".landing-execution-body")?.getAttribute("data-mode")).toBe(
      "native",
    );
    expect(container.textContent).toContain("模型读取工具回执，再决定下一步");
    await choose("沙箱空闲策略演示", "任务后销毁");
    expect(container.querySelector(".landing-cube-front")?.textContent).toContain("Sandbox B");
    await choose("沙箱供应商接入演示", "腾讯云 AGS");
    expect(container.textContent).toContain("接入示意：腾讯云 AGS");
    expect(container.textContent).toContain("已有沙箱继续使用原来的供应商，不会自动切换");
    expect(container.textContent).toContain("分支生成后各自推进，不双向同步");
    expect(container.textContent).toContain("文本快照");
    expect(container.textContent).toContain("Mem0 可选接入");
    expect(fetch).not.toHaveBeenCalled();
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

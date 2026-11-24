// @vitest-environment jsdom

import { DEFAULT_BRANDING } from "@hoox/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  BrandingFooter,
  BrandingProvider,
  BrandLogo,
  brandForeground,
  brandingTokens,
  contrast,
  moduleVisible,
  useBranding,
} from "./branding.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
describe("共享品牌主题", () => {
  it("默认预览保留加载品牌前的主题令牌，不继承当前自定义主色", async () => {
    document.documentElement.style.setProperty("--action-primary", "#344d42");
    function Preview() {
      const { defaultTokens } = useBranding();
      return <output>{defaultTokens["--action-primary"]}</output>;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <BrandingProvider load={false} initial={{ ...DEFAULT_BRANDING, primaryColor: "#ffff00" }}>
            <Preview />
          </BrandingProvider>,
        ),
      );
      expect(document.documentElement.style.getPropertyValue("--action-primary")).toBe("#ffff00");
      expect(host.textContent).toBe("#344d42");
    } finally {
      await act(async () => root.unmount());
      document.documentElement.style.removeProperty("--action-primary");
    }
  });
  it("匿名加载的配置应用 Logo、页脚与图标，图片从不以内联 HTML 执行", async () => {
    const logo =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                ...DEFAULT_BRANDING,
                productName: "公开品牌",
                logoDataUrl: logo,
                footerLinks: [{ text: "联系支持", url: "mailto:help@example.invalid" }],
              },
            }),
            { status: 200 },
          ),
      ),
    );
    const icon = document.createElement("link");
    icon.rel = "icon";
    icon.href = "/default.png";
    icon.type = "image/png";
    document.head.append(icon);
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <BrandingProvider>
            <BrandLogo />
            <BrandingFooter />
          </BrandingProvider>,
        ),
      );
      expect(host.querySelector("img")?.getAttribute("src")).toBe(logo);
      expect(host.textContent).toContain("公开品牌");
      expect(host.querySelector('a[href="mailto:help@example.invalid"]')).not.toBeNull();
      expect(icon.getAttribute("href")).toBe(logo);
      expect(host.querySelector("svg,object,iframe,script")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
    expect(icon.getAttribute("href")).toBe("/default.png");
    expect(icon.type).toBe("image/png");
    icon.remove();
  });
  it("默认 Logo DOM 完全一致、页脚为空、默认 CSS 不注入覆盖", () => {
    const logo = <BrandLogo src="/brand/hoox.png" className="logo" alt="Hoox" />;
    expect(
      renderToStaticMarkup(
        <BrandingProvider load={false}>
          {logo}
          <BrandingFooter />
        </BrandingProvider>,
      ),
    ).toBe(renderToStaticMarkup(<img src="/brand/hoox.png" className="logo" alt="Hoox" />));
    expect(brandingTokens(null)).toEqual({});
    expect(moduleVisible(DEFAULT_BRANDING, "team_spaces")).toBe(true);
  });
  it.each(["#ffffff", "#000000", "#ffff00", "#336699", "#808080", "#ff0000", "#00ff00"])(
    "主色 %s 的默认、悬停和按下前景对比度均达 4.5",
    (color) => {
      const tokens = brandingTokens(color);
      for (const key of ["--action-primary", "--action-primary-hover", "--action-primary-active"])
        expect(contrast(tokens[key]!, brandForeground(color))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens["--brand-green"]!, "#f2f0ed")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens["--action-primary-link"]!, "#f2f0ed")).toBeGreaterThanOrEqual(4.5);
    },
  );
  it("公开读取失败回退默认，修改主题和卸载恢复原有标题与 CSS", async () => {
    const fetcher = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const host = document.createElement("div");
    const root = createRoot(host);
    document.title = "Hoox 工作台";
    document.documentElement.style.setProperty("--action-primary", "original");
    try {
      await act(async () =>
        root.render(
          <BrandingProvider>
            <BrandLogo src="/original.png" />
          </BrandingProvider>,
        ),
      );
      expect(host.querySelector("img")?.getAttribute("src")).toBe("/original.png");
      expect(fetcher).toHaveBeenCalledWith(
        "/api/v1/public/branding",
        expect.objectContaining({ credentials: "omit" }),
      );
      await act(async () => root.unmount());
      const customRoot = createRoot(host);
      try {
        await act(async () =>
          customRoot.render(
            <BrandingProvider
              load={false}
              initial={{
                ...DEFAULT_BRANDING,
                productName: "示例 $& 平台",
                primaryColor: "#ffff00",
              }}
            >
              <BrandLogo />
            </BrandingProvider>,
          ),
        );
        expect(document.title).toBe("示例 $& 平台 工作台");
        expect(document.documentElement.style.getPropertyValue("--action-primary-text")).toBe(
          "#000000",
        );
      } finally {
        await act(async () => customRoot.unmount());
      }
      expect(document.title).toBe("Hoox 工作台");
      expect(document.documentElement.style.getPropertyValue("--action-primary")).toBe("original");
    } finally {
      document.documentElement.removeAttribute("style");
      vi.unstubAllGlobals();
    }
  });
  it("产品名与页脚不生成可执行标签", () => {
    const html = renderToStaticMarkup(
      <BrandingProvider
        load={false}
        initial={{
          ...DEFAULT_BRANDING,
          productName: "<script>bad()</script>",
          footerLinks: [{ text: "<img onerror=bad()>", url: "https://example.invalid" }],
        }}
      >
        <BrandLogo />
        <BrandingFooter />
      </BrandingProvider>,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img onerror");
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

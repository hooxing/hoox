import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRANDING,
  MAX_BRAND_LOGO_BYTES,
  normalizeBranding,
  validateBrandLogo,
} from "./branding.js";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
describe("公开品牌契约", () => {
  it("未配置保留默认值且不会共享可变数组", () => {
    const result = normalizeBranding(DEFAULT_BRANDING);
    expect(result).toEqual({
      productName: "Hoox",
      logoDataUrl: null,
      primaryColor: null,
      footerLinks: [],
      hiddenModules: [],
    });
    expect(result.footerLinks).not.toBe(DEFAULT_BRANDING.footerLinks);
    expect(result.hiddenModules).not.toBe(DEFAULT_BRANDING.hiddenModules);
  });
  it.each(["#fff", "red", "var(--x)", "#000000;background:red", "#gggggg"])(
    "拒绝非法主色 %s",
    (primaryColor) => {
      expect(() => normalizeBranding({ ...DEFAULT_BRANDING, primaryColor })).toThrow(TypeError);
    },
  );
  it.each([
    "javascript:alert(1)",
    "data:text/html,test",
    "http://example.invalid",
    "//example.invalid",
    "https://user:pass@example.invalid",
    "mailto:user@example.invalid?body=hello",
    "mailto:user@example.invalid%0d%0abcc:other@example.invalid",
  ])("拒绝链接 %s", (url) => {
    expect(() =>
      normalizeBranding({ ...DEFAULT_BRANDING, footerLinks: [{ text: "入口", url }] }),
    ).toThrow(TypeError);
  });
  it("只接受公开字段、模块白名单及有界名称与链接", () => {
    for (const patch of [
      { internalSecret: "placeholder" },
      { hiddenModules: ["admin"] },
      { hiddenModules: ["skills", "skills"] },
      { productName: " " },
      { productName: "x".repeat(61) },
      {
        footerLinks: Array.from({ length: 6 }, () => ({
          text: "入口",
          url: "https://example.invalid",
        })),
      },
      { footerLinks: [{ text: "x".repeat(61), url: "https://example.invalid" }] },
      { footerLinks: [{ text: "入口", url: `https://example.invalid/${"x".repeat(2048)}` }] },
    ]) {
      expect(() => normalizeBranding({ ...DEFAULT_BRANDING, ...patch })).toThrow(TypeError);
    }
  });
  it("名称和链接文字保留为纯文本数据", () => {
    const configuration = {
      ...DEFAULT_BRANDING,
      productName: "<script>alert(1)</script>",
      primaryColor: "#AAbbCC",
      logoDataUrl: png,
      footerLinks: [
        { text: "<img onerror=alert(1)>", url: "https://example.invalid/help" },
        { text: "联系", url: "mailto:help@example.invalid" },
      ],
    };
    expect(normalizeBranding(configuration)).toEqual(configuration);
  });
  it("拒绝 SVG、伪装 MIME、无效 Base64 和远程 Logo", () => {
    expect(() => validateBrandLogo(png)).not.toThrow();
    for (const logo of [
      "https://example.invalid/logo.png",
      "data:image/svg+xml;base64,PHN2Zy8+",
      `data:image/png;base64,${btoa('<svg onload="alert(1)"/>')}`,
      png.replace("image/png", "image/jpeg"),
      "data:image/png;base64,%%%%",
      png.replace("base64,", "base64,\n"),
    ]) {
      expect(() => validateBrandLogo(logo)).toThrow(TypeError);
    }
  });
  it("接受 PNG/JPEG/WebP 签名并限制解码后大小", () => {
    expect(() =>
      validateBrandLogo(`data:image/jpeg;base64,${btoa("\xff\xd8\xff\xff\xd9")}`),
    ).not.toThrow();
    expect(() =>
      validateBrandLogo(`data:image/webp;base64,${btoa("RIFFxxxxWEBPVP8 xxxxx")}`),
    ).not.toThrow();
    const prefix = "\x89PNG\r\n\x1a\nxxxxIHDR";
    expect(() =>
      validateBrandLogo(`data:image/png;base64,${btoa(prefix.padEnd(MAX_BRAND_LOGO_BYTES, "x"))}`),
    ).not.toThrow();
    expect(() =>
      validateBrandLogo(
        `data:image/png;base64,${btoa(prefix.padEnd(MAX_BRAND_LOGO_BYTES + 1, "x"))}`,
      ),
    ).toThrow(TypeError);
  });
});

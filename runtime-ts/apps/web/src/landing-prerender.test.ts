import { expect, it } from "vitest";
import { renderLanding } from "./landing-prerender.js";

it("无需浏览器全局变量即可预渲染首页正文、菜单和已配置页脚链接", () => {
  const markup = renderLanding({ privacyUrl: "https://hoox.example.org/privacy?a=1&b=2" });
  expect(markup).toContain('<main id="main-content">');
  expect(markup).toContain('<h1 id="hero-title">');
  expect(markup).toContain("国富论.epub");
  expect(markup).toContain("<summary>菜单</summary>");
  expect(markup).toContain('href="https://hoox.example.org/privacy?a=1&amp;b=2"');
  expect(markup).not.toContain(">条款<");
  expect(markup).not.toContain("正在检查 Hoox 安装状态");
});

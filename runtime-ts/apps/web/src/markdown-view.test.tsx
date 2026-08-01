// @vitest-environment jsdom
/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantMarkdown } from "./markdown-view.js";

const webStylesPath = [
  resolve(process.cwd(), "src/styles.css"),
  resolve(process.cwd(), "runtime-ts/apps/web/src/styles.css"),
].find(existsSync);
if (webStylesPath === undefined) throw new Error("未找到 Web 样式表");
const webStyles = readFileSync(webStylesPath, "utf8");

function renderMarkdown(text: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<AssistantMarkdown text={text} />);
  return container;
}

describe("助手 Markdown", () => {
  it("渲染 GFM 表格、任务列表、删除线与带语言的代码块", () => {
    const container = renderMarkdown(`
| 项目 | 状态 |
| --- | --- |
| 安全渲染 | 完成 |

- [x] 支持任务列表
- [ ] 待处理任务

~~旧结论~~

\`\`\`ts
const ready = true;
\`\`\`
`);

    expect(container.querySelector("table")?.textContent).toContain("安全渲染");
    const taskInputs = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(taskInputs).toHaveLength(2);
    expect(taskInputs[0]?.checked).toBe(true);
    expect(taskInputs[0]?.disabled).toBe(true);
    expect(taskInputs[0]?.getAttribute("aria-label")).toBe("任务已完成");
    expect(taskInputs[1]?.checked).toBe(false);
    expect(taskInputs[1]?.disabled).toBe(true);
    expect(taskInputs[1]?.getAttribute("aria-label")).toBe("任务未完成");
    expect(container.querySelector("del")?.textContent).toBe("旧结论");
    expect(container.querySelector("pre code")?.className).toContain("language-ts");
    expect(container.querySelector("pre code")?.textContent).toContain("const ready = true;");
  });

  it("丢弃原始 HTML 并阻止危险协议进入链接属性", () => {
    const container = renderMarkdown(`
<img src=x onerror="globalThis.compromised=true">
<script>globalThis.compromised=true</script>
`);
    const unsafeLink = renderMarkdown("[危险链接](javascript:alert(document.domain))");

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("onerror");
    expect(unsafeLink.textContent).toContain("危险链接");
    expect(unsafeLink.innerHTML).not.toContain("javascript:");
    expect(unsafeLink.querySelector("a")).toBeNull();
    expect(unsafeLink.querySelector(".markdown-invalid-link")?.textContent).toBe("危险链接");
  });

  it("不允许 Markdown 图片触发第三方资源请求", () => {
    const container = renderMarkdown("![追踪像素](https://tracker.example/pixel.gif)");

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("[图片：追踪像素]");
    expect(container.innerHTML).not.toContain("tracker.example");
  });

  it("外部网页使用新窗口隔离，站内链接保持当前窗口", () => {
    const container = renderMarkdown(
      "[外部文档](https://example.com/docs) [站内产物](/artifacts/report)",
    );
    const links = container.querySelectorAll("a");

    expect(links[0]?.getAttribute("href")).toBe("https://example.com/docs");
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[1]?.getAttribute("href")).toBe("/artifacts/report");
    expect(links[1]?.hasAttribute("target")).toBe(false);
    expect(links[1]?.hasAttribute("rel")).toBe(false);
  });

  it("运行时资源引用退化为文件提示，避免进入无法下载的伪路由", () => {
    const container = renderMarkdown(
      "[下载报告](./resource_version_a2cb5e9e3516c1a1b84fb90354ba35529d3ec6df4fa531165a5c2e3eca3b9bee)",
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector(".markdown-artifact-reference")?.textContent).toBe("下载报告");
  });

  it("任务复选框完整覆盖全局输入框盒模型", () => {
    const selector = '.assistant-markdown input[type="checkbox"]';
    const start = webStyles.indexOf(selector);
    const checkboxRule = webStyles.slice(start, webStyles.indexOf("}", start));

    expect(start).toBeGreaterThanOrEqual(0);
    expect(checkboxRule).toContain("all: revert");
    expect(checkboxRule).toContain("width: 14px");
    expect(checkboxRule).toContain("height: 14px");
    expect(checkboxRule).toContain("padding: 0");
    expect(checkboxRule).toContain("border: 0");
    expect(checkboxRule).toContain("appearance: auto");
  });
});

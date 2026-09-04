// @vitest-environment jsdom
import { IncrementalMarkdownParser } from "@hoox/vendor-deepseek-markdown";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownStream, parseMarkdown } from "./markdown-stream.js";
import { AssistantMarkdown } from "./markdown-view.js";

const cleanups: (() => void)[] = [];
function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return {
    container,
    render: (text: string, streaming = true) =>
      act(() => root.render(<AssistantMarkdown text={text} streaming={streaming} />)),
  };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("Markdown 增量渲染", () => {
  it("保留稳定段落和代码行 DOM，完成时不重新挂载正文", () => {
    const { container, render } = mount();
    const prefix = "第一段。\n\n第二段。\n\n第三段。\n\n```ts\n";
    const lines = Array.from({ length: 64 }, (_, index) => `const n${index} = ${index};`).join(
      "\n",
    );
    render(`${prefix + lines}\n`);
    const paragraph = container.querySelector("p");
    const code = container.querySelector("code");
    const firstGroup = code?.firstChild;
    render(`${prefix + lines}\nconst tail = true;\n`);
    expect(container.querySelector("p")).toBe(paragraph);
    expect(container.querySelector("code")).toBe(code);
    expect(code?.firstChild).toBe(firstGroup);
    render(`${prefix + lines}\nconst tail = true;\n\`\`\``, false);
    expect(container.querySelector("p")).toBe(paragraph);
    expect(container.querySelector("code")).toBe(code);
    expect(code?.firstChild).toBe(firstGroup);
    expect(code?.textContent).toBe(`${lines}\nconst tail = true;\n`);
  });

  it("追加引用定义能修正前文，并保留 GFM 表格语义", () => {
    const { container, render } = mount();
    let source = "[资料][ref]\n\n一段\n\n二段\n\n三段\n\n";
    render(source);
    expect(container.querySelector("a")).toBeNull();
    source += "[ref]: https://example.com/docs\n\n";
    render(source);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/docs");
    source += "| 名称 | 结果 |\n| --- | --- |\n| 中文🧑‍💻 | 成功 |";
    render(source);
    expect(container.querySelector("table")?.textContent).toContain("中文🧑‍💻");
    render(source, false);
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelectorAll("table")).toHaveLength(1);
  });

  it("跨块引用与脚注走全文语义，替换正文后恢复增量路径", () => {
    const stream = new MarkdownStream();
    expect(stream.update("脚注[^a]\n\n[^a]: 内容", true)).toBeUndefined();
    expect(stream.update("新正文\n\n下一段", true)).toHaveLength(2);
    expect(stream.update("[资料][a]\n\n[a]: /docs", false)).toBeUndefined();
  });

  it("长代码流只解析有界尾部，稳定前缀保持对象身份", () => {
    let parsedCharacters = 0;
    let largestSlice = 0;
    const parser = new IncrementalMarkdownParser((text) => {
      parsedCharacters += text.length;
      largestSlice = Math.max(largestSlice, text.length);
      return parseMarkdown(text);
    });
    let source = "前文\n\n一\n\n二\n\n```ts\n";
    const first = parser.update(source).frozen[0];
    for (let index = 0; index < 800; index += 1) {
      source += `const value${index} = ${index};\n`;
      parser.update(source);
    }
    expect(largestSlice).toBeLessThan(128);
    const result = parser.update(`${source}\`\`\`\n`);
    expect(result.frozen[0]).toBe(first);
    expect(parsedCharacters).toBeLessThan(source.length * 5);
  });
});

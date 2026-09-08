// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseCellRange, regionSelection, textSelection } from "./file-preview-selection.js";
import { checkOfficeArchive, parseDelimited } from "./file-preview-data.js";

describe("文件选区与解析边界", () => {
  it("跨节点文字选择保存原文、上下文和行号，拒绝跨容器选择", () => {
    document.body.innerHTML = '<div id="content">第一行\n<span>第二行</span>后文</div><p>外部</p>';
    const root = document.getElementById("content") as HTMLElement;
    const range = document.createRange();
    range.setStart(root.firstChild as Node, 2);
    range.setEnd(root.querySelector("span")?.firstChild as Node, 2);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(textSelection(root, selection, undefined, true)).toMatchObject({
      kind: "text",
      start: 2,
      quote: "行\n第二",
      lineStart: 1,
      lineEnd: 2,
    });
    range.setEnd(document.querySelector("p")?.firstChild as Node, 1);
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(textSelection(root, selection)).toBeUndefined();
  });
  it("反向框选和越界拖动都使用归一化坐标，忽略误触", () => {
    expect(regionSelection({ x: 0.8, y: 0.7 }, { x: -0.2, y: 0.1 }, 3, 1000, 500)).toEqual({
      kind: "region",
      page: 3,
      x: 0,
      y: 0.1,
      width: 0.8,
      height: 0.6,
      viewportWidth: 1000,
      viewportHeight: 500,
    });
    expect(
      regionSelection({ x: 0.5, y: 0.5 }, { x: 0.501, y: 0.501 }, 1, 100, 100),
    ).toBeUndefined();
  });
  it("单元格范围保留实际地址并拒绝反向和超出 Excel 边界的坐标", () => {
    expect(parseCellRange("B3:F12")).toEqual({ startCol: 1, endCol: 5, startRow: 2, endRow: 11 });
    expect(parseCellRange("F12:B3")).toBeUndefined();
    expect(parseCellRange("XFE1")).toBeUndefined();
    expect(parseCellRange("A1048577")).toBeUndefined();
  });
  it("CSV 支持带逗号、转义引号、跨行字段和 CRLF", () => {
    expect(
      parseDelimited('名称,说明\r\n甲,"跨行\n含逗号,及""引号"""\r\n', ",").rows.map((row) =>
        row.map((cell) => cell.text),
      ),
    ).toEqual([
      ["名称", "说明"],
      ["甲", '跨行\n含逗号,及"引号"'],
    ]);
    expect(() => parseDelimited('"未闭合', ",")).toThrow("未闭合");
    expect(() => checkOfficeArchive(new ArrayBuffer(4))).toThrow("损坏");
  });
});

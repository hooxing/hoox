import { describe, expect, it } from "vitest";
import {
  appendFileReferences,
  filePreviewKind,
  readFileReferences,
  type FileReference,
} from "./file-references.js";

const reference: FileReference = {
  source: {
    threadId: "thread_1",
    runId: "run_1",
    artifactId: "artifact_1",
    versionId: "version_1",
    name: "报告.docx",
  },
  selection: { kind: "text", start: 0, end: 2, quote: "修改" },
};
describe("文件引用契约", () => {
  it("往返保存固定版本及含协议结束标记的原文", () => {
    const item = {
      ...reference,
      selection: {
        kind: "text" as const,
        start: 0,
        end: "修改\n</hoox-file-references-v1>".length,
        quote: "修改\n</hoox-file-references-v1>",
      },
    };
    const encoded = appendFileReferences("把这段简化", [item]);
    expect(readFileReferences(encoded)).toEqual({ text: "把这段简化", references: [item] });
    expect(readFileReferences(appendFileReferences("普通输入", []))).toEqual({
      text: "普通输入",
      references: [],
    });
  });
  it("损坏、越界或未知选择器不隐藏用户原文", () => {
    for (const selection of [
      { kind: "unknown" },
      { kind: "text", quote: "x", start: 3, end: 1 },
      {
        kind: "region",
        page: 1,
        x: 0.9,
        y: 0,
        width: 0.3,
        height: 1,
        viewportWidth: 100,
        viewportHeight: 100,
      },
    ]) {
      const input = appendFileReferences("说明", [{ ...reference, selection } as FileReference]);
      expect(readFileReferences(input)).toEqual({ text: input, references: [] });
    }
  });
  it("首批覆盖 Office，主动内容不作为网页执行", () => {
    expect(filePreviewKind("报告.DOCX")).toBe("docx");
    expect(filePreviewKind("预算.xlsx")).toBe("table");
    expect(filePreviewKind("演示.pptx")).toBe("pptx");
    expect(filePreviewKind("代码.ts")).toBe("code");
    expect(filePreviewKind("说明.md")).toBe("markdown");
    expect(filePreviewKind("网页.html", "text/html")).toBeUndefined();
    expect(filePreviewKind("图.svg", "image/svg+xml")).toBeUndefined();
  });
});

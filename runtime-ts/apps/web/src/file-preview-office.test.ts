// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { prepareOfficePreview } from "./file-preview-office.js";

describe("Office 预览外部关系隔离", () => {
  it("解析器运行前去掉外部图片、协议地址和外链，保留内嵌资源且不改原文件", async () => {
    const zip = new JSZip();
    const xml =
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image" Target="media/image.png"/><Relationship Id="external" TargetMode="External" Target="https://example.invalid/tracker"/><Relationship Id="scheme" Target="file:///private"/><Relationship Id="relative" Target="//example.invalid/tracker"/></Relationships>';
    zip.file("word/_rels/document.xml.rels", xml);
    zip.file("word/media/image.png", new Uint8Array([1]));
    const original = await zip.generateAsync({ type: "arraybuffer" });
    const prepared = await prepareOfficePreview(original);
    const output = await JSZip.loadAsync(prepared);
    const relations = await output.file("word/_rels/document.xml.rels")?.async("string");
    expect(relations).toContain('Id="image"');
    expect(relations).not.toContain('Id="external"');
    expect(relations).not.toContain('Id="scheme"');
    expect(relations).not.toContain('Id="relative"');
    expect(
      await (await JSZip.loadAsync(original)).file("word/_rels/document.xml.rels")?.async("string"),
    ).toBe(xml);
  });
});

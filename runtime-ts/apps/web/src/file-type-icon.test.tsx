import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fileIconKind, FileTypeIcon } from "./file-type-icon.js";
import { InlineArtifactDelivery, ThreadTranscript } from "./workspace-view.js";

describe("文件类型图标", () => {
  it.each([
    ["公告.DOCX", undefined, "docx"],
    ["财务.xlsx", "application/octet-stream", "xlsx"],
    ["演示.pptx", undefined, "pptx"],
    ["报告.pdf", undefined, "pdf"],
    ["数据.csv", undefined, "csv"],
    ["归档.tar.gz", undefined, "zip"],
    ["README", " Text/Markdown; charset=utf-8 ", "md"],
    ["下载", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
    ["照片.unknown", "image/jpeg", "image"],
    ["音频", "audio/wav", "mp3"],
    ["视频", "video/webm", "mp4"],
    ["报告.docx", "application/pdf", "docx"],
    ["未知.custom", "application/octet-stream", "blank"],
    ["文件.constructor", undefined, "blank"],
    ["文件.__proto__", "constructor", "blank"],
    ["folder.docx/README", undefined, "blank"],
  ])("将 %s 映射为对应图标", (name, mediaType, expected) => {
    expect(fileIconKind(name, mediaType)).toBe(expected);
  });

  it("图标由本地资源提供且作为装饰，不重复朗读文件名", () => {
    const html = renderToStaticMarkup(<FileTypeIcon name="公告.docx" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("background-image:url(");
    expect(html).not.toContain("https://");
  });

  it("同一个 Word 文件在用户消息和交付列表使用同一图标", () => {
    const attachment = {
      resourceId: "resource-doc",
      versionId: "version-doc",
      name: "公告.docx",
      mediaType: "application/octet-stream",
      sizeBytes: 36000,
    };
    const message = renderToStaticMarkup(
      <ThreadTranscript
        messages={[
          {
            sequence: 1,
            role: "user",
            text: "修改公告",
            attachments: [attachment],
            createdAt: "2026-09-08T00:00:00.000Z",
          },
        ]}
      />,
    );
    const delivery = renderToStaticMarkup(
      <InlineArtifactDelivery
        artifacts={[
          {
            id: "artifact-doc",
            name: attachment.name,
            mediaType: attachment.mediaType,
            status: "published",
            createdAt: "2026-09-08T00:00:00.000Z",
            updatedAt: "2026-09-08T00:00:00.000Z",
          },
        ]}
        onPreview={() => undefined}
        onDownload={() => undefined}
      />,
    );
    for (const html of [message, delivery]) {
      expect(html).toContain('data-file-icon="docx"');
      expect(html).toContain("公告.docx");
    }
    expect(delivery).toContain("下载 公告.docx");
    expect(delivery).toContain("预览 公告.docx");
  });
});

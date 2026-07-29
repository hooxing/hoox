import { describe, expect, it } from "vitest";
import { workspaceArtifactMediaType } from "./workspace-artifact-media.js";

describe("Workspace Artifact media type", () => {
  it("只为 .txt 交付物签发被动文本预览类型", () => {
    expect(workspaceArtifactMediaType("report.TXT")).toBe("text/plain; charset=utf-8");
  });

  it("HTML、SVG 与未知扩展名保持二进制，不能进入 inline preview", () => {
    for (const path of ["report.html", "image.svg", "payload", "note.md"]) {
      expect(workspaceArtifactMediaType(path)).toBe("application/octet-stream");
    }
  });
});

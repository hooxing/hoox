import { describe, expect, it } from "vitest";
import type {
  SkillPublicationMetadata,
  SkillPublicationUploadFile,
} from "./publishing-contracts.js";
import { validateSkillPublicationPackage } from "./publishing-package.js";

const metadata: SkillPublicationMetadata = Object.freeze({
  canonicalKey: "code-review",
  displayName: "代码审阅",
  publisher: "Cube",
  version: "1.2.3",
  description: "按照团队检查清单审阅代码变更",
  compatibility: "runtime >= 1",
  sourceUrl: "https://example.invalid/skills/code-review",
  sourceRevision: "commit-123",
  licenseSpdx: "Apache-2.0",
});

function file(path: string, body: string, mediaType = "text/plain"): SkillPublicationUploadFile {
  return { path, mediaType, contentBase64: Buffer.from(body).toString("base64") };
}

describe("管理员 Skill 发布包校验", () => {
  it("按规范路径排序并生成绑定元数据与文件摘要的确定性清单", () => {
    const first = validateSkillPublicationPackage({
      metadata,
      files: [file("references/checklist.md", "检查清单"), file("SKILL.md", "# Review\n")],
    });
    const second = validateSkillPublicationPackage({
      metadata: {
        licenseSpdx: metadata.licenseSpdx,
        sourceRevision: metadata.sourceRevision,
        sourceUrl: metadata.sourceUrl,
        compatibility: metadata.compatibility,
        description: metadata.description,
        version: metadata.version,
        publisher: metadata.publisher,
        displayName: metadata.displayName,
        canonicalKey: metadata.canonicalKey,
      },
      files: [file("SKILL.md", "# Review\n"), file("references/checklist.md", "检查清单")],
    });

    expect(first.files.map((item) => item.path)).toEqual(["SKILL.md", "references/checklist.md"]);
    expect(first.packageDigest).toBe(second.packageDigest);
    expect(first.entrypointMarkdown).toBe("# Review\n");
    expect(first.entrypointDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    [[file("../SKILL.md", "x")], "路径"],
    [[file("SKILL.md", "x"), file("skill.md", "y")], "大小写冲突"],
    [[file("SKILL.md", "x"), file("assets", "x"), file("assets/logo.svg", "x")], "前缀冲突"],
    [[file("SKILL.md", "x"), file("scripts/native.exe", "x")], "可执行文件"],
    [[file("SKILL.md", "-----BEGIN PRIVATE KEY-----")], "秘密值"],
  ])("拒绝不安全的文件集合 %#", (files, message) => {
    expect(() => validateSkillPublicationPackage({ metadata, files })).toThrow(message);
  });

  it("拒绝缺少入口和非规范 Base64，不对内容静默修复", () => {
    expect(() =>
      validateSkillPublicationPackage({ metadata, files: [file("README.md", "x")] }),
    ).toThrow("SKILL.md");
    expect(() =>
      validateSkillPublicationPackage({
        metadata,
        files: [{ path: "SKILL.md", mediaType: "text/markdown", contentBase64: "eA" }],
      }),
    ).toThrow("Base64");
  });

  it("拒绝带凭据的来源地址和控制字符元数据", () => {
    expect(() =>
      validateSkillPublicationPackage({
        metadata: { ...metadata, sourceUrl: "https://user:secret@example.invalid/repo" },
        files: [file("SKILL.md", "x")],
      }),
    ).toThrow("来源地址");
    expect(() =>
      validateSkillPublicationPackage({
        metadata: { ...metadata, description: "line1\nline2" },
        files: [file("SKILL.md", "x")],
      }),
    ).toThrow("描述");
  });

  it("允许本地上传不声明上游来源", () => {
    expect(
      validateSkillPublicationPackage({
        metadata: { ...metadata, sourceUrl: "", sourceRevision: "" },
        files: [file("SKILL.md", "# Review\n", "text/markdown")],
      }).metadata,
    ).toMatchObject({ sourceUrl: "", sourceRevision: "" });
  });

  it("接受带受控参数的标准媒体类型", () => {
    expect(
      validateSkillPublicationPackage({
        metadata,
        files: [file("SKILL.md", "# Review\n", "text/markdown; charset=utf-8")],
      }).files[0]?.mediaType,
    ).toBe("text/markdown; charset=utf-8");
  });
});

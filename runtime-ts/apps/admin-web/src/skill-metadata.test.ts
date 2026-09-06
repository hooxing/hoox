// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  extractSkillMetadataPrefill,
  prefillFromSkillMarkdown,
  SkillMetadataError,
} from "./skill-metadata.js";

function fileWithBody(markdown: string, path = "docx/SKILL.md"): File {
  const file = new File([markdown], "SKILL.md", { type: "text/markdown" });
  Object.defineProperty(file, "webkitRelativePath", { configurable: true, value: path });
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: async () => new TextEncoder().encode(markdown).buffer,
  });
  return file;
}

describe("SKILL.md 元数据预填", () => {
  it("解析标准 name、description 和 Proprietary 许可证声明", async () => {
    const markdown = `---
name: docx
description: "Use this skill whenever the user wants to manipulate Word documents."
license: Proprietary. LICENSE.txt has complete terms
---

# DOCX creation`;

    await expect(extractSkillMetadataPrefill([fileWithBody(markdown)])).resolves.toEqual({
      values: {
        canonicalKey: "docx",
        displayName: "docx",
        description: "Use this skill whenever the user wants to manipulate Word documents.",
        licenseSpdx: "LicenseRef-Proprietary",
      },
      recognizedLabels: ["规范键", "显示名称", "描述", "许可证"],
      licenseNotice:
        "检测到 Proprietary 声明，已映射为 LicenseRef-Proprietary；完整条款仍以包内 LICENSE 文件和 SKILL.md 为准。",
    });
  });

  it("支持扩展发布字段、折叠描述和安全来源 URL", () => {
    expect(
      prefillFromSkillMarkdown(`---
name: Code Review
display_name: 代码审阅
description: >-
  检查代码质量，
  并验证安全边界。
publisher: Cube
version: 2.1.0
compatibility: Hoox >= 1
source_url: https://example.com/code-review
source_revision: abc123
license: Apache-2.0
---`),
    ).toEqual({
      values: {
        canonicalKey: "code-review",
        displayName: "代码审阅",
        publisher: "Cube",
        description: "检查代码质量， 并验证安全边界。",
        sourceUrl: "https://example.com/code-review",
        sourceRevision: "abc123",
        licenseSpdx: "Apache-2.0",
      },
      recognizedLabels: [
        "规范键",
        "显示名称",
        "发布者",
        "描述",
        "上游仓库地址",
        "上游提交/版本",
        "许可证",
      ],
    });
  });

  it("缺少根级入口或 Front Matter 时给出稳定提示", async () => {
    await expect(
      extractSkillMetadataPrefill([fileWithBody("# Skill", "docx/references/guide.md")]),
    ).rejects.toEqual(new SkillMetadataError("尚未找到根级 SKILL.md，无法自动识别元数据。"));
    expect(() => prefillFromSkillMarkdown("# Skill")).toThrow(
      "SKILL.md 未包含可识别的 YAML Front Matter。",
    );
  });
});

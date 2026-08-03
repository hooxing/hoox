import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadDevelopmentPptxPackage } from "./development-pptx-publisher.js";

const vendorRoot = fileURLToPath(
  new URL("../../../vendor/anthropic-skills-pptx/", import.meta.url),
);

describe("development PPTX Skill 发布包", () => {
  it("固定上游提交、许可证、入口和完整文件清单，且不发布仓库来源说明", async () => {
    const skill = await loadDevelopmentPptxPackage(vendorRoot);

    expect(skill.upstreamCommit).toBe("b29e7cf65e5cb78a5ac33d582270551bc74a14eb");
    expect(skill.version).toBe(skill.upstreamCommit);
    expect(skill.files).toHaveLength(56);
    expect(skill.entrypoint.path).toBe("SKILL.md");
    expect(skill.entrypoint.mediaType).toBe("text/markdown; charset=utf-8");
    expect(skill.files.some((file) => file.path === "LICENSE.txt")).toBe(true);
    expect(skill.files.some((file) => file.path === "SOURCE.md")).toBe(false);
    expect(skill.files.some((file) => file.path === "scripts/add_slide.py")).toBe(true);
    expect(
      skill.files.some(
        (file) => file.path === "scripts/office/schemas/ISO-IEC29500-4_2016/pml.xsd",
      ),
    ).toBe(true);
    expect(skill.packageDigest).toBe(
      "8d95d791ec2800a1b6bb0cadeb20f3ae4ffb8b9a42f02552988d7d0efc976067",
    );
  });
});

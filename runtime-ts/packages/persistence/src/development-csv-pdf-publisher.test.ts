import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadDevelopmentCsvPdfPackage } from "./development-csv-pdf-publisher.js";

const sourceRoot = fileURLToPath(new URL("../../../managed-skills/csv-to-pdf/", import.meta.url));

describe("development CSV 转 PDF Skill 发布包", () => {
  it("固定 first-party 元数据、入口、转换脚本和完整文件清单", async () => {
    const skill = await loadDevelopmentCsvPdfPackage(sourceRoot);

    expect(skill.metadata).toEqual({
      canonicalKey: "csv-to-pdf",
      displayName: "CSV 转 PDF",
      publisher: "Cube Agent",
      version: "1.1.0",
      description: "将 UTF-8 CSV 或 TSV 表格转换为经过完整性校验的 PDF 并交付。",
      compatibility: "Cube Agent development；LibreOffice Calc 7.4.7；Debian snapshot 20260202",
      sourceUrl: "",
      sourceRevision: "internal-1.1.0",
      licenseSpdx: "LicenseRef-Cube-Internal",
    });
    expect(skill.files.map((file) => file.path)).toEqual([
      "LICENSE.txt",
      "SKILL.md",
      "scripts/csv_to_pdf.py",
    ]);
    expect(skill.entrypointMarkdown).toContain("只有脚本以 0");
    expect(skill.entrypointMarkdown).toContain("deliver_file");
    expect(skill.entrypointMarkdown).toContain("--resource-id");
    expect(skill.entrypointMarkdown).toContain("--version-id");
    expect(skill.entrypointMarkdown).not.toContain("--input");
    expect(skill.entrypointMarkdown).not.toContain("--output");
    expect(skill.entrypointMarkdown).not.toContain("<输入绝对路径>");
    const wrapper = skill.files.find((file) => file.path === "scripts/csv_to_pdf.py");
    const wrapperText = new TextDecoder().decode(wrapper?.body);
    expect(wrapperText).toContain("UserInstallation=");
    expect(wrapperText).toContain(
      'IMPORT_FILTER = "Text - txt - csv (StarCalc):44,34,76,1,,0,true,false"',
    );
    expect(wrapperText).toContain("quoting=csv.QUOTE_ALL");
    expect(wrapperText).toContain('RESOURCE_ROOT = Path("/resources")');
    expect(wrapperText).toContain('OUTPUT_ROOT = Path("/workspace/output")');
    expect(wrapperText).toContain('ID_PATTERN = re.compile(r"\\A[A-Za-z0-9]');
    expect(wrapperText).toContain('hashlib.sha256(f"{resource_id}\\0{version_id}"');
    expect(wrapperText).toContain("validate_pdf(output)");
    expect(skill.packageDigest).toBe(
      "4c14b62df37308eb6f8cdea5a4d37b0da2dc42bee9094ff3149ff1775ed7fad6",
    );
  });

  it("拒绝固定目录中的任意字节漂移", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "cube-csv-pdf-skill-"));
    try {
      await cp(sourceRoot, temporary, { recursive: true });
      const script = join(temporary, "scripts", "csv_to_pdf.py");
      await writeFile(script, `${await readFile(script, "utf8")}\n# drift\n`, "utf8");
      await expect(loadDevelopmentCsvPdfPackage(temporary)).rejects.toThrow(
        "CSV 转 PDF Skill 包摘要与固定版本不一致",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

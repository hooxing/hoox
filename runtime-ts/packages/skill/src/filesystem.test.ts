import { describe, expect, it } from "vitest";
import {
  assertSkillFilesystemEntry,
  assertSkillFilesystemFile,
  assertSkillFilesystemSegment,
  skillFilesystemPackageRoot,
} from "./filesystem.js";

describe("Skill 虚拟文件系统契约", () => {
  it("使用规范键和精确版本构造不可变包路径", () => {
    expect(skillFilesystemPackageRoot("code-review", "1.2.3")).toBe(
      "/resources/skills/code-review/1.2.3",
    );
    expect(() => skillFilesystemPackageRoot("../escape", "latest/latest")).toThrow(/包身份无效/u);
  });

  it("拒绝路径穿越、控制字符、超限文件和不完整来源", () => {
    expect(() => assertSkillFilesystemSegment("..")).toThrow(/路径段无效/u);
    expect(() => assertSkillFilesystemSegment("bad/name")).toThrow(/路径段无效/u);
    expect(() => assertSkillFilesystemSegment("bad\u202ename")).toThrow(/路径段无效/u);
    expect(() =>
      assertSkillFilesystemEntry({
        kind: "file",
        name: "large.bin",
        mediaType: "application/octet-stream",
        sizeBytes: 32 * 1024 * 1024 + 1,
        contentDigest: "a".repeat(64),
      }),
    ).toThrow(/元数据无效/u);
    expect(() =>
      assertSkillFilesystemFile({
        mediaType: "text/plain",
        sizeBytes: 2,
        contentDigest: "a".repeat(64),
        source: { kind: "inline", body: new Uint8Array([1]) },
      }),
    ).toThrow(/来源无效/u);
  });
});

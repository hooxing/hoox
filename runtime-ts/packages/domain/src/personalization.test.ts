import { describe, expect, it } from "vitest";
import {
  normalizePersonalizationContent,
  PERSONALIZATION_MAX_CHARACTERS,
  PERSONALIZATION_MAX_UTF8_BYTES,
} from "./personalization.js";

describe("个性化内容规范", () => {
  it("统一换行、外层空白与 NFC", () => {
    expect(normalizePersonalizationContent("  cafe\u0301\r\n默认中文  ")).toBe(
      "caf\u00e9\n默认中文",
    );
    expect(normalizePersonalizationContent(" \n ")).toBe("");
  });

  it("同时执行字符与 UTF-8 字节硬上限", () => {
    expect(
      normalizePersonalizationContent("a".repeat(PERSONALIZATION_MAX_CHARACTERS)),
    ).toHaveLength(PERSONALIZATION_MAX_CHARACTERS);
    expect(() =>
      normalizePersonalizationContent("a".repeat(PERSONALIZATION_MAX_CHARACTERS + 1)),
    ).toThrow(/字符上限/u);
    expect(() =>
      normalizePersonalizationContent(
        "界".repeat(Math.floor(PERSONALIZATION_MAX_UTF8_BYTES / 3) + 1),
      ),
    ).toThrow(/字符上限|UTF-8/u);
  });

  it.each(["\u200b", "\u202e", "\u0000", "\ufe00", "\ud800"])(
    "拒绝不可审计字符 %s",
    (character) => {
      expect(() => normalizePersonalizationContent(`之前${character}之后`)).toThrow(
        /控制、Bidi、零宽|Unicode/u,
      );
    },
  );

  it("保留常用 emoji 呈现选择符", () => {
    expect(normalizePersonalizationContent("默认使用中文 ✈️")).toBe("默认使用中文 ✈️");
  });
});

import { readFileReferences } from "@hoox/protocol/file-references";

/** 只投影模型可见文本，原始用户事实和界面引用保持不变；不从引用元数据构造文件权限。 */
export function projectFileReferencePrompt(input: string): string {
  const start = input.lastIndexOf("\n\n<hoox-file-references-v1>\n");
  const closing = "\n</hoox-file-references-v1>";
  const end = input.indexOf(closing, start);
  if (start < 0 || end < 0) return input;
  const parsed = readFileReferences(input.slice(0, end + closing.length));
  if (parsed.references.length === 0) return input;
  const tail = input.slice(end + closing.length);
  const section = /^\n\n# 用户在本轮(?:提供|上传)的文件\n((?:- [^\n]+(?:\n|$))+)/u.exec(tail);
  if (!section) return input;
  const paths: string[] = [];
  try {
    for (const line of (section[1] ?? "").trimEnd().split("\n")) {
      const fact: unknown = JSON.parse(line.slice(2));
      if (
        typeof fact !== "object" ||
        fact === null ||
        !("文件地址" in fact) ||
        typeof fact.文件地址 !== "string" ||
        !/^\/resources\/[^/]+\/[^/]+\/[^/]+$/u.test(fact.文件地址)
      )
        return input;
      if (!paths.includes(fact.文件地址)) paths.push(fact.文件地址);
    }
  } catch {
    return input;
  }
  const references: string[] = [];
  for (const [index, reference] of parsed.references.entries()) {
    const file = paths.findIndex((path) => path.split("/")[3] === reference.source.versionId);
    if (file < 0) return input;
    const s = reference.selection;
    const fact: Record<string, unknown> = { 文件: file + 1 };
    if ("page" in s && s.page !== undefined) fact.预览页码 = s.page;
    if (s.kind === "text") {
      fact.原文 = s.quote;
      if (s.prefix) fact.前文 = s.prefix;
      if (s.suffix) fact.后文 = s.suffix;
    } else if (s.kind === "cells") {
      fact.工作表 = s.sheet;
      fact.单元格范围 = s.range;
      fact.选区内容 = s.quote;
    } else if (s.kind === "region") {
      fact.归一化区域 = { 左: s.x, 上: s.y, 宽: s.width, 高: s.height };
      fact.预览尺寸 = { 宽: s.viewportWidth, 高: s.viewportHeight };
    } else fact.范围 = "整页";
    const snapshotReference = reference.snapshot;
    if (snapshotReference) {
      const snapshot = paths.findIndex(
        (path) =>
          path.split("/")[2] === snapshotReference.resourceId &&
          path.split("/")[3] === snapshotReference.versionId,
      );
      if (snapshot < 0) return input;
      fact.截图文件 = snapshot + 1;
    }
    references.push(`引用 ${index + 1}：${JSON.stringify(fact)}`);
  }
  return `${parsed.text}\n\n# 引用的文件\n${paths.map((path, index) => `文件 ${index + 1}：${JSON.stringify(path)}`).join("\n")}\n\n# 选中内容\n${references.join("\n")}${tail.slice(section[0].length) ? `\n${tail.slice(section[0].length)}` : ""}`;
}

import { expect, it } from "vitest";
import { appendFileReferences, type FileReference } from "@hoox/protocol/file-references";
import { projectFileReferencePrompt } from "./file-reference-prompt.js";
import { serializeRuntimeCompactionSource } from "./runtime-compaction.js";

const reference: FileReference = {
  source: {
    threadId: "thread_a",
    runId: "run_a",
    artifactId: "artifact_a",
    versionId: "version_a",
    name: "公告.docx",
    mediaType: "application/docx",
  },
  selection: {
    kind: "text",
    quote: "删除这里",
    start: 5,
    end: 9,
    prefix: "前面",
    suffix: "后面",
    page: 1,
  },
};
const path = "/resources/resource_a/version_a/公告.docx";
const input =
  appendFileReferences("把这一段去掉", [reference, reference]) +
  "\n\n# 用户在本轮提供的文件\n- " +
  JSON.stringify({ 文件名: "公告.docx", 文件地址: path });

it("模型只收到原话、去重路径与选区；历史中的内部引用保持原样", () => {
  const result = projectFileReferencePrompt(input);
  expect(result).toBe(
    '把这一段去掉\n\n# 引用的文件\n文件 1："/resources/resource_a/version_a/公告.docx"\n\n# 选中内容\n引用 1：{"文件":1,"预览页码":1,"原文":"删除这里","前文":"前面","后文":"后面"}\n引用 2：{"文件":1,"预览页码":1,"原文":"删除这里","前文":"前面","后文":"后面"}',
  );
  expect(result).not.toMatch(
    /threadId|runId|artifactId|versionId|mediaType|用户要求|hoox-file-references/,
  );
  expect(result.split("公告.docx")).toHaveLength(2);
  const history = [{ role: "user" as const, text: input, sequence: 1, timestamp: 0 }];
  const compacted = JSON.parse(
    serializeRuntimeCompactionSource({
      sourceFromSequence: 1,
      sourceThroughSequence: 1,
      retainedPrefix: history,
      prefix: history,
      retainedSuffix: [],
    }),
  );
  expect(compacted.messages[0]).toMatchObject({ text: result });
  expect(history[0]?.text).toBe(input);
  expect(projectFileReferencePrompt(result)).toBe(result);
});

it("框选仍提供截图文件关联和布局，表格保留行列；尾部记忆不丢失", () => {
  const refs: FileReference[] = [
    {
      ...reference,
      selection: {
        kind: "region",
        page: 2,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.4,
        viewportWidth: 900,
        viewportHeight: 1200,
      },
      snapshot: { resourceId: "snapshot", versionId: "snapshot_version" },
    },
    { ...reference, selection: { kind: "cells", sheet: "销售", range: "B3:F12", quote: "合计" } },
  ];
  const text =
    appendFileReferences("改一下", refs) +
    "\n\n# 用户在本轮提供的文件\n- " +
    JSON.stringify({ 文件地址: path }) +
    "\n- " +
    JSON.stringify({ 文件地址: "/resources/snapshot/snapshot_version/区域.png" }) +
    "\n\n记忆上下文";
  const result = projectFileReferencePrompt(text);
  expect(result).toContain('"截图文件":2');
  expect(result).toContain('"预览尺寸":{"宽":900,"高":1200}');
  expect(result).toContain('"单元格范围":"B3:F12"');
  expect(result).toContain("\n\n记忆上下文");
});

it("普通用户原话、无效引用和无法关联的文件保留原文，不猜测资源路径", () => {
  for (const text of [
    "用户原话",
    input.replace('"end":9', '"end":99'),
    input.replace(path, "/resources/other/other/公告.docx"),
  ])
    expect(projectFileReferencePrompt(text)).toBe(text);
});

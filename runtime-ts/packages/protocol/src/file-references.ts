import { Type, type Static } from "@sinclair/typebox";
import { IdSchema } from "./schemas.js";
import { Value } from "@sinclair/typebox/value";

export const MAX_FILE_PREVIEW_BYTES = 24 * 1024 * 1024;
export const MAX_FILE_REFERENCES = 8;
const strict = { additionalProperties: false } as const;
const page = Type.Integer({ minimum: 1, maximum: 100000 });
const unit = Type.Number({ minimum: 0, maximum: 1 });
export const FileSourceSchema = Type.Object(
  {
    threadId: IdSchema,
    runId: IdSchema,
    artifactId: IdSchema,
    versionId: IdSchema,
    name: Type.String({ minLength: 1, maxLength: 255 }),
    mediaType: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  },
  strict,
);
export const FileSelectionSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("text"),
      quote: Type.String({ minLength: 1, maxLength: 8000 }),
      start: Type.Integer({ minimum: 0 }),
      end: Type.Integer({ minimum: 1 }),
      page: Type.Optional(page),
      prefix: Type.Optional(Type.String({ maxLength: 100 })),
      suffix: Type.Optional(Type.String({ maxLength: 100 })),
      lineStart: Type.Optional(page),
      lineEnd: Type.Optional(page),
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("region"),
      page,
      x: unit,
      y: unit,
      width: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
      height: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
      viewportWidth: Type.Number({ exclusiveMinimum: 0, maximum: 20000 }),
      viewportHeight: Type.Number({ exclusiveMinimum: 0, maximum: 20000 }),
    },
    strict,
  ),
  Type.Object({ kind: Type.Literal("page"), page }, strict),
  Type.Object(
    {
      kind: Type.Literal("cells"),
      sheet: Type.String({ minLength: 1, maxLength: 255 }),
      range: Type.String({
        pattern: "^[A-Z]{1,3}[1-9][0-9]{0,6}(:[A-Z]{1,3}[1-9][0-9]{0,6})?$",
        maxLength: 30,
      }),
      quote: Type.String({ maxLength: 8000 }),
    },
    strict,
  ),
]);
export const FileReferenceSchema = Type.Object(
  {
    source: FileSourceSchema,
    selection: FileSelectionSchema,
    snapshot: Type.Optional(Type.Object({ resourceId: IdSchema, versionId: IdSchema }, strict)),
  },
  strict,
);
export type FileSource = Static<typeof FileSourceSchema>;
export type FileSelection = Static<typeof FileSelectionSchema>;
export type FileReference = Static<typeof FileReferenceSchema>;

export type FilePreviewKind =
  | "image"
  | "pdf"
  | "text"
  | "markdown"
  | "code"
  | "table"
  | "docx"
  | "pptx";
export function filePreviewKind(name: string, mediaType = ""): FilePreviewKind | undefined {
  const media = mediaType.split(";")[0]?.trim().toLowerCase();
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(media ?? "")) return "image";
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "docx") return "docx";
  if (ext === "pptx") return "pptx";
  if (["xlsx", "csv", "tsv"].includes(ext ?? "")) return "table";
  if (ext === "pdf" || mediaType.split(";")[0] === "application/pdf") return "pdf";
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext ?? "")) return "image";
  if (["md", "markdown"].includes(ext ?? "")) return "markdown";
  if (
    [
      "ts",
      "tsx",
      "js",
      "jsx",
      "json",
      "yaml",
      "yml",
      "py",
      "css",
      "sql",
      "sh",
      "xml",
      "java",
      "go",
      "rs",
      "c",
      "cpp",
      "toml",
    ].includes(ext ?? "")
  )
    return "code";
  if (
    ["txt", "log"].includes(ext ?? "") ||
    media === "text/plain" ||
    ["README", "LICENSE"].includes(name.toUpperCase())
  )
    return "text";
  return undefined;
}

export function validFileSelection(selection: FileSelection): boolean {
  if (selection.kind === "cells") return parseCellRange(selection.range) !== undefined;
  if (selection.kind === "region")
    return selection.x + selection.width <= 1.000001 && selection.y + selection.height <= 1.000001;
  if (selection.kind === "text")
    return (
      selection.end > selection.start &&
      selection.end - selection.start === selection.quote.length &&
      (selection.lineEnd ?? 1) >= (selection.lineStart ?? 1)
    );
  return true;
}

export function columnName(index: number): string {
  let result = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
}
export function parseCellRange(
  value: string,
): { startRow: number; endRow: number; startCol: number; endCol: number } | undefined {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})(?::([A-Z]{1,3})([1-9][0-9]{0,6}))?$/u.exec(
    value.trim().toUpperCase(),
  );
  if (!match) return undefined;
  const column = (name: string) =>
    [...name].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const startRow = Number(match[2]) - 1,
    endRow = Number(match[4] ?? match[2]) - 1;
  const startCol = column(match[1] ?? "A"),
    endCol = column(match[3] ?? match[1] ?? "A");
  if (endRow < startRow || endCol < startCol || endRow >= 1048576 || endCol >= 16384)
    return undefined;
  return { startRow, endRow, startCol, endCol };
}

export function fileSelectionLabel(selection: FileSelection): string {
  switch (selection.kind) {
    case "page":
      return `第 ${selection.page} 页`;
    case "region":
      return `第 ${selection.page} 页 · 框选区域`;
    case "cells":
      return `${selection.sheet}!${selection.range}`;
    case "text":
      return selection.lineStart !== undefined
        ? `第 ${selection.lineStart}–${selection.lineEnd ?? selection.lineStart} 行`
        : selection.page !== undefined
          ? `第 ${selection.page} 页 · 文字`
          : "文字选区";
  }
}

const marker = "\n\n<hoox-file-references-v1>\n";
const endMarker = "\n</hoox-file-references-v1>";
/** 版本化引用事实保存在最新用户消息中；只承载用户选区数据，不改变系统提示词。 */
export function appendFileReferences(input: string, references: readonly FileReference[]): string {
  return references.length === 0
    ? input
    : `${input}${marker}${JSON.stringify(references)}${endMarker}`;
}
export function splitFileReferences(input: string): { text: string; candidates: unknown } {
  const start = input.lastIndexOf(marker);
  if (start < 0 || !input.endsWith(endMarker)) return { text: input, candidates: [] };
  try {
    return {
      text: input.slice(0, start),
      candidates: JSON.parse(input.slice(start + marker.length, -endMarker.length)),
    };
  } catch {
    return { text: input, candidates: [] };
  }
}
export function readFileReferences(input: string): { text: string; references: FileReference[] } {
  const parsed = splitFileReferences(input);
  if (
    !Value.Check(
      Type.Array(FileReferenceSchema, { maxItems: MAX_FILE_REFERENCES }),
      parsed.candidates,
    ) ||
    !parsed.candidates.every(validReference)
  )
    return { text: input, references: [] };
  return { text: parsed.text, references: parsed.candidates };
}
function validReference(reference: FileReference): boolean {
  return validFileSelection(reference.selection);
}

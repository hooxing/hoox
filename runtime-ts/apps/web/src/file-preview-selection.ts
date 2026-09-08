import type { FileSelection } from "@hoox/protocol/file-references";

export function textSelection(
  root: HTMLElement,
  selection: Selection | null,
  page?: number,
  lines = false,
): FileSelection | undefined {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return undefined;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return undefined;
  const before = range.cloneRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  const quote = range.toString();
  if (!quote.trim() || quote.length > 8000) return undefined;
  const text = root.textContent ?? "";
  return {
    kind: "text",
    quote,
    start,
    end: start + quote.length,
    prefix: text.slice(Math.max(0, start - 80), start),
    suffix: text.slice(start + quote.length, start + quote.length + 80),
    ...(page === undefined ? {} : { page }),
    ...(lines
      ? {
          lineStart: before.toString().split("\n").length,
          lineEnd: (before.toString() + quote).split("\n").length,
        }
      : {}),
  };
}

export function regionSelection(
  start: { x: number; y: number },
  end: { x: number; y: number },
  page: number,
  width: number,
  height: number,
): Extract<FileSelection, { kind: "region" }> | undefined {
  const x = Math.max(0, Math.min(1, Math.min(start.x, end.x)));
  const y = Math.max(0, Math.min(1, Math.min(start.y, end.y)));
  const right = Math.max(0, Math.min(1, Math.max(start.x, end.x)));
  const bottom = Math.max(0, Math.min(1, Math.max(start.y, end.y)));
  if ((right - x) * width < 5 || (bottom - y) * height < 5) return undefined;
  return {
    kind: "region",
    page,
    x,
    y,
    width: right - x,
    height: bottom - y,
    viewportWidth: width,
    viewportHeight: height,
  };
}

export { columnName, parseCellRange } from "@hoox/protocol/file-references";

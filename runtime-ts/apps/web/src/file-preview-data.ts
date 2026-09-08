export type PreviewCell = { text: string; bold?: boolean; background?: string; color?: string };
export type PreviewSheet = {
  name: string;
  rows: PreviewCell[][];
  merges: { top: number; left: number; bottom: number; right: number }[];
};
export const MAX_PREVIEW_CELLS = 100000;

export function parseDelimited(text: string, delimiter: string): PreviewSheet {
  const rows: PreviewCell[][] = [];
  let row: PreviewCell[] = [];
  let value = "";
  let quoted = false;
  let count = 0;
  const cell = () => {
    if (++count > MAX_PREVIEW_CELLS) throw new Error("表格超过 10 万个单元格，请拆分文件后预览。");
    row.push({ text: value });
    value = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (quoted || value.length === 0) quoted = !quoted;
      else value += ch;
    } else if (!quoted && ch === delimiter) cell();
    else if (!quoted && (ch === "\n" || ch === "\r")) {
      cell();
      rows.push(row);
      row = [];
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else value += ch;
  }
  if (quoted) throw new Error("表格包含未闭合的引号，无法可靠解析。");
  if (value.length > 0 || row.length > 0) {
    cell();
    rows.push(row);
  }
  return { name: "数据", rows, merges: [] };
}

/** 解压前检查 ZIP 中央目录预算；拒绝加密和 ZIP64，避免在浏览器中无界展开 Office 文件。 */
export function checkOfficeArchive(bytes: ArrayBuffer): void {
  const view = new DataView(bytes);
  let end = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("Office 文件损坏或已加密，无法预览。");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  let total = 0;
  if (count > 5000 || count === 65535) throw new Error("Office 文件包含过多内容，请拆分后预览。");
  for (let i = 0; i < count; i++) {
    if (
      offset + 46 > end ||
      view.getUint32(offset, true) !== 0x02014b50 ||
      (view.getUint16(offset + 8, true) & 1) !== 0
    )
      throw new Error("Office 文件结构不受支持。");
    total += view.getUint32(offset + 24, true);
    if (total > 96 * 1024 * 1024) throw new Error("Office 文件解压后过大，请拆分后预览。");
    offset +=
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
}

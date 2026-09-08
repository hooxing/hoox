import {
  checkOfficeArchive,
  MAX_PREVIEW_CELLS,
  parseDelimited,
  type PreviewCell,
  type PreviewSheet,
} from "./file-preview-data.js";

const worker = globalThis as unknown as {
  onmessage: (event: MessageEvent<{ data: ArrayBuffer; name: string }>) => void;
  postMessage: (message: unknown) => void;
};
worker.onmessage = (event) => {
  void parse(event.data)
    .then((sheets) => worker.postMessage({ sheets }))
    .catch((error: unknown) =>
      worker.postMessage({ error: error instanceof Error ? error.message : "无法解析表格。" }),
    );
};
async function parse({ data, name }: { data: ArrayBuffer; name: string }): Promise<PreviewSheet[]> {
  if (!name.toLowerCase().endsWith(".xlsx"))
    return [
      parseDelimited(
        new TextDecoder("utf-8", { fatal: true }).decode(data),
        name.toLowerCase().endsWith(".tsv") ? "\t" : ",",
      ),
    ];
  checkOfficeArchive(data);
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data);
  let count = 0;
  return workbook.worksheets
    .filter((sheet) => sheet.state === "visible")
    .map((sheet) => {
      count += sheet.rowCount * sheet.columnCount;
      if (count > MAX_PREVIEW_CELLS || sheet.columnCount > 16384)
        throw new Error("表格超过 10 万个单元格，请拆分文件后预览。");
      const rows: PreviewCell[][] = [];
      for (let r = 1; r <= sheet.rowCount; r++) {
        const row: PreviewCell[] = [];
        for (let c = 1; c <= sheet.columnCount; c++) {
          const cell = sheet.getCell(r, c);
          const fill = cell.fill;
          const color = cell.font?.color?.argb;
          const background = fill?.type === "pattern" ? fill.fgColor?.argb : undefined;
          row.push({
            text:
              cell.type === ExcelJS.ValueType.Formula && cell.result === undefined
                ? "[公式未保存计算结果]"
                : cell.text,
            ...(cell.font?.bold ? { bold: true } : {}),
            ...(color && /^[A-Fa-f0-9]{8}$/u.test(color) ? { color: `#${color.slice(2)}` } : {}),
            ...(background && /^[A-Fa-f0-9]{8}$/u.test(background)
              ? { background: `#${background.slice(2)}` }
              : {}),
          });
        }
        rows.push(row);
      }
      const merges = (sheet.model.merges ?? []).map((range) => {
        const cells = range.split(":");
        const first = sheet.getCell(cells[0] ?? "A1");
        const last = sheet.getCell(cells[1] ?? cells[0] ?? "A1");
        return {
          top: Number(first.row) - 1,
          left: Number(first.col) - 1,
          bottom: Number(last.row) - 1,
          right: Number(last.col) - 1,
        };
      });
      return { name: sheet.name, rows, merges };
    });
}

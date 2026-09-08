import { useEffect, useState } from "react";
import type { FileSelection } from "@hoox/protocol/file-references";
import type { PreviewSheet } from "./file-preview-data.js";
import { columnName, parseCellRange } from "./file-preview-selection.js";

export function FilePreviewTable({
  data,
  name,
  initialSelection,
  onSelection,
}: {
  data: ArrayBuffer;
  name: string;
  initialSelection?: FileSelection;
  onSelection: (selection: FileSelection | undefined) => void;
}) {
  const [sheets, setSheets] = useState<PreviewSheet[]>();
  const [sheetIndex, setSheetIndex] = useState(0);
  const [rowOffset, setRowOffset] = useState(0);
  const [colOffset, setColOffset] = useState(0);
  const [range, setRange] = useState(
    initialSelection?.kind === "cells" ? initialSelection.range : "",
  );
  const [anchor, setAnchor] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => {
    const worker = new Worker(new URL("./file-preview-table.worker.ts", import.meta.url), {
      type: "module",
    });
    const timer = window.setTimeout(() => {
      worker.terminate();
      setError("表格解析超时，请拆分文件后重试。");
    }, 20000);
    worker.onmessage = (event: MessageEvent<{ sheets?: PreviewSheet[]; error?: string }>) => {
      clearTimeout(timer);
      if (event.data.error) setError(event.data.error);
      else {
        setSheets(event.data.sheets ?? []);
        if (initialSelection?.kind === "cells") {
          setSheetIndex(
            Math.max(
              0,
              event.data.sheets?.findIndex((sheet) => sheet.name === initialSelection.sheet) ?? 0,
            ),
          );
          const area = parseCellRange(initialSelection.range);
          if (area) {
            setRowOffset(Math.floor(area.startRow / 100) * 100);
            setColOffset(Math.floor(area.startCol / 20) * 20);
          }
        }
      }
      worker.terminate();
    };
    worker.onerror = () => {
      clearTimeout(timer);
      setError("表格解析失败，请重新打开。");
      worker.terminate();
    };
    const copy = data.slice(0);
    worker.postMessage({ data: copy, name }, [copy]);
    return () => {
      clearTimeout(timer);
      worker.terminate();
    };
  }, [data, name, initialSelection]);
  const sheet = sheets?.[sheetIndex];
  const area = parseCellRange(range);
  const columns = sheet?.rows.reduce((max, row) => Math.max(max, row.length), 0) ?? 0;
  const selectRange = (value: string) => {
    setRange(value);
    const selected = parseCellRange(value);
    if (!selected || !sheet || selected.endRow >= sheet.rows.length || selected.endCol >= columns) {
      onSelection(undefined);
      setError("请输入当前工作表中的有效范围，例如 B3:F12。");
      return;
    }
    const quote = sheet.rows
      .slice(selected.startRow, selected.endRow + 1)
      .map((row) =>
        row
          .slice(selected.startCol, selected.endCol + 1)
          .map((cell) => cell.text)
          .join("\t"),
      )
      .join("\n");
    if (quote.length > 8000) {
      onSelection(undefined);
      setError("选区内容超过 8000 字，请缩小范围。");
      return;
    }
    setError("");
    onSelection({ kind: "cells", sheet: sheet.name, range: value.toUpperCase(), quote });
  };
  return (
    <div className="file-table-view">
      <p className="preview-notice">
        展示已保存的数据和基础样式；公式不重算，图表与复杂格式请以原文件为准。
      </p>
      {sheets === undefined && !error && <p role="status">正在浏览器中解析表格…</p>}
      {error && <p role="alert">{error}</p>}
      {sheet && (
        <>
          <div className="file-preview-toolbar">
            <label>
              工作表{" "}
              <select
                aria-label="工作表"
                value={sheetIndex}
                onChange={(event) => {
                  setSheetIndex(Number(event.target.value));
                  setRowOffset(0);
                  setColOffset(0);
                  setRange("");
                  setAnchor(undefined);
                  onSelection(undefined);
                }}
              >
                {sheets?.map((item, index) => (
                  <option key={item.name} value={index}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              范围{" "}
              <input
                aria-label="单元格范围"
                placeholder="B3:F12"
                value={range}
                onChange={(event) => {
                  setRange(event.target.value);
                  onSelection(undefined);
                }}
              />
            </label>
            <button
              type="button"
              onClick={() => {
                selectRange(range);
                if (area) {
                  setRowOffset(Math.floor(area.startRow / 100) * 100);
                  setColOffset(Math.floor(area.startCol / 20) * 20);
                }
              }}
            >
              选择范围
            </button>
          </div>
          <p className="preview-notice">点击起点，再点击终点选择范围；也可直接输入坐标。</p>
          <div className="file-table-scroll">
            <table aria-label={sheet.name}>
              <thead>
                <tr>
                  <th scope="col">行</th>
                  {Array.from(
                    { length: Math.min(20, Math.max(0, columns - colOffset)) },
                    (_, i) => (
                      <th scope="col" key={columnName(i + colOffset)}>
                        {columnName(i + colOffset)}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {sheet.rows.slice(rowOffset, rowOffset + 100).map((row, index) => {
                  const r = index + rowOffset;
                  return (
                    <tr key={r}>
                      <th scope="row">{r + 1}</th>
                      {Array.from(
                        { length: Math.min(20, Math.max(0, columns - colOffset)) },
                        (_, i) => {
                          const c = i + colOffset;
                          const merged = sheet.merges.find(
                            (item) =>
                              r >= item.top &&
                              r <= item.bottom &&
                              c >= item.left &&
                              c <= item.right,
                          );
                          if (
                            merged &&
                            (r !== Math.max(rowOffset, merged.top) ||
                              c !== Math.max(colOffset, merged.left))
                          )
                            return null;
                          const cell = merged ? sheet.rows[merged.top]?.[merged.left] : row[c];
                          const address = `${columnName(c)}${r + 1}`;
                          const selected =
                            area &&
                            r >= area.startRow &&
                            r <= area.endRow &&
                            c >= area.startCol &&
                            c <= area.endCol;
                          return (
                            <td
                              key={c}
                              rowSpan={merged ? Math.min(rowOffset + 99, merged.bottom) - r + 1 : 1}
                              colSpan={merged ? Math.min(colOffset + 19, merged.right) - c + 1 : 1}
                              style={{
                                background: cell?.background,
                                color: cell?.color,
                                fontWeight: cell?.bold ? 700 : undefined,
                              }}
                            >
                              <button
                                type="button"
                                aria-label={address}
                                aria-pressed={!!selected}
                                className={selected ? "is-selected" : ""}
                                onClick={() => {
                                  if (!anchor) {
                                    setAnchor(address);
                                    selectRange(address);
                                  } else {
                                    const start = parseCellRange(anchor);
                                    if (start)
                                      selectRange(
                                        `${columnName(Math.min(start.startCol, c))}${Math.min(start.startRow, r) + 1}:${columnName(Math.max(start.startCol, c))}${Math.max(start.startRow, r) + 1}`,
                                      );
                                    setAnchor(undefined);
                                  }
                                }}
                              >
                                {cell?.text || "\u00a0"}
                              </button>
                            </td>
                          );
                        },
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="file-preview-toolbar">
            <button
              type="button"
              disabled={rowOffset === 0}
              onClick={() => setRowOffset((n) => Math.max(0, n - 100))}
            >
              上一组行
            </button>
            <span>
              {rowOffset + 1}–{Math.min(rowOffset + 100, sheet.rows.length)} / {sheet.rows.length}{" "}
              行
            </span>
            <button
              type="button"
              disabled={rowOffset + 100 >= sheet.rows.length}
              onClick={() => setRowOffset((n) => n + 100)}
            >
              下一组行
            </button>
            <button
              type="button"
              disabled={colOffset === 0}
              onClick={() => setColOffset((n) => Math.max(0, n - 20))}
            >
              左侧列
            </button>
            <button
              type="button"
              disabled={colOffset + 20 >= columns}
              onClick={() => setColOffset((n) => n + 20)}
            >
              右侧列
            </button>
          </div>
        </>
      )}
    </div>
  );
}

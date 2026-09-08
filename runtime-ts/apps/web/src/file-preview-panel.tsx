import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  filePreviewKind,
  fileSelectionLabel,
  type FileSource,
  type FileSelection,
} from "@hoox/protocol/file-references";
import type { DraftFileReference } from "./file-reference-view.js";
import { previewFrameHtml, renderPreview, type PreviewRenderer } from "./file-preview-renderer.js";
import { regionSelection, textSelection } from "./file-preview-selection.js";
import { FilePreviewTable } from "./file-preview-table.js";

export type PreviewTarget = { source: FileSource; selection?: FileSelection };
export function FilePreviewPanel({
  target,
  readContent,
  onClose,
  onReference,
  onDownload,
  disabled,
  reply,
}: {
  reply?: ReactNode;
  target: PreviewTarget;
  readContent: (source: FileSource, signal: AbortSignal) => Promise<ArrayBuffer>;
  onClose: () => void;
  onReference: (reference: DraftFileReference) => void;
  onDownload: () => void;
  disabled: boolean;
}) {
  const kind = filePreviewKind(target.source.name, target.source.mediaType);
  const mounted = useRef(true);
  const [data, setData] = useState<ArrayBuffer>();
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState(
    target.selection && "page" in target.selection ? (target.selection.page ?? 1) : 1,
  );
  const [pages, setPages] = useState(1);
  const [selection, setSelection] = useState<FileSelection | undefined>(target.selection);
  const [mode, setMode] = useState<"read" | "region">("read");
  const [zoom, setZoom] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const [frameReady, setFrameReady] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const panel = useRef<HTMLElement>(null);
  const renderer = useRef<PreviewRenderer | undefined>(undefined);
  const live = useRef({ mode, page, kind, selection });
  live.current = { mode, page, kind, selection };
  const [search, setSearch] = useState("");
  const [panelWidth, setPanelWidth] = useState(0);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    panel.current?.focus();
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    document.addEventListener("keydown", handleEscape);
    const media = window.matchMedia("(max-width: 1199px)");
    const siblings = [...(panel.current?.parentElement?.children ?? [])].filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element !== panel.current,
    );
    const previousInert = siblings.map((element) => element.inert);
    const updateInert = () =>
      siblings.forEach((element, index) => {
        element.inert = media.matches || (previousInert[index] ?? false);
      });
    updateInert();
    media.addEventListener("change", updateInert);
    return () => {
      mounted.current = false;
      media.removeEventListener("change", updateInert);
      siblings.forEach((element, index) => {
        element.inert = previousInert[index] ?? false;
      });
      document.removeEventListener("keydown", handleEscape);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    void retry;
    const abort = new AbortController();
    setData(undefined);
    setError("");
    setReady(false);
    void readContent(target.source, abort.signal)
      .then((bytes) => {
        if (!abort.signal.aborted) setData(bytes);
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted)
          setError(reason instanceof Error ? reason.message : "预览失败。");
      });
    return () => abort.abort();
  }, [target.source, readContent, retry]);

  const fit = useCallback(() => {
    const doc = frame.current?.contentDocument;
    const root = doc?.getElementById("page");
    const element = renderer.current?.pageElement();
    if (!root || !element) return;
    root.style.zoom = "1";
    const width = Math.max(element.scrollWidth, element.offsetWidth);
    root.style.zoom = String(
      zoom === 0
        ? Math.min(1, Math.max(100, (frame.current?.clientWidth ?? 800) - 32) / Math.max(1, width))
        : zoom / 100,
    );
  }, [zoom]);
  useEffect(() => {
    if (!ready) return;
    fit();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
    if (frame.current) observer?.observe(frame.current);
    return () => observer?.disconnect();
  }, [fit, ready]);

  useEffect(() => {
    if (
      !data ||
      kind === undefined ||
      kind === "table" ||
      !frameReady ||
      !frame.current?.contentDocument
    )
      return;
    const doc = frame.current.contentDocument;
    const abort = new AbortController();
    let instance: PreviewRenderer | undefined;
    setReady(false);
    void renderPreview(data, kind, doc, abort.signal)
      .then(async (created) => {
        instance = created;
        if (abort.signal.aborted) {
          created.dispose();
          return;
        }
        renderer.current = created;
        setPages(created.pageCount);
        const selectedPage =
          target.selection && "page" in target.selection ? (target.selection.page ?? 1) : 1;
        if (selectedPage > created.pageCount) throw new Error("引用页码超出文件范围。");
        await created.showPage(selectedPage);
        setPage(selectedPage);
        setReady(true);
        const element = created.pageElement();
        element.style.position = "relative";
        if (target.selection?.kind === "text") restoreTextSelection(element, target.selection);
        if (target.selection?.kind === "region") drawRegion(element, target.selection);
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted)
          setError(reason instanceof Error ? reason.message : "文件无法预览。");
      });
    let start: { x: number; y: number } | undefined;
    let dragged: FileSelection | undefined;
    const point = (event: PointerEvent, element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
      };
    };
    const down = (event: PointerEvent) => {
      if (live.current.mode !== "region" || event.button !== 0) return;
      const element = renderer.current?.pageElement();
      if (!element || event.target === null || !element.contains(event.target as Node)) return;
      event.preventDefault();
      // Office 渲染器创建的节点可能来自父文档，不能通过 iframe 的 instanceof 判断身份。
      const corner = (event.target as HTMLElement).getAttribute?.("data-corner");
      const existing = live.current.selection;
      start =
        corner && existing?.kind === "region"
          ? {
              x: corner.includes("left") ? existing.x + existing.width : existing.x,
              y: corner.includes("top") ? existing.y + existing.height : existing.y,
            }
          : point(event, element);
      element.setPointerCapture(event.pointerId);
      dragged = undefined;
      setSelection(undefined);
    };
    const move = (event: PointerEvent) => {
      const element = renderer.current?.pageElement();
      if (!start || !element) return;
      const region = regionSelection(
        start,
        point(event, element),
        live.current.page,
        element.offsetWidth,
        element.offsetHeight,
      );
      if (region) {
        drawRegion(element, region);
        dragged = region;
      }
    };
    const up = (event: PointerEvent) => {
      move(event);
      start = undefined;
      if (dragged) setSelection(dragged);
    };
    const cancel = () => {
      start = undefined;
      setSelection(undefined);
      doc.getElementById("selection-box")?.remove();
    };
    const select = () => {
      if (live.current.mode !== "read") return;
      const element = renderer.current?.pageElement();
      if (!element) return;
      const result = textSelection(
        element,
        doc.getSelection(),
        ["docx", "pdf", "pptx"].includes(live.current.kind ?? "") ? live.current.page : undefined,
        live.current.kind === "code" || live.current.kind === "text",
      );
      if (result) setSelection(result);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    const preventNavigation = (event: Event) => {
      if ((event.target as Element).closest?.("a,form")) event.preventDefault();
    };
    doc.addEventListener("click", preventNavigation);
    doc.addEventListener("pointerdown", down);
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", up);
    doc.addEventListener("pointercancel", cancel);
    doc.addEventListener("selectionchange", select);
    doc.addEventListener("keydown", handleEscape);
    return () => {
      abort.abort();
      instance?.dispose();
      renderer.current = undefined;
      doc.removeEventListener("pointerdown", down);
      doc.removeEventListener("pointermove", move);
      doc.removeEventListener("pointerup", up);
      doc.removeEventListener("pointercancel", cancel);
      doc.removeEventListener("selectionchange", select);
      doc.removeEventListener("keydown", handleEscape);
      doc.removeEventListener("click", preventNavigation);
    };
  }, [data, kind, frameReady, target.selection]);

  useEffect(() => {
    if (!ready || page < 1) return;
    const element = renderer.current?.pageElement();
    if (element) {
      element.style.touchAction = mode === "region" ? "none" : "auto";
      element.style.userSelect = mode === "region" ? "none" : "text";
    }
  }, [mode, ready, page]);
  const changePage = async (next: number) => {
    if (busy || next < 1 || next > pages) return;
    setBusy(true);
    setSelection(undefined);
    try {
      await renderer.current?.showPage(next);
      setPage(next);
      renderer.current?.pageElement().style.setProperty("position", "relative");
      fit();
    } catch {
      setError("页面加载失败，请重新打开。");
    } finally {
      setBusy(false);
    }
  };
  const addReference = async () => {
    if (!selection || busy) return;
    setBusy(true);
    setError("");
    try {
      const snapshotDataUrl =
        selection.kind === "region" || (selection.kind === "page" && kind !== "table")
          ? await captureSelection(renderer.current?.pageElement(), selection)
          : undefined;
      if (!mounted.current) return;
      onReference({
        id: crypto.randomUUID(),
        reference: { source: target.source, selection },
        ...(snapshotDataUrl === undefined ? {} : { snapshotDataUrl }),
      });
      setNotice("已加入对话草稿，可继续选择其他位置。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法生成区域截图，请重试。");
    } finally {
      setBusy(false);
    }
  };
  const resizePanel = (width: number) => {
    const parent = panel.current?.parentElement;
    if (!parent) return;
    const bounded = Math.max(480, Math.min(parent.clientWidth - 580, width));
    parent.style.setProperty("--file-preview-width", `${bounded}px`);
    setPanelWidth(bounded);
  };
  return (
    <section
      className="file-preview-panel"
      aria-label={`预览 ${target.source.name}`}
      tabIndex={-1}
      ref={panel}
    >
      <hr
        className="file-preview-resizer"
        aria-label="调整预览宽度"
        aria-orientation="vertical"
        aria-valuemin={480}
        aria-valuenow={Math.round(panelWidth || panel.current?.clientWidth || 480)}
        tabIndex={0}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1 && event.currentTarget.hasPointerCapture(event.pointerId))
            resizePanel(
              (panel.current?.parentElement?.getBoundingClientRect().right ?? 0) - event.clientX,
            );
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            resizePanel(
              (panel.current?.clientWidth ?? 600) + (event.key === "ArrowLeft" ? 32 : -32),
            );
          }
        }}
      />
      <header>
        <div>
          <strong>{target.source.name}</strong>
          <small>引用固定版本 · {target.source.versionId.slice(-8)}</small>
        </div>
        <button type="button" onClick={onDownload}>
          下载
        </button>
        <button type="button" aria-label="关闭文件预览" onClick={onClose}>
          返回对话
        </button>
      </header>
      <div className="file-preview-toolbar">
        <button type="button" aria-pressed={mode === "read"} onClick={() => setMode("read")}>
          阅读 / 选文字
        </button>
        {kind !== "table" && (
          <>
            <button
              type="button"
              disabled={!ready}
              aria-pressed={mode === "region"}
              onClick={() => setMode("region")}
            >
              框选区域
            </button>
            <label>
              缩放{" "}
              <select
                aria-label="预览缩放"
                value={zoom}
                onChange={(event) => setZoom(Number(event.target.value))}
              >
                <option value={0}>适应宽度</option>
                {[75, 100, 125, 150, 200].map((value) => (
                  <option key={value} value={value}>
                    {value}%
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      {kind !== "table" && kind !== "image" && (
        <div className="file-preview-toolbar">
          <input
            aria-label="查找当前页文字"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="查找当前页文字"
          />
          <button
            type="button"
            disabled={!ready || !search.trim()}
            onClick={() => {
              const element = renderer.current?.pageElement();
              const index = element?.textContent?.indexOf(search) ?? -1;
              if (!element || index < 0) {
                setNotice("当前页没有找到该文字。");
                return;
              }
              const found: FileSelection = {
                kind: "text",
                start: index,
                end: index + search.length,
                quote: search,
                ...(pages > 1 ? { page } : {}),
              };
              setMode("read");
              restoreTextSelection(element, found);
              setSelection(found);
              setNotice("已定位文字，可引用到对话。");
            }}
          >
            查找
          </button>
        </div>
      )}
      {(kind === "docx" || kind === "pptx") && (
        <p className="preview-notice">
          浏览器预览可能与原文件排版不同；不播放动画，缺失字体可能被替代。DOCX 页码为预览页码。
        </p>
      )}
      {mode === "region" && (
        <p className="preview-notice">拖动框选区域；可重新拖动，或用下方位置与尺寸调整。</p>
      )}
      {error && (
        <div role="alert" className="preview-error">
          {error}
          <button
            type="button"
            onClick={() => {
              setFrameReady(false);
              setRetry((n) => n + 1);
            }}
          >
            重试
          </button>
        </div>
      )}
      {!data && !error && <p role="status">正在读取文件…</p>}
      {kind === "table" && data ? (
        <FilePreviewTable
          data={data}
          name={target.source.name}
          {...(target.selection === undefined ? {} : { initialSelection: target.selection })}
          onSelection={setSelection}
        />
      ) : (
        <iframe
          key={retry}
          title={`${target.source.name} 内容`}
          ref={frame}
          sandbox="allow-same-origin"
          srcDoc={previewFrameHtml}
          onLoad={() => setFrameReady(true)}
        />
      )}
      {data && !ready && kind !== "table" && !error && <p role="status">正在浏览器中生成预览…</p>}
      {pages > 1 && (
        <div className="file-preview-toolbar">
          <button
            type="button"
            disabled={busy || page <= 1}
            onClick={() => void changePage(page - 1)}
          >
            上一页
          </button>
          <label>
            页码{" "}
            <select
              aria-label="预览页码"
              value={page}
              disabled={busy}
              onChange={(event) => void changePage(Number(event.target.value))}
            >
              {Array.from({ length: pages }, (_, i) => i + 1).map((number) => (
                <option key={number} value={number}>
                  {number} / {pages}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy || page >= pages}
            onClick={() => void changePage(page + 1)}
          >
            下一页
          </button>
          <button type="button" onClick={() => setSelection({ kind: "page", page })}>
            引用整页
          </button>
        </div>
      )}
      <footer>
        {selection && <strong>{fileSelectionLabel(selection)}</strong>}
        {selection?.kind === "region" && (
          <div className="region-adjustments">
            {(["x", "y", "width", "height"] as const).map((field) => (
              <label key={field}>
                {{ x: "左", y: "上", width: "宽", height: "高" }[field]} %
                <input
                  type="number"
                  aria-label={`选区${field}`}
                  min={field === "width" || field === "height" ? 1 : 0}
                  max={100}
                  value={Math.round(selection[field] * 100)}
                  onChange={(event) => {
                    const value = Math.max(
                      field === "width" || field === "height" ? 0.01 : 0,
                      Math.min(1, Number(event.target.value) / 100),
                    );
                    const next = { ...selection, [field]: value };
                    next.width = Math.min(next.width, 1 - next.x);
                    next.height = Math.min(next.height, 1 - next.y);
                    if (next.width <= 0 || next.height <= 0) return;
                    setSelection(next);
                    const element = renderer.current?.pageElement();
                    if (element) drawRegion(element, next);
                  }}
                />
              </label>
            ))}
          </div>
        )}
        <button
          type="button"
          className="reference-action"
          disabled={disabled || busy || !selection || (kind !== "table" && !ready)}
          onClick={() => void addReference()}
        >
          {busy ? "正在处理…" : "引用到对话"}
        </button>
        <span role="status">{notice}</span>
      </footer>
      {reply && <div className="file-preview-mobile-reply">{reply}</div>}
    </section>
  );
}

function drawRegion(element: HTMLElement, selection: Extract<FileSelection, { kind: "region" }>) {
  element.ownerDocument.getElementById("selection-box")?.remove();
  const box = element.ownerDocument.createElement("div");
  box.id = "selection-box";
  Object.assign(box.style, {
    left: `${selection.x * 100}%`,
    top: `${selection.y * 100}%`,
    width: `${selection.width * 100}%`,
    height: `${selection.height * 100}%`,
  });
  element.append(box);
  for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
    const handle = element.ownerDocument.createElement("span");
    handle.setAttribute("data-corner", corner);
    Object.assign(handle.style, {
      position: "absolute",
      width: "14px",
      height: "14px",
      background: "#fff",
      border: "2px solid #3478f6",
      borderRadius: "50%",
      pointerEvents: "auto",
      touchAction: "none",
      cursor: "crosshair",
      [corner.includes("left") ? "left" : "right"]: "-8px",
      [corner.includes("top") ? "top" : "bottom"]: "-8px",
    });
    box.append(handle);
  }
}
function restoreTextSelection(
  element: HTMLElement,
  selection: Extract<FileSelection, { kind: "text" }>,
) {
  const text = element.textContent ?? "";
  let start =
    text.slice(selection.start, selection.end) === selection.quote
      ? selection.start
      : text.indexOf(`${selection.prefix ?? ""}${selection.quote}`);
  if (start < 0) return;
  if (text.slice(selection.start, selection.end) !== selection.quote)
    start += selection.prefix?.length ?? 0;
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let node = walker.nextNode();
  const range = element.ownerDocument.createRange();
  let began = false;
  while (node) {
    const length = node.textContent?.length ?? 0;
    // 节点交界处从下一个文字节点起选，避免 PDF 文本层把前一行换行包含进来。
    if (!began && offset + length > start) {
      range.setStart(node, start - offset);
      began = true;
    }
    if (began && offset + length >= start + selection.quote.length) {
      range.setEnd(node, start + selection.quote.length - offset);
      const current = element.ownerDocument.getSelection();
      current?.removeAllRanges();
      current?.addRange(range);
      break;
    }
    offset += length;
    node = walker.nextNode();
  }
}
async function captureSelection(
  element: HTMLElement | undefined,
  selection: FileSelection,
): Promise<string> {
  if (!element) throw new Error("预览尚未就绪。");
  const { toCanvas } = await import("html-to-image");
  const width = element.offsetWidth,
    height = element.offsetHeight;
  const canvas = await toCanvas(element, {
    pixelRatio: Math.min(1.5, 2000 / Math.max(width, height)),
    skipFonts: true,
    backgroundColor: "white",
    filter: (node) => !(node.nodeType === 1 && (node as Element).id === "selection-box"),
  });
  const area = selection.kind === "region" ? selection : { x: 0, y: 0, width: 1, height: 1 };
  const cropped = document.createElement("canvas");
  cropped.width = Math.max(1, Math.round(canvas.width * area.width));
  cropped.height = Math.max(1, Math.round(canvas.height * area.height));
  const context = cropped.getContext("2d");
  if (!context) throw new Error("当前浏览器无法生成截图。");
  context.drawImage(
    canvas,
    canvas.width * area.x,
    canvas.height * area.y,
    canvas.width * area.width,
    canvas.height * area.height,
    0,
    0,
    cropped.width,
    cropped.height,
  );
  const result = cropped.toDataURL("image/png");
  if (result.length > 2 * 1024 * 1024) throw new Error("区域截图过大，请缩小选区。");
  return result;
}

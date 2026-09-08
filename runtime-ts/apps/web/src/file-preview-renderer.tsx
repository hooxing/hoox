import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FilePreviewKind } from "@hoox/protocol/file-references";
import { prepareOfficePreview } from "./file-preview-office.js";

export type PreviewRenderer = {
  pageCount: number;
  pageElement: () => HTMLElement;
  showPage: (page: number) => Promise<void>;
  dispose: () => void;
};
export const previewFrameHtml = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>
*{box-sizing:border-box}html,body{margin:0;background:var(--surface-sunken,#f2f0ed);color:var(--text-primary,#292827);font:16px/1.65 system-ui,sans-serif}body{padding:24px 16px}#page{position:relative;background:white;min-height:100px;margin:0 auto;width:fit-content;min-width:100%;overflow:hidden;border-radius:3px;box-shadow:0 1px 4px #0000000d}::selection{background:var(--preview-selection,#bdd5c9)}pre{margin:0;padding:24px;white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.7 ui-monospace,monospace}.markdown{padding:24px;max-width:850px}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px}.textLayer{position:absolute;inset:0;overflow:clip;opacity:1;line-height:1;text-align:initial;transform-origin:0 0;caret-color:CanvasText;z-index:2}.textLayer :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0}.textLayer span.markedContent{top:0;height:0}.textLayer ::selection{background:var(--preview-selection,#bdd5c9)}#selection-box{position:absolute;pointer-events:none;border:2px solid var(--action-primary,#345447);background:color-mix(in srgb,var(--action-primary,#345447) 12%,transparent);z-index:10000}mark{background:#ffe697;color:inherit}.docx-wrapper{padding:0!important;background:white!important}.docx-wrapper>section.docx{margin:0!important;box-shadow:none!important}a{pointer-events:none;color:inherit}.preview-code{counter-reset:line}.preview-code>span{display:block;counter-increment:line}.preview-code>span:before{content:counter(line);display:inline-block;width:3em;color:#8a94a6;user-select:none}.preview-code .keyword{color:#8052b8}
</style></head><body><div id="page"></div></body></html>`;

export async function renderPreview(
  data: ArrayBuffer,
  kind: Exclude<FilePreviewKind, "table">,
  doc: Document,
  signal: AbortSignal,
): Promise<PreviewRenderer> {
  const root = doc.getElementById("page");
  if (root === null) throw new Error("预览容器尚未就绪。");
  root.replaceChildren();
  let dispose = () => {};
  let pageElement = () => root;
  let showPage = async (_page: number) => {};
  let pageCount = 1;
  if (kind === "image") {
    const image = doc.createElement("img");
    const url = URL.createObjectURL(new Blob([data]));
    dispose = () => URL.revokeObjectURL(url);
    image.src = url;
    image.alt = "文件预览";
    image.style.display = "block";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("图片无法解码。"));
      root.append(image);
    });
    if (image.naturalWidth * image.naturalHeight > 40_000_000) {
      dispose();
      throw new Error("图片尺寸过大，请缩小后预览。");
    }
  } else if (kind === "pdf") {
    const pdfjs = await import("pdfjs-dist");
    const { default: pdfStyles } = await import("pdfjs-dist/web/pdf_viewer.css?inline");
    const style = doc.createElement("style");
    style.textContent = pdfStyles;
    doc.head.append(style);
    const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const task = pdfjs.getDocument({
      data: new Uint8Array(data.slice(0)),
      enableXfa: false,
      stopAtErrors: true,
    });
    const abort = () => {
      void task.destroy();
    };
    signal.addEventListener("abort", abort, { once: true });
    const pdf = await task.promise;
    let textLayer: InstanceType<typeof pdfjs.TextLayer> | undefined;
    dispose = () => {
      style.remove();
      signal.removeEventListener("abort", abort);
      textLayer?.cancel();
      void task.destroy();
    };
    pageCount = pdf.numPages;
    showPage = async (page) => {
      textLayer?.cancel();
      root.replaceChildren();
      const item = await pdf.getPage(page);
      const base = item.getViewport({ scale: 1 });
      const viewport = item.getViewport({
        scale: Math.min(1.5, 1400 / base.width, 2000 / base.height),
      });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      root.style.width = `${viewport.width}px`;
      root.style.minWidth = "0";
      await item.render({ canvas, viewport }).promise;
      // 禁脚本的 iframe 将 canvas 视为回退内容；在父文档离屏绘制，再以惰性图片进入隔离预览。
      const bitmap = doc.createElement("img");
      bitmap.src = canvas.toDataURL("image/png");
      bitmap.alt = `第 ${page} 页`;
      bitmap.style.display = "block";
      bitmap.width = canvas.width;
      bitmap.height = canvas.height;
      root.append(bitmap);
      canvas.width = 0;
      canvas.height = 0;
      root.style.setProperty("--scale-round-x", "1px");
      root.style.setProperty("--scale-round-y", "1px");
      const layer = doc.createElement("div");
      layer.className = "textLayer";
      layer.style.setProperty("--scale-factor", String(viewport.scale));
      layer.style.setProperty("--total-scale-factor", String(viewport.scale));
      root.append(layer);
      textLayer = new pdfjs.TextLayer({
        textContentSource: await item.getTextContent(),
        container: layer,
        viewport,
      });
      await textLayer.render();
    };
  } else if (kind === "docx") {
    const prepared = await prepareOfficePreview(data);
    const { renderAsync } = await import("docx-preview");
    await renderAsync(prepared, root, undefined, {
      useBase64URL: true,
      renderAltChunks: false,
      renderComments: false,
      ignoreLastRenderedPageBreak: false,
      experimental: false,
    });
    const pages = [...root.querySelectorAll<HTMLElement>("section.docx")];
    if (pages.length === 0) throw new Error("文档没有可预览的页面。");
    pageCount = pages.length;
    let current = pages[0] ?? root;
    pageElement = () => current;
    showPage = async (page) => {
      pages.forEach((element, index) => {
        element.style.display = index === page - 1 ? "" : "none";
      });
      current = pages[page - 1] ?? root;
    };
  } else if (kind === "pptx") {
    const prepared = await prepareOfficePreview(data);
    const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import("@aiden0z/pptx-renderer");
    root.style.width = "960px";
    root.style.minWidth = "0";
    const viewer = await PptxViewer.open(prepared, root, {
      renderMode: "slide",
      width: 960,
      fitMode: "contain",
      zipLimits: RECOMMENDED_ZIP_LIMITS,
      lazyMedia: true,
      lazySlides: true,
      pdfjs: false,
      signal,
    });
    pageCount = viewer.slideCount;
    showPage = async (page) => {
      await viewer.renderSlide(page - 1);
    };
    dispose = () => viewer.destroy();
  } else {
    if (data.byteLength > 2 * 1024 * 1024) throw new Error("文本超过 2 MB，请拆分后预览。");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (kind === "markdown") {
      root.className = "markdown";
      const reactRoot = createRoot(root);
      reactRoot.render(
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          components={{
            img: ({ alt }) => <span>[图片：{alt}]</span>,
            a: ({ children }) => <span>{children}</span>,
          }}
        >
          {text}
        </ReactMarkdown>,
      );
      dispose = () => reactRoot.unmount();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    } else {
      const pre = doc.createElement("pre");
      if (kind === "code") {
        pre.className = "preview-code";
        const lines = text.split("\n");
        for (const [index, line] of lines.entries()) {
          const span = doc.createElement("span");
          span.dataset.line = String(index + 1);
          for (const piece of line.split(
            /(\b(?:const|let|var|function|return|if|else|class|import|export|from|def|for|while|async|await|true|false|null|None|SELECT|FROM|WHERE)\b)/u,
          )) {
            const token = doc.createElement("span");
            token.textContent = piece;
            if (
              /^(?:const|let|var|function|return|if|else|class|import|export|from|def|for|while|async|await|true|false|null|None|SELECT|FROM|WHERE)$/u.test(
                piece,
              )
            )
              token.className = "keyword";
            span.append(token);
          }
          if (index < lines.length - 1) span.append(doc.createTextNode("\n"));
          pre.append(span);
        }
      } else pre.textContent = text;
      root.append(pre);
    }
  }
  if (signal.aborted) {
    dispose();
    throw new DOMException("预览已关闭", "AbortError");
  }
  await showPage(1);
  return { pageCount, pageElement, showPage, dispose };
}

import { checkOfficeArchive } from "./file-preview-data.js";

/** 渲染器可能在父文档中创建媒体节点；在它运行前移除外部关系，避免依赖 iframe 的延迟 CSP 检查。 */
export async function prepareOfficePreview(data: ArrayBuffer): Promise<ArrayBuffer> {
  checkOfficeArchive(data);
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(data);
  let changed = false;
  for (const file of Object.values(zip.files)) {
    if (file.dir || !file.name.endsWith(".rels")) continue;
    const xml = new DOMParser().parseFromString(await file.async("string"), "application/xml");
    if (xml.getElementsByTagName("parsererror").length > 0)
      throw new Error("Office 文件关系描述损坏。");
    let removed = false;
    for (const relation of [...xml.getElementsByTagNameNS("*", "Relationship")]) {
      const target = relation.getAttribute("Target")?.trim() ?? "";
      if (
        relation.getAttribute("TargetMode")?.toLowerCase() === "external" ||
        /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)
      ) {
        relation.remove();
        removed = true;
      }
    }
    if (removed) {
      zip.file(file.name, new XMLSerializer().serializeToString(xml));
      changed = true;
    }
  }
  return changed ? zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" }) : data;
}

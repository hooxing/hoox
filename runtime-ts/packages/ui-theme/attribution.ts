const attributionShown = Symbol.for("hoox.attributionShown");

/** 每个浏览器文档最多输出一次固定的 Hoox 开源署名。 */
export function showHooxAttribution(): void {
  if (typeof document === "undefined") return;

  // 标记随文档而非模块存活，热更新不会重复输出。
  const page: Document & { [attributionShown]?: true } = document;
  if (page[attributionShown]) return;
  page[attributionShown] = true;

  console.info(
    "%cHoox%c\n本站基于开源项目 Hoox 构建\nhttps://github.com/hooxing/hoox",
    "background:#185b43;color:#fff;font-size:16px;font-weight:700;padding:2px 8px;border-radius:4px",
    "",
  );
}

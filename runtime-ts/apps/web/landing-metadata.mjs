const canonicalSlot = "<!-- hoox:canonical -->";
const imagePath = "/brand/hoox-open-graph.png";

export function parseSiteOrigin(value) {
  if (typeof value !== "string") return undefined;
  const url = URL.parse(value);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.href !== `${url.origin}/`) {
    return undefined;
  }
  // 此值会写入 HTML、XML 和 robots；只接受不需要转义的部署域名或 IP。
  return /^https?:\/\/[a-z0-9.:[\]-]+$/iu.test(url.origin) ? url.origin : undefined;
}

export function applySiteOrigin(html, origin) {
  if (!origin || !html.includes(canonicalSlot)) return html;
  const canonical = `${origin}/`;
  return html
    .replace(
      canonicalSlot,
      `<link rel="canonical" href="${canonical}" />\n    <meta property="og:url" content="${canonical}" />`,
    )
    .replace(`content="${imagePath}"`, `content="${origin}${imagePath}"`);
}

export function renderSitemap(origin) {
  const landing = origin ? `<url><loc>${origin}/</loc></url>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${landing}</urlset>\n`;
}

export function applyRobotsOrigin(robots, origin) {
  return origin && !/^Sitemap:/mu.test(robots)
    ? `${robots.trimEnd()}\n\nSitemap: ${origin}/sitemap.xml\n`
    : robots;
}

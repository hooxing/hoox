import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { build } from "vite";
import {
  applyRobotsOrigin,
  applySiteOrigin,
  parseSiteOrigin,
  renderSitemap,
} from "./landing-metadata.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const outDir = join(root, "dist");
const { values } = parseArgs({
  options: {
    "site-origin": { type: "string" },
    "privacy-url": { type: "string" },
    "terms-url": { type: "string" },
  },
});
const origin = parseSiteOrigin(values["site-origin"]);
if (values["site-origin"] !== undefined && !origin) {
  throw new Error("--site-origin 必须是 HTTP(S) 站点源");
}

function policyLink(key) {
  const value = values[key];
  if (value === undefined) return undefined;
  const url = typeof value === "string" && URL.parse(value);
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`--${key} 必须是无凭据的 HTTP(S) 链接`);
  }
  return url.href;
}

const links = { privacyUrl: policyLink("privacy-url"), termsUrl: policyLink("terms-url") };
const escapeAttribute = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const attributes = [
  ["privacy-url", links.privacyUrl],
  ["terms-url", links.termsUrl],
]
  .filter(([, value]) => value !== undefined)
  .map(([key, value]) => ` data-${key}="${escapeAttribute(value)}"`)
  .join("");

const temp = await mkdtemp(join(root, ".landing-build-"));
try {
  await build({
    root,
    build: { ssr: "src/landing-prerender.tsx", outDir: temp, copyPublicDir: false },
  });
  const { renderLanding } = await import(pathToFileURL(join(temp, "landing-prerender.js")).href);
  const landingMarkup = renderLanding(links);
  await build({
    root,
    build: {
      outDir,
      rollupOptions: { input: [join(root, "index.html"), join(root, "workspace.html")] },
    },
    plugins: [
      {
        name: "hoox-landing-prerender",
        transformIndexHtml(html, context) {
          if (context.path !== "/index.html") return;
          return applySiteOrigin(html, origin).replace(
            '<div id="root"></div>',
            () => `<div id="root" data-prerendered${attributes}>${landingMarkup}</div>`,
          );
        },
      },
    ],
  });
  const robotsPath = join(outDir, "robots.txt");
  const robots = await readFile(join(root, "robots.txt"), "utf8");
  await writeFile(robotsPath, applyRobotsOrigin(robots, origin));
  await writeFile(join(outDir, "sitemap.xml"), renderSitemap(origin));
} finally {
  await rm(temp, { recursive: true, force: true });
}

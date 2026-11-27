import { showHooxAttribution } from "@hoox/ui-theme/attribution";
import { createRoot } from "react-dom/client";
import { SiteRoot } from "./site-root.js";
import { BrandingProvider } from "@hoox/ui-theme/branding";

showHooxAttribution();

document.documentElement.dataset.surface = "workspace";
document.title = "Hoox 工作台";
for (const tag of document.head.querySelectorAll(
  '[property^="og:"], [name^="twitter:"], [rel="canonical"]',
)) {
  tag.remove();
}
const robots = document.head.querySelector('meta[name="robots"]');
if (robots === null) {
  const tag = document.createElement("meta");
  tag.name = "robots";
  tag.content = "noindex, nofollow";
  document.head.append(tag);
}
const rootElement = document.getElementById("root");
if (rootElement !== null)
  createRoot(rootElement).render(
    <BrandingProvider>
      <SiteRoot />
    </BrandingProvider>,
  );

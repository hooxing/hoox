import { createRoot } from "react-dom/client";
import { resolveSiteSurface } from "./site-route.js";
import { SiteRoot } from "./site-root.js";

const surface = resolveSiteSurface(window.location);
document.documentElement.dataset.surface = surface;
if (surface === "workspace") {
  document.title = "Hoox 工作台";
  const robots = document.createElement("meta");
  robots.name = "robots";
  robots.content = "noindex, nofollow";
  document.head.append(robots);
}
const rootElement = document.getElementById("root");
if (rootElement !== null) createRoot(rootElement).render(<SiteRoot surface={surface} />);

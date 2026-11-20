import { createRoot, hydrateRoot } from "react-dom/client";
import { LandingPage } from "./landing-page.js";
import { resolveSiteSurface } from "./site-route.js";

if (resolveSiteSurface(window.location) === "workspace") {
  void import("./workspace-bootstrap.js");
} else {
  const rootElement = document.getElementById("root");
  if (rootElement !== null) {
    const app = (
      <LandingPage
        privacyUrl={rootElement.dataset.privacyUrl}
        termsUrl={rootElement.dataset.termsUrl}
      />
    );
    if (rootElement.hasAttribute("data-prerendered")) hydrateRoot(rootElement, app);
    else createRoot(rootElement).render(app);
  }
}

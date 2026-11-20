import { renderToString } from "react-dom/server";
import { type LandingLinks, LandingPage } from "./landing-page.js";

export function renderLanding(links: LandingLinks): string {
  return renderToString(<LandingPage {...links} />);
}

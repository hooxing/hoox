import { lazy, Suspense } from "react";
import type { SiteSurface } from "./site-route.js";

const Landing = lazy(() =>
  import("./landing-page.js").then((module) => ({ default: module.LandingPage })),
);
const Workspace = lazy(() => import("./main.js").then((module) => ({ default: module.App })));

export function SiteRoot({ surface }: { readonly surface: SiteSurface }) {
  return (
    <Suspense fallback={<p role="status">正在加载 Hoox…</p>}>
      {surface === "landing" ? <Landing /> : <Workspace />}
    </Suspense>
  );
}

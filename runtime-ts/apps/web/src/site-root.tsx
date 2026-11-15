import { lazy, Suspense, useEffect, useState } from "react";
import type { SiteSurface } from "./site-route.js";

const Landing = lazy(() =>
  import("./landing-page.js").then((module) => ({ default: module.LandingPage })),
);
const Workspace = lazy(() => import("./main.js").then((module) => ({ default: module.App })));

export function SiteRoot({ surface }: { readonly surface: SiteSurface }) {
  const [checked, setChecked] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch("/api/v1/installation", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("INSTALLATION_UNAVAILABLE");
        const result = (await response.json()) as { data: { initialized: boolean } };
        if (!active) return;
        if (!result.data.initialized) window.location.replace("/admin/");
        else setChecked(true);
      })
      .catch(() => {
        if (active) {
          if (surface === "landing") setChecked(true);
          else setFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, [surface]);
  if (failed)
    return (
      <main>
        <p role="alert">无法连接 Hoox 服务，请确认 API 已启动。</p>
        <button type="button" onClick={() => window.location.reload()}>
          重新连接
        </button>
      </main>
    );
  if (!checked) return <p role="status">正在检查 Hoox 安装状态…</p>;
  return (
    <Suspense fallback={<p role="status">正在加载 Hoox…</p>}>
      {surface === "landing" ? <Landing /> : <Workspace />}
    </Suspense>
  );
}

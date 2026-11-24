import { lazy, Suspense, useEffect, useState } from "react";
import { useBranding } from "@hoox/ui-theme/branding";

const Workspace = lazy(() => import("./main.js").then((module) => ({ default: module.App })));

export function SiteRoot() {
  const { configuration } = useBranding();
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
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);
  if (failed)
    return (
      <main>
        <p role="alert">无法连接 {configuration.productName} 服务，请确认 API 已启动。</p>
        <button type="button" onClick={() => window.location.reload()}>
          重新连接
        </button>
      </main>
    );
  if (!checked) return <p role="status">正在检查 {configuration.productName} 安装状态…</p>;
  return (
    <Suspense fallback={<p role="status">正在加载 {configuration.productName}…</p>}>
      <Workspace />
    </Suspense>
  );
}

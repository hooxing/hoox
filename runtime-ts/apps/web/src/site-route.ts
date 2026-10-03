export type SiteSurface = "landing" | "workspace";

export function resolveSiteSurface(location: Pick<Location, "pathname" | "search">): SiteSurface {
  // 旧登录错误回调仍可能返回根路径，不能被公开首页吞掉。
  if (new URLSearchParams(location.search).has("error")) return "workspace";
  return location.pathname === "/" || location.pathname === "/index.html" ? "landing" : "workspace";
}

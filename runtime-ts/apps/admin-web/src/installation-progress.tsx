import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AdminControlApi } from "./control-api.js";

const defaultApi = new AdminControlApi();

export function InstallationProgress({
  api = defaultApi,
}: {
  api?: Pick<AdminControlApi, "overview" | "sandboxOverview">;
}) {
  const status = useQuery({
    queryKey: ["installation-progress"],
    queryFn: async () => {
      const [overview, sandbox] = await Promise.all([api.overview(), api.sandboxOverview()]);
      return {
        model: overview.activeModel !== undefined,
        sandbox: (sandbox.routing?.targets.length ?? 0) > 0,
      };
    },
    refetchInterval: 5_000,
    retry: false,
  });
  return (
    <aside className="installation-banner" aria-label="首次运行配置进度">
      <div>
        <strong>首次运行：连接模型与沙箱</strong>
        <p>管理员已创建。完成模型与沙箱配置后即可开始使用，其他功能可稍后设置。</p>
        <nav aria-label="初始化步骤">
          <span>1. 管理员已创建</span>
          {" · "}
          <Link to="/models?setup=1">
            2. 模型{status.data ? (status.data.model ? "已配置" : "待配置") : ""}
          </Link>
          {" · "}
          <Link to="/sandboxes?setup=1">
            3. 沙箱{status.data ? (status.data.sandbox ? "已配置" : "待配置") : ""}
          </Link>
        </nav>
        {status.isError && <p role="alert">暂时无法检查配置，请刷新重试。</p>}
        {status.data?.model && status.data.sandbox && (
          <p role="status">必需配置已保存。记忆、登录方式和标题模型可在后台按需设置。</p>
        )}
      </div>
      <div>
        <button
          type="button"
          className="quiet-button"
          disabled={status.isFetching}
          onClick={() => void status.refetch()}
        >
          检查配置
        </button>
        {" · "}
        <a href="/app">进入工作台 / 稍后配置</a>
      </div>
    </aside>
  );
}

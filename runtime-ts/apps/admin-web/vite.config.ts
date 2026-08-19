import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, resolve(import.meta.dirname, "../../.."), "");
  const skillToken = environment.DEV_SKILL_ADMIN_TOKEN;
  const controlToken = environment.DEV_ADMIN_CONTROL_TOKEN;
  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 4174,
      proxy: {
        "/v1/admin/control": {
          target: "http://127.0.0.1:3003",
          changeOrigin: true,
          ...(controlToken === undefined || controlToken.length === 0
            ? {}
            : { headers: { Authorization: `Bearer ${controlToken}` } }),
        },
        "/v1/admin/skill-submissions": {
          target: "http://127.0.0.1:3002",
          changeOrigin: true,
          // Token 只停留在 Vite 服务端代理，既不写入静态构建，也不暴露给浏览器脚本。
          ...(skillToken === undefined || skillToken.length === 0
            ? {}
            : { headers: { Authorization: `Bearer ${skillToken}` } }),
        },
      },
    },
    preview: { host: "127.0.0.1", port: 4174 },
  };
});

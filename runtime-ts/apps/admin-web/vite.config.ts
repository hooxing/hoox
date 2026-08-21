import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, resolve(import.meta.dirname, "../../.."), "");
  const controlToken = environment.DEV_ADMIN_CONTROL_TOKEN;
  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 4174,
      proxy: {
        "/v1/admin": {
          target: "http://127.0.0.1:3003",
          changeOrigin: true,
          // 管理 Token 只停留在 Vite 服务端代理，不会进入浏览器静态资源。
          ...(controlToken === undefined || controlToken.length === 0
            ? {}
            : { headers: { Authorization: `Bearer ${controlToken}` } }),
        },
      },
    },
    preview: { host: "127.0.0.1", port: 4174 },
  };
});

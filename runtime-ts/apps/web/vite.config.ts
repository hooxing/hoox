import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import type { ClientRequest, IncomingMessage } from "node:http";
import { defineConfig, loadEnv } from "vite";
import { resolveApiTarget } from "./src/config.js";

// 代理不得把远程安装请求伪装成本地回环；保留 Host 并标记原始远程来源。
export function preserveInstallationSource(
  proxyRequest: ClientRequest,
  request: IncomingMessage,
): void {
  const address = request.socket.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") {
    proxyRequest.setHeader("x-forwarded-for", address ?? "unknown");
  }
}

export default defineConfig(({ mode }) => {
  // Vite 只自动加载 VITE_ 前缀；保留旧变量仅用于本地命令行兼容。
  const target = resolveApiTarget({ ...process.env, ...loadEnv(mode, process.cwd(), "VITE_") });
  return {
    worker: { format: "es" },
    plugins: [react()],
    publicDir: resolve(import.meta.dirname, "../../public"),
    server: {
      proxy: {
        "/admin": {
          target: "http://127.0.0.1:4174",
          changeOrigin: false,
          ws: true,
          configure: (proxy) => {
            proxy.on("proxyReq", preserveInstallationSource);
          },
        },
        "/v1/admin": { target: "http://127.0.0.1:3003", changeOrigin: false },
        "/api": {
          target,
          changeOrigin: false,
          configure: (proxy) => {
            proxy.on("proxyReq", preserveInstallationSource);
          },
          rewrite: (path) => path.replace(/^\/api/u, ""),
        },
      },
    },
    preview: { port: 4173 },
  };
});

import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import type { ClientRequest, IncomingMessage } from "node:http";
import { defineConfig } from "vite";
import { resolveBuildInfo } from "./build-info.js";

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

export default defineConfig(() => {
  return {
    base: "/admin/",
    plugins: [react()],
    define: { __HOOX_BUILD_INFO__: JSON.stringify(resolveBuildInfo(process.env)) },
    publicDir: resolve(import.meta.dirname, "../../public"),
    server: {
      host: "127.0.0.1",
      port: 4174,
      proxy: {
        "/api": {
          target: "http://127.0.0.1:3001",
          changeOrigin: false,
          configure: (proxy) => {
            proxy.on("proxyReq", preserveInstallationSource);
          },
          rewrite: (path) => path.replace(/^\/api/u, ""),
        },
        "/v1/admin": {
          target: "http://127.0.0.1:3003",
          changeOrigin: true,
        },
      },
    },
    preview: { host: "127.0.0.1", port: 4174 },
  };
});

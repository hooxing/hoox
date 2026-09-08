import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import { resolveApiTarget } from "./src/config.js";

export default defineConfig(({ mode }) => {
  // Vite 只自动加载 VITE_ 前缀；保留旧变量仅用于本地命令行兼容。
  const target = resolveApiTarget({ ...process.env, ...loadEnv(mode, process.cwd(), "VITE_") });
  return {
    worker: { format: "es" },
    plugins: [react()],
    publicDir: resolve(import.meta.dirname, "../../public"),
    server: {
      proxy: {
        "/api": { target, changeOrigin: true, rewrite: (path) => path.replace(/^\/api/u, "") },
      },
    },
    preview: { port: 4173 },
  };
});

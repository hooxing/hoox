import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const target = process.env.WEB_API_TARGET ?? "http://127.0.0.1:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target, changeOrigin: true, rewrite: (path) => path.replace(/^\/api/u, "") },
    },
  },
  preview: { port: 4173 },
});

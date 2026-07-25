import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    // Workspace 测试必须命中当前源码，不能误用上一次构建残留的 dist。
    alias: {
      "@cube-runtime/domain": fileURLToPath(
        new URL("./runtime-ts/packages/domain/src/index.ts", import.meta.url),
      ),
      "@cube-runtime/protocol": fileURLToPath(
        new URL("./runtime-ts/packages/protocol/src/index.ts", import.meta.url),
      ),
      "@cube-runtime/protocol-mapper": fileURLToPath(
        new URL("./runtime-ts/packages/protocol-mapper/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "runtime-ts/**/*.test.ts"],
    exclude: ["runtime-ts/vendor/**", "**/dist/**", "**/node_modules/**"],
    passWithNoTests: false,
    reporters: ["default"],
  },
});

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Workspace 测试必须命中当前源码，不能误用上一次构建残留的 dist。
    alias: {
      "@hoox/sandbox/testing": fileURLToPath(
        new URL("./runtime-ts/packages/sandbox/src/testing/fake.ts", import.meta.url),
      ),
      "@hoox/sandbox": fileURLToPath(
        new URL("./runtime-ts/packages/sandbox/src/index.ts", import.meta.url),
      ),
      "@hoox/pi-adapter": fileURLToPath(
        new URL("./runtime-ts/packages/pi-adapter/src/index.ts", import.meta.url),
      ),
      "@hoox/context-policy": fileURLToPath(
        new URL("./runtime-ts/packages/context-policy/src/index.ts", import.meta.url),
      ),
      "@hoox/run-contracts/mutation-protocol": fileURLToPath(
        new URL("./runtime-ts/packages/run-contracts/src/mutation-protocol.ts", import.meta.url),
      ),
      "@hoox/run-contracts": fileURLToPath(
        new URL("./runtime-ts/packages/run-contracts/src/index.ts", import.meta.url),
      ),
      "@hoox/domain": fileURLToPath(
        new URL("./runtime-ts/packages/domain/src/index.ts", import.meta.url),
      ),
      "@hoox/protocol": fileURLToPath(
        new URL("./runtime-ts/packages/protocol/src/index.ts", import.meta.url),
      ),
      "@hoox/protocol-mapper": fileURLToPath(
        new URL("./runtime-ts/packages/protocol-mapper/src/index.ts", import.meta.url),
      ),
      "@hoox/persistence": fileURLToPath(
        new URL("./runtime-ts/packages/persistence/src/index.ts", import.meta.url),
      ),
      "@hoox/skill": fileURLToPath(
        new URL("./runtime-ts/packages/skill/src/index.ts", import.meta.url),
      ),
      "@hoox/trajectory": fileURLToPath(
        new URL("./runtime-ts/packages/trajectory/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: [
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
      "runtime-ts/**/*.test.ts",
      "runtime-ts/**/*.test.tsx",
    ],
    exclude: ["tests/integration/**", "runtime-ts/vendor/**", "**/dist/**", "**/node_modules/**"],
    passWithNoTests: false,
    reporters: ["default"],
  },
});

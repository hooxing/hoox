import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Workspace 测试必须命中当前源码，不能误用上一次构建残留的 dist。
    alias: {
      "@hoox/protocol/file-references": fileURLToPath(
        new URL("./runtime-ts/packages/protocol/src/file-references.ts", import.meta.url),
      ),
      "@hoox/sandbox/testing": fileURLToPath(
        new URL("./runtime-ts/packages/sandbox/src/testing/fake.ts", import.meta.url),
      ),
      "@hoox/sandbox": fileURLToPath(
        new URL("./runtime-ts/packages/sandbox/src/index.ts", import.meta.url),
      ),
      "@hoox/pi-adapter/thread-history": fileURLToPath(
        new URL("./runtime-ts/packages/pi-adapter/src/thread-history.ts", import.meta.url),
      ),
      "@hoox/pi-adapter": fileURLToPath(
        new URL("./runtime-ts/packages/pi-adapter/src/index.ts", import.meta.url),
      ),
      "@hoox/tool-router": fileURLToPath(
        new URL("./runtime-ts/packages/tool-router/src/index.ts", import.meta.url),
      ),
      "@hoox/context-policy": fileURLToPath(
        new URL("./runtime-ts/packages/context-policy/src/index.ts", import.meta.url),
      ),
      "@hoox/run-contracts/rollout-projection": fileURLToPath(
        new URL("./runtime-ts/packages/run-contracts/src/rollout-projection.ts", import.meta.url),
      ),
      "@hoox/run-contracts/runtime-agent-event": fileURLToPath(
        new URL("./runtime-ts/packages/run-contracts/src/runtime-agent-event.ts", import.meta.url),
      ),
      "@hoox/run-contracts/sandbox-port": fileURLToPath(
        new URL("./runtime-ts/packages/run-contracts/src/sandbox-port.ts", import.meta.url),
      ),
      "@hoox/run-contracts/thread-history": fileURLToPath(
        new URL("./runtime-ts/packages/run-contracts/src/thread-history.ts", import.meta.url),
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
      "@hoox/protocol/pi-model-catalog": fileURLToPath(
        new URL("./runtime-ts/packages/protocol/src/pi-model-catalog.ts", import.meta.url),
      ),
      "@hoox/protocol": fileURLToPath(
        new URL("./runtime-ts/packages/protocol/src/index.ts", import.meta.url),
      ),
      "@hoox/protocol-mapper": fileURLToPath(
        new URL("./runtime-ts/packages/protocol-mapper/src/index.ts", import.meta.url),
      ),
      "@hoox/persistence/admin": fileURLToPath(
        new URL("./runtime-ts/packages/persistence/src/entrypoints/admin.ts", import.meta.url),
      ),
      "@hoox/persistence/blob": fileURLToPath(
        new URL("./runtime-ts/packages/persistence/src/entrypoints/blob.ts", import.meta.url),
      ),
      "@hoox/persistence/maintenance": fileURLToPath(
        new URL(
          "./runtime-ts/packages/persistence/src/entrypoints/maintenance.ts",
          import.meta.url,
        ),
      ),
      "@hoox/persistence/postgres": fileURLToPath(
        new URL("./runtime-ts/packages/persistence/src/entrypoints/postgres.ts", import.meta.url),
      ),
      "@hoox/persistence/run-execution": fileURLToPath(
        new URL(
          "./runtime-ts/packages/persistence/src/entrypoints/run-execution.ts",
          import.meta.url,
        ),
      ),
      "@hoox/persistence/thread": fileURLToPath(
        new URL("./runtime-ts/packages/persistence/src/entrypoints/thread.ts", import.meta.url),
      ),
      "@hoox/persistence/trajectory": fileURLToPath(
        new URL("./runtime-ts/packages/persistence/src/entrypoints/trajectory.ts", import.meta.url),
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

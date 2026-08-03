import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@cube-runtime/sandbox/testing": fileURLToPath(
        new URL("./runtime-ts/packages/sandbox/src/testing/fake.ts", import.meta.url),
      ),
      "@cube-runtime/domain": fileURLToPath(
        new URL("./runtime-ts/packages/domain/src/index.ts", import.meta.url),
      ),
      "@cube-runtime/persistence": fileURLToPath(
        new URL("./runtime-ts/packages/persistence/src/index.ts", import.meta.url),
      ),
      "@cube-runtime/context-policy": fileURLToPath(
        new URL("./runtime-ts/packages/context-policy/src/index.ts", import.meta.url),
      ),
      "@cube-runtime/resource": fileURLToPath(
        new URL("./runtime-ts/packages/resource/src/index.ts", import.meta.url),
      ),
      "@cube-runtime/skill": fileURLToPath(
        new URL("./runtime-ts/packages/skill/src/index.ts", import.meta.url),
      ),
      "@cube-runtime/protocol": fileURLToPath(
        new URL("./runtime-ts/packages/protocol/src/index.ts", import.meta.url),
      ),
      "@cube-runtime/protocol-mapper": fileURLToPath(
        new URL("./runtime-ts/packages/protocol-mapper/src/index.ts", import.meta.url),
      ),
      "@cube-runtime/run-contracts/mutation-protocol": fileURLToPath(
        new URL("./runtime-ts/packages/run-contracts/src/mutation-protocol.ts", import.meta.url),
      ),
      "@cube-runtime/run-contracts": fileURLToPath(
        new URL("./runtime-ts/packages/run-contracts/src/index.ts", import.meta.url),
      ),
      "@cube-runtime/pi-adapter": fileURLToPath(
        new URL("./runtime-ts/packages/pi-adapter/src/index.ts", import.meta.url),
      ),
      "@cube-runtime/sandbox": fileURLToPath(
        new URL("./runtime-ts/packages/sandbox/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/integration/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ["default"],
  },
});

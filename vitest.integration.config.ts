import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@hoox/sandbox/testing": fileURLToPath(
        new URL("./runtime-ts/packages/sandbox/src/testing/fake.ts", import.meta.url),
      ),
      "@hoox/domain": fileURLToPath(
        new URL("./runtime-ts/packages/domain/src/index.ts", import.meta.url),
      ),
      "@hoox/persistence": fileURLToPath(
        new URL("./runtime-ts/packages/persistence/src/index.ts", import.meta.url),
      ),
      "@hoox/context-policy": fileURLToPath(
        new URL("./runtime-ts/packages/context-policy/src/index.ts", import.meta.url),
      ),
      "@hoox/resource": fileURLToPath(
        new URL("./runtime-ts/packages/resource/src/index.ts", import.meta.url),
      ),
      "@hoox/skill": fileURLToPath(
        new URL("./runtime-ts/packages/skill/src/index.ts", import.meta.url),
      ),
      "@hoox/protocol": fileURLToPath(
        new URL("./runtime-ts/packages/protocol/src/index.ts", import.meta.url),
      ),
      "@hoox/protocol-mapper": fileURLToPath(
        new URL("./runtime-ts/packages/protocol-mapper/src/index.ts", import.meta.url),
      ),
      "@hoox/run-contracts/mutation-protocol": fileURLToPath(
        new URL("./runtime-ts/packages/run-contracts/src/mutation-protocol.ts", import.meta.url),
      ),
      "@hoox/run-contracts": fileURLToPath(
        new URL("./runtime-ts/packages/run-contracts/src/index.ts", import.meta.url),
      ),
      "@hoox/pi-adapter/thread-history": fileURLToPath(
        new URL("./runtime-ts/packages/pi-adapter/src/thread-history.ts", import.meta.url),
      ),
      "@hoox/pi-adapter": fileURLToPath(
        new URL("./runtime-ts/packages/pi-adapter/src/index.ts", import.meta.url),
      ),
      "@hoox/sandbox": fileURLToPath(
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

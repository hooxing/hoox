import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "runtime-ts/**/*.test.ts"],
    passWithNoTests: false,
    reporters: ["default"],
  },
});

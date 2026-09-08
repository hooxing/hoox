import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./runtime-ts/apps/web/browser-tests",
  testMatch: "*.spec.ts",
  outputDir: ".tmp/file-preview-results",
  timeout: 45000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4188",
    viewport: { width: 1440, height: 960 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm --filter @hoox/web dev --port 4188",
    url: "http://127.0.0.1:4188/browser-tests/file-preview.html",
    reuseExistingServer: true,
  },
});

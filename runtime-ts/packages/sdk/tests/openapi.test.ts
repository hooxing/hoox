import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("SDK 生成类型与当前公开 OpenAPI 严格一致", () => {
  expect(() =>
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/generate-types.mjs", import.meta.url)), "--check"],
      { timeout: 30_000, stdio: "pipe" },
    ),
  ).not.toThrow();
});

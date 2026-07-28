import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Agent Worker 开发预检入口", () => {
  it("只调用只读依赖 probe，不会启动 polling 或领取 dispatch", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./development-preflight-main.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("probeDevelopmentWorkerDependencies(configuration)");
    expect(source).not.toContain("startWorkerProcess");
    expect(source).not.toContain("AgentWorkerPollingLoop");
    expect(source).not.toContain("queue.claim");
  });
});

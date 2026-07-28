import type { SandboxHandle } from "@cube-runtime/sandbox";
import { describe, expect, it } from "vitest";
import { createObservedSandboxTools } from "./tools.js";

describe("受审 Tool 输出脱敏边界", () => {
  it("原始上游错误不会进入 Observation source", async () => {
    const secret = "不可泄漏的原始连接错误";
    const sandbox = {
      command: async () => {
        throw new Error(secret);
      },
    } as unknown as SandboxHandle;
    const observed = createObservedSandboxTools(sandbox, {
      authorizeToolEffect: async () => ({
        consumedAtMonotonicMs: performance.now(),
        maxContinuationDelayMs: 1000,
      }),
    });
    const tool = observed.tools.find((item) => item.name === "sandbox_command");
    if (tool === undefined) throw new Error("测试缺少 sandbox_command");
    await tool.execute("call_secret", { command: "false" }, undefined, () => undefined, {} as never);
    const output = await observed.outputs.readSanitizedOutput({
      toolCallId: "call_secret",
      toolName: "sandbox_command",
    });
    expect(output).toContain("Sandbox 工具执行失败");
    expect(output).not.toContain(secret);
    await expect(
      observed.outputs.readSanitizedOutput({
        toolCallId: "call_secret",
        toolName: "sandbox_read_file",
      }),
    ).resolves.toBeUndefined();
  });
});

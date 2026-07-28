import type { SandboxHandle } from "@cube-runtime/sandbox";
import { describe, expect, it } from "vitest";
import { createObservedSandboxTools } from "./tools.js";

describe("受审 Tool 输出脱敏边界", () => {
  it("只把已持久化后的截断 Observation 返回给 Pi", async () => {
    const rawOutput = "完整但超出模型预算的工具输出";
    const sandbox = {
      command: async () => ({ output: rawOutput }),
    } as unknown as SandboxHandle;
    const observed = createObservedSandboxTools(
      sandbox,
      {
        authorizeToolEffect: async () => ({
          consumedAtMonotonicMs: performance.now(),
          maxContinuationDelayMs: 1000,
        }),
      },
      (outputs) => ({
        record: async (call) => {
          // 录制器必须先从只读脱敏源取得完整事实，Pi 仅收到其持久化后的投影。
          await expect(outputs.readSanitizedOutput(call)).resolves.toBe(
            JSON.stringify({ output: rawOutput }),
          );
          return { outcome: "recorded" as const, observation: "[已截断]", isTruncated: true };
        },
      }),
    );
    const tool = observed.tools.find((item) => item.name === "sandbox_command");
    if (tool === undefined) throw new Error("测试缺少 sandbox_command");

    const result = await tool.execute(
      "call_truncated",
      { command: "echo test" },
      undefined,
      () => undefined,
      {} as never,
    );

    expect(result.content).toEqual([{ type: "text", text: "[已截断]" }]);
    expect(JSON.stringify(result)).not.toContain(rawOutput);
  });

  it("原始上游错误不会进入 Observation source", async () => {
    const secret = "不可泄漏的原始连接错误";
    const sandbox = {
      command: async () => {
        throw new Error(secret);
      },
    } as unknown as SandboxHandle;
    const observed = createObservedSandboxTools(
      sandbox,
      {
        authorizeToolEffect: async () => ({
          consumedAtMonotonicMs: performance.now(),
          maxContinuationDelayMs: 1000,
        }),
      },
      (outputs) => ({
        record: async (call) => {
          const observation = await outputs.readSanitizedOutput(call);
          return observation === undefined
            ? { outcome: "conflict" as const }
            : { outcome: "recorded" as const, observation, isTruncated: false };
        },
      }),
    );
    const tool = observed.tools.find((item) => item.name === "sandbox_command");
    if (tool === undefined) throw new Error("测试缺少 sandbox_command");
    const result = await tool.execute(
      "call_secret",
      { command: "false" },
      undefined,
      () => undefined,
      {} as never,
    );
    const output = await observed.outputs.readSanitizedOutput({
      toolCallId: "call_secret",
      toolName: "sandbox_command",
    });
    expect(output).toContain("Sandbox 工具执行失败");
    expect(output).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    await expect(
      observed.outputs.readSanitizedOutput({
        toolCallId: "call_secret",
        toolName: "sandbox_read_file",
      }),
    ).resolves.toBeUndefined();
  });
});

import { parseControlledToolReceipt } from "@cube-runtime/context-policy";
import { type SandboxHandle, SandboxRuntimeError } from "@cube-runtime/sandbox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { createObservedSandboxTools, SANDBOX_TOOL_NAMES } from "./tools.js";

type ToolExecute = (
  id: string,
  input: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: () => void,
  context: never,
) => Promise<{ content: readonly { readonly type: string; readonly text: string }[] }>;

function fixture(sandbox: SandboxHandle, recorderOutcome: "recorded" | "unknown" = "recorded") {
  const receipts: string[] = [];
  let authorizationCalls = 0;
  let continuationRejected = false;
  const observed = createObservedSandboxTools(
    sandbox,
    {
      authorizeToolEffect: async () => {
        authorizationCalls += 1;
        return {
          consumedAtMonotonicMs: performance.now(),
          maxContinuationDelayMs: 1_000,
        };
      },
    },
    (outputs) => ({
      record: async (call) => {
        const receipt = await outputs.readControlledReceipt(call);
        if (receipt === undefined) return { outcome: "conflict" as const };
        receipts.push(receipt);
        return recorderOutcome === "recorded"
          ? { outcome: "recorded" as const, observation: receipt, isTruncated: false }
          : { outcome: "unknown" as const };
      },
    }),
    () => {
      continuationRejected = true;
    },
  );
  const tool = observed.tools[0];
  if (tool === undefined) throw new Error("测试缺少 exec_command");
  return {
    execute: tool.execute as unknown as ToolExecute,
    executionMode: tool.executionMode,
    prepareArguments: tool.prepareArguments,
    parameters: tool.parameters,
    receipts,
    authorizationCalls: () => authorizationCalls,
    continuationRejected: () => continuationRejected,
  };
}

describe("exec_command", () => {
  it("允许模型按需提供面向用户的命令目的", () => {
    const tested = fixture({ command: vi.fn() } as unknown as SandboxHandle);
    expect(
      Value.Check(tested.parameters, {
        cmd: "ls -la",
        user_facing_purpose: "查看当前目录中的文件",
      }),
    ).toBe(true);
    expect(
      Value.Check(tested.parameters, {
        cmd: "ls -la",
        user_facing_purpose: "",
      }),
    ).toBe(false);
  });

  it("新 Session 暴露受控命令与文件工具", () => {
    expect(SANDBOX_TOOL_NAMES).toEqual(["exec_command", "read", "edit", "write"]);
  });

  it("同一模型消息中的多个 durable 调用按完整 call/result 对顺序执行", () => {
    const tested = fixture({ command: vi.fn() } as unknown as SandboxHandle);
    expect(tested.executionMode).toBe("sequential");
  });

  it("默认在 /workspace 通过 Bash 执行并把真实结构化结果返回模型", async () => {
    const command = vi.fn(async () => ({
      stdout: "generated\n",
      stderr: "warning\n",
      exitCode: 0,
    }));
    const tested = fixture({ command } as unknown as SandboxHandle);

    const result = await tested.execute(
      "call_exec_success",
      { cmd: "python generate.py" },
      undefined,
      () => undefined,
      {} as never,
    );

    expect(command).toHaveBeenCalledWith(
      "cd -- '/workspace' && exec /bin/bash -c 'python generate.py'",
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
    expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({
      exit_code: 0,
      stdout: "generated\n",
      stderr: "warning\n",
      output_truncated: false,
      original_output_bytes: 18,
    });
    expect(JSON.parse(result.content[0]?.text ?? "").wall_time_seconds).toEqual(expect.any(Number));
    expect(parseControlledToolReceipt(tested.receipts[0] ?? "")).toMatchObject({
      toolName: "exec_command",
      outcome: "succeeded",
    });
  });

  it("安全引用自定义 workdir 和含单引号的命令", async () => {
    const command = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const tested = fixture({ command } as unknown as SandboxHandle);

    await tested.execute(
      "call_exec_quote",
      { cmd: "printf '%s' ok", workdir: "/workspace/a'b", timeout_ms: 55 },
      undefined,
      () => undefined,
      {} as never,
    );

    expect(command).toHaveBeenCalledWith(
      `cd -- '/workspace/a'"'"'b' && exec /bin/bash -c 'printf '"'"'%s'"'"' ok'`,
      expect.objectContaining({ timeoutMs: 55 }),
    );
  });

  it("schema 级缺字段、错类型和额外字段都不申请许可，但形成失败回执", async () => {
    const command = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const tested = fixture({ command } as unknown as SandboxHandle);
    if (tested.prepareArguments === undefined) throw new Error("测试缺少 schema 参数桥");
    const invalidInputs = [{}, { cmd: 123 }, { cmd: "echo no", extra: true }];

    for (const [index, input] of invalidInputs.entries()) {
      const prepared = tested.prepareArguments(input);
      expect(Value.Check(tested.parameters, prepared)).toBe(true);
      await expect(
        tested.execute(
          `call_exec_invalid_${index}`,
          prepared as Record<string, unknown>,
          undefined,
          () => undefined,
          {} as never,
        ),
      ).rejects.toThrow("EXEC_INVALID_ARGUMENTS");
    }

    expect(command).not.toHaveBeenCalled();
    expect(tested.authorizationCalls()).toBe(0);
    expect(tested.receipts.map((receipt) => parseControlledToolReceipt(receipt).outcome)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
  });

  it("timeout_ms 接受 1 小时上限并传给 CubeSandbox", async () => {
    const command = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const tested = fixture({ command } as unknown as SandboxHandle);
    const input = { cmd: "long-running-task", timeout_ms: 3_600_000 };

    expect(Value.Check(tested.parameters, input)).toBe(true);
    await tested.execute("call_exec_max_timeout", input, undefined, () => undefined, {} as never);

    expect(command).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeoutMs: 3_600_000 }),
    );
  });

  it("timeout_ms 拒绝超过 1 小时的参数", () => {
    const tested = fixture({
      command: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    } as unknown as SandboxHandle);

    expect(
      Value.Check(tested.parameters, { cmd: "too-long-running-task", timeout_ms: 3_600_001 }),
    ).toBe(false);
  });

  it("非零退出码是可供模型修正的正常工具结果", async () => {
    const tested = fixture({
      command: async () => ({ stdout: "", stderr: "module missing\n", exitCode: 7 }),
    } as unknown as SandboxHandle);

    const result = await tested.execute(
      "call_exec_nonzero",
      { cmd: "python generate.py" },
      undefined,
      () => undefined,
      {} as never,
    );

    expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({
      exit_code: 7,
      stderr: "module missing\n",
    });
    expect(parseControlledToolReceipt(tested.receipts[0] ?? "").outcome).toBe("succeeded");
  });

  it("按模型预算保留 UTF-8 头尾并报告原始字节数", async () => {
    const raw = `${"头".repeat(20)}middle${"尾".repeat(20)}`;
    const tested = fixture({
      command: async () => ({ stdout: raw, stderr: "", exitCode: 0 }),
    } as unknown as SandboxHandle);

    const result = await tested.execute(
      "call_exec_truncated",
      { cmd: "produce", max_output_tokens: 10 },
      undefined,
      () => undefined,
      {} as never,
    );
    const parsed = JSON.parse(result.content[0]?.text ?? "");

    expect(parsed.output_truncated).toBe(true);
    expect(parsed.original_output_bytes).toBe(Buffer.byteLength(raw, "utf8"));
    expect(Buffer.byteLength(parsed.stdout, "utf8")).toBeLessThanOrEqual(40);
    expect(parsed.stdout).toContain("输出已截断");
    expect(parsed.stdout).toMatch(/^头/u);
    expect(parsed.stdout).toMatch(/尾$/u);
  });

  it("CubeSandbox 基础设施异常才产生 Tool Error，且不回显上游秘密", async () => {
    const tested = fixture({
      command: async () => {
        throw new SandboxRuntimeError("UPSTREAM", "API_KEY=secret");
      },
    } as unknown as SandboxHandle);

    await expect(
      tested.execute(
        "call_exec_upstream",
        { cmd: "false" },
        undefined,
        () => undefined,
        {} as never,
      ),
    ).rejects.toThrow(
      JSON.stringify({ code: "EXEC_UNAVAILABLE", message: "CubeSandbox 命令服务暂时不可用" }),
    );
    expect(parseControlledToolReceipt(tested.receipts[0] ?? "").outcome).toBe("failed");
  });

  it("连续三次命令数据面故障后熔断 Session，后续调用不再触碰 Sandbox", async () => {
    const command = vi.fn(async () => {
      throw new SandboxRuntimeError("UPSTREAM", "private upstream detail");
    });
    const tested = fixture({ command } as unknown as SandboxHandle);

    for (let index = 1; index <= 3; index += 1) {
      await expect(
        tested.execute(
          `call_exec_unavailable_${index}`,
          { cmd: "echo probe" },
          undefined,
          () => undefined,
          {} as never,
        ),
      ).rejects.toThrow("EXEC_UNAVAILABLE");
    }

    expect(tested.continuationRejected()).toBe(false);
    await expect(
      tested.execute(
        "call_exec_after_circuit",
        { cmd: "echo must-not-run" },
        undefined,
        () => undefined,
        {} as never,
      ),
    ).rejects.toThrow("EXEC_UNAVAILABLE");
    expect(command).toHaveBeenCalledTimes(3);
    expect(tested.authorizationCalls()).toBe(3);
  });

  it("命令成功会清零连续基础设施失败计数", async () => {
    const command = vi
      .fn()
      .mockRejectedValueOnce(new SandboxRuntimeError("UPSTREAM", "first"))
      .mockRejectedValueOnce(new SandboxRuntimeError("UPSTREAM", "second"))
      .mockResolvedValueOnce({ stdout: "ok", stderr: "", exitCode: 0 })
      .mockRejectedValueOnce(new SandboxRuntimeError("UPSTREAM", "third"));
    const tested = fixture({ command } as unknown as SandboxHandle);

    for (let index = 1; index <= 2; index += 1) {
      await expect(
        tested.execute(
          `call_exec_reset_failure_${index}`,
          { cmd: "echo probe" },
          undefined,
          () => undefined,
          {} as never,
        ),
      ).rejects.toThrow("EXEC_UNAVAILABLE");
    }
    await expect(
      tested.execute(
        "call_exec_reset_success",
        { cmd: "echo ok" },
        undefined,
        () => undefined,
        {} as never,
      ),
    ).resolves.toBeDefined();
    await expect(
      tested.execute(
        "call_exec_reset_new_failure",
        { cmd: "echo probe" },
        undefined,
        () => undefined,
        {} as never,
      ),
    ).rejects.toThrow("EXEC_UNAVAILABLE");

    expect(tested.continuationRejected()).toBe(false);
  });

  it("超时返回稳定 Tool Error 码和调用方期限", async () => {
    const tested = fixture({
      command: async () => {
        throw new SandboxRuntimeError("TIMEOUT", "upstream timeout details");
      },
    } as unknown as SandboxHandle);

    await expect(
      tested.execute(
        "call_exec_timeout",
        { cmd: "sleep 1", timeout_ms: 25 },
        undefined,
        () => undefined,
        {} as never,
      ),
    ).rejects.toThrow(JSON.stringify({ code: "EXEC_TIMEOUT", message: "命令执行超过 25 毫秒" }));
  });

  it("durable tool_result 未收敛时阻断下一模型轮次", async () => {
    const tested = fixture(
      {
        command: async () => ({ stdout: "not returned", stderr: "", exitCode: 0 }),
      } as unknown as SandboxHandle,
      "unknown",
    );

    await expect(
      tested.execute(
        "call_exec_unknown",
        { cmd: "echo test" },
        undefined,
        () => undefined,
        {} as never,
      ),
    ).rejects.toThrow("未能形成 durable 事实");
    expect(tested.continuationRejected()).toBe(true);
  });

  it("许可拒绝不触碰 Sandbox，并形成 durable 失败回执", async () => {
    let sandboxCalls = 0;
    const receipts: string[] = [];
    const observed = createObservedSandboxTools(
      {
        command: async () => {
          sandboxCalls += 1;
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      } as unknown as SandboxHandle,
      {
        authorizeToolEffect: async () => {
          throw new Error("DB private reason");
        },
      },
      (outputs) => ({
        record: async (call) => {
          const receipt = await outputs.readControlledReceipt(call);
          if (receipt === undefined) return { outcome: "conflict" as const };
          receipts.push(receipt);
          return { outcome: "recorded" as const, observation: receipt, isTruncated: false };
        },
      }),
    );
    const tool = observed.tools[0];
    if (tool === undefined) throw new Error("测试缺少 exec_command");

    await expect(
      (tool.execute as unknown as ToolExecute)(
        "call_exec_rejected",
        { cmd: "echo never" },
        undefined,
        () => undefined,
        {} as never,
      ),
    ).rejects.toThrow("EXEC_REJECTED");
    expect(sandboxCalls).toBe(0);
    expect(parseControlledToolReceipt(receipts[0] ?? "").outcome).toBe("failed");
  });
});

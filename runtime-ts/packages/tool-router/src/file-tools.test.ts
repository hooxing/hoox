import type { ExecutionPhaseTimingObserver } from "@hoox/domain";
import { parseControlledToolReceipt } from "@hoox/context-policy";
import type { SandboxHandle } from "@hoox/sandbox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { createObservedSandboxTools, createSandboxTools } from "./tools.js";

type ToolExecute = (
  id: string,
  input: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: () => void,
) => Promise<{
  content: Array<
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  >;
  details?: unknown;
}>;

function fixture(
  toolName: "read" | "edit" | "write",
  sandbox: SandboxHandle,
  authorize: () => Promise<{
    readonly consumedAtMonotonicMs: number;
    readonly maxContinuationDelayMs: number;
  }> = async () => immediateAuthorization(),
  phaseTiming?: ExecutionPhaseTimingObserver,
) {
  const receipts: string[] = [];
  const authorized: Array<{
    readonly callId: string;
    readonly toolName: string;
    readonly argsDigest: string;
  }> = [];
  const observed = createObservedSandboxTools(
    sandbox,
    {
      ...(phaseTiming === undefined ? {} : { phaseTiming }),
      authorizeToolEffect: async (call) => {
        authorized.push(call);
        return await authorize();
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
  const tool = observed.tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) throw new Error(`测试缺少 ${toolName}`);
  return {
    execute: tool.execute as unknown as ToolExecute,
    executionMode: tool.executionMode,
    parameters: tool.parameters,
    prepareArguments: tool.prepareArguments,
    receipts,
    authorized,
  };
}

describe("Sandbox 文件工具", () => {
  it("向 Provider 暴露与 Pi 一致的 read、edit、write 参数 schema", () => {
    const tools = createSandboxTools({} as never, {
      authorizeToolEffect: async () => immediateAuthorization(),
    });
    const schemas = Object.fromEntries(
      tools
        .filter((tool) => tool.name !== "exec_command")
        .map((tool) => [tool.name, JSON.parse(JSON.stringify(tool.parameters))]),
    );

    expect(schemas).toMatchInlineSnapshot(`
      {
        "edit": {
          "properties": {
            "edits": {
              "description": "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
              "items": {
                "properties": {
                  "newText": {
                    "description": "Replacement text for this targeted edit.",
                    "type": "string",
                  },
                  "oldText": {
                    "description": "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
                    "type": "string",
                  },
                },
                "required": [
                  "oldText",
                  "newText",
                ],
                "type": "object",
              },
              "type": "array",
            },
            "path": {
              "description": "Path to the file to edit (relative or absolute)",
              "type": "string",
            },
          },
          "required": [
            "path",
            "edits",
          ],
          "type": "object",
        },
        "read": {
          "properties": {
            "limit": {
              "description": "Maximum number of lines to read",
              "type": "number",
            },
            "offset": {
              "description": "Line number to start reading from (1-indexed)",
              "type": "number",
            },
            "path": {
              "description": "Path to the file to read (relative or absolute)",
              "type": "string",
            },
          },
          "required": [
            "path",
          ],
          "type": "object",
        },
        "write": {
          "properties": {
            "content": {
              "description": "Content to write to the file",
              "type": "string",
            },
            "path": {
              "description": "Path to the file to write (relative or absolute)",
              "type": "string",
            },
          },
          "required": [
            "path",
            "content",
          ],
          "type": "object",
        },
      }
    `);
  });

  it("合法工具调用按准备 Sandbox、签发许可、触碰文件系统的顺序执行", async () => {
    const operations: string[] = [];
    const sandbox = {
      command: async () => {
        operations.push("command");
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      writeFile: async () => {
        operations.push("write");
      },
    } as unknown as SandboxHandle;
    const prepareSandboxTool = vi.fn(async () => {
      operations.push("prepare");
      return sandbox;
    });
    const tools = createSandboxTools(
      { prepareSandboxTool },
      {
        authorizeToolEffect: async () => {
          operations.push("authorize");
          return immediateAuthorization();
        },
      },
    );
    const write = tools.find((tool) => tool.name === "write");
    if (write === undefined) throw new Error("测试缺少 write");

    await (write.execute as unknown as ToolExecute)(
      "call_lazy_write",
      { path: "result.txt", content: "done" },
      undefined,
      () => undefined,
    );

    expect(operations).toEqual(["prepare", "authorize", "command", "write"]);
    expect(prepareSandboxTool).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: "call_lazy_write",
        toolName: "write",
        argsDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
  });

  it("schema 错误不会触发按需 Sandbox 准备", async () => {
    const prepareSandboxTool = vi.fn(async () => {
      throw new Error("不应准备 Sandbox");
    });
    const authorizeToolEffect = vi.fn(async () => immediateAuthorization());
    const tools = createSandboxTools({ prepareSandboxTool }, { authorizeToolEffect });
    const write = tools.find((tool) => tool.name === "write");
    if (write?.prepareArguments === undefined) throw new Error("测试缺少 write 参数桥");
    const prepared = write.prepareArguments({ path: 123 });

    await expect(
      (write.execute as unknown as ToolExecute)(
        "call_invalid_lazy_write",
        prepared as Record<string, unknown>,
        undefined,
        () => undefined,
      ),
    ).rejects.toThrow("WRITE_INVALID_ARGUMENTS");
    expect(prepareSandboxTool).not.toHaveBeenCalled();
    expect(authorizeToolEffect).not.toHaveBeenCalled();
  });

  it("工具执行计时排除授权等待，诊断失败不阻止文件读取或 durable 回执", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const record = vi.fn(() => {
      throw new Error("diagnostic unavailable");
    });
    try {
      const tested = fixture(
        "read",
        {
          command: async () => {
            now += 3;
            return base64Result("ok");
          },
          readFile: async () => {
            now += 2;
            return "ok";
          },
        } as unknown as SandboxHandle,
        async () => {
          now += 100;
          return immediateAuthorization();
        },
        { record },
      );
      await expect(
        tested.execute("timed-read", { path: "input.txt" }, undefined, () => undefined),
      ).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "tool_execute",
          durationMs: 5,
          toolCallId: "timed-read",
          status: "succeeded",
        }),
      );
      expect(tested.receipts).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("read 支持相对路径、offset/limit，并返回继续读取提示", async () => {
    const command = vi.fn(async () => base64Result("line 1\nline 2\nline 3"));
    const readFile = vi.fn(async () => "line 1\nline 2\nline 3");
    const tested = fixture("read", { command, readFile } as unknown as SandboxHandle);

    const result = await tested.execute(
      "call_read_text",
      { path: "docs/input.txt", offset: 2, limit: 1 },
      undefined,
      () => undefined,
    );

    expect(tested.executionMode).toBe("sequential");
    expect(command).toHaveBeenCalledWith(
      expect.stringContaining("/workspace/docs/input.txt"),
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
    expect(readFile).toHaveBeenCalledWith(
      "/workspace/docs/input.txt",
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
    expect(result.content[0]).toEqual({
      type: "text",
      text: "line 2\n\n[1 more lines in file. Use offset=3 to continue.]",
    });
    expect(tested.authorized).toEqual([
      {
        callId: "call_read_text",
        toolName: "read",
        argsDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    ]);
    expect(parseControlledToolReceipt(tested.receipts[0] ?? "")).toMatchObject({
      toolName: "read",
      outcome: "succeeded",
    });
  });

  it("read 按 2000 行截断并给出下一 offset", async () => {
    const text = Array.from({ length: 2_001 }, (_, index) => `line ${index + 1}`).join("\n");
    const tested = fixture("read", {
      command: async () => base64Result(text.slice(0, 4_100)),
      readFile: async () => text,
    } as unknown as SandboxHandle);

    const result = await tested.execute(
      "call_read_lines",
      { path: "/workspace/large.txt" },
      undefined,
      () => undefined,
    );
    const output = textContent(result);

    expect(output).toContain("line 2000");
    expect(output).not.toContain("line 2001\n");
    expect(output).toContain("Use offset=2001 to continue");
  });

  it("read 不把 2000 行文件末尾换行误判为第 2001 行", async () => {
    const text = `${Array.from({ length: 2_000 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
    const tested = fixture("read", {
      command: async () => base64Result(text.slice(0, 4_100)),
      readFile: async () => text,
    } as unknown as SandboxHandle);

    const result = await tested.execute(
      "call_read_exact_lines",
      { path: "/workspace/exact.txt" },
      undefined,
      () => undefined,
    );

    expect(textContent(result)).toBe(text);
  });

  it("read 在不足 2000 行时仍按 50KB 截断完整行", async () => {
    const text = Array.from({ length: 600 }, (_, index) => `${index}: ${"x".repeat(100)}`).join(
      "\n",
    );
    const tested = fixture("read", {
      command: async () => base64Result(text.slice(0, 4_100)),
      readFile: async () => text,
    } as unknown as SandboxHandle);

    const result = await tested.execute(
      "call_read_bytes",
      { path: "/workspace/bytes.txt" },
      undefined,
      () => undefined,
    );

    expect(textContent(result)).toContain("(50KB limit)");
    expect(result.details).toMatchObject({ truncated: true, truncated_by: "bytes" });
  });

  it.each([
    { text: "", expected: "", truncated: false },
    { text: "x".repeat(51_200), expected: "x".repeat(51_200), truncated: false },
    {
      text: `${"x".repeat(51_200)}\n`,
      expected: `${"x".repeat(51_200)}\n\n[Showing lines 1-1 of 2. Use offset=2 to continue.]`,
      truncated: true,
      truncated_by: "lines",
    },
    {
      text: `${"你".repeat(17_066)}\n😀`,
      expected:
        `${"你".repeat(17_066)}\n\n[Showing lines 1-1 of 2 (50KB limit). ` +
        "Use offset=2 to continue.]",
      truncated: true,
      truncated_by: "bytes",
    },
    {
      text: "你".repeat(17_067),
      expected:
        "[Line 1 exceeds the 50KB read limit. " +
        "Use exec_command with a bounded byte-range command to inspect it.]",
      truncated: true,
      truncated_by: "bytes",
    },
  ])("read 保留字节边界与完整 UTF-8 行：用例 %#", async (input) => {
    const tested = fixture("read", {
      command: async () => base64Result(input.text.slice(0, 4_100)),
      readFile: async () => input.text,
    } as unknown as SandboxHandle);

    const result = await tested.execute(
      "call_read_boundary",
      { path: "/workspace/boundary.txt" },
      undefined,
      () => undefined,
    );

    expect(textContent(result)).toBe(input.expected);
    expect(result.details).toEqual({
      path: "/workspace/boundary.txt",
      start_line: 1,
      end_line: 1,
      total_lines: input.text.split("\n").length,
      truncated: input.truncated,
      ...(input.truncated_by === undefined ? {} : { truncated_by: input.truncated_by }),
    });
  });

  it("read 把受支持的图片作为附件返回，不把 Base64 放进 details", async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("test-image"),
    ]);
    const command = vi.fn(async () => base64Result(png));
    const readFile = vi.fn();
    const tested = fixture("read", { command, readFile } as unknown as SandboxHandle);

    const result = await tested.execute(
      "call_read_image",
      { path: "/workspace/chart.png" },
      undefined,
      () => undefined,
    );

    expect(command).toHaveBeenCalledTimes(2);
    expect(readFile).not.toHaveBeenCalled();
    expect(result.content).toEqual([
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    ]);
    expect(JSON.stringify(result.details)).not.toContain(png.toString("base64"));
  });

  it("edit 的多个替换都匹配原文件，并按反向位置一次写回", async () => {
    const writeFile = vi.fn(async () => undefined);
    const tested = fixture("edit", {
      readFile: async () => "alpha beta gamma",
      writeFile,
    } as unknown as SandboxHandle);

    const result = await tested.execute(
      "call_edit_multiple",
      {
        path: "source.txt",
        edits: [
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "gamma", newText: "GAMMA" },
        ],
      },
      undefined,
      () => undefined,
    );

    expect(writeFile).toHaveBeenCalledWith(
      "/workspace/source.txt",
      "ALPHA beta GAMMA",
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
    expect(textContent(result)).toContain("Successfully applied 2 replacement(s)");
    expect(parseControlledToolReceipt(tested.receipts[0] ?? "")).toMatchObject({
      toolName: "edit",
      outcome: "succeeded",
    });
  });

  it("edit 匹配时隐藏 BOM、统一换行，并在写回时恢复", async () => {
    const writeFile = vi.fn(async () => undefined);
    const tested = fixture("edit", {
      readFile: async () => "\uFEFFalpha\r\nbeta\r\n",
      writeFile,
    } as unknown as SandboxHandle);

    await tested.execute(
      "call_edit_line_endings",
      {
        path: "/workspace/windows.txt",
        edits: [{ oldText: "alpha\nbeta", newText: "ALPHA\nbeta" }],
      },
      undefined,
      () => undefined,
    );

    expect(writeFile).toHaveBeenCalledWith(
      "/workspace/windows.txt",
      "\uFEFFALPHA\r\nbeta\r\n",
      expect.any(Object),
    );
  });

  it("edit 拒绝没有产生变化的替换", async () => {
    const writeFile = vi.fn();
    const tested = fixture("edit", {
      readFile: async () => "unchanged",
      writeFile,
    } as unknown as SandboxHandle);

    await expect(
      tested.execute(
        "call_edit_no_change",
        {
          path: "/workspace/source.txt",
          edits: [{ oldText: "unchanged", newText: "unchanged" }],
        },
        undefined,
        () => undefined,
      ),
    ).rejects.toThrow("EDIT_NO_CHANGE");
    expect(writeFile).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "不唯一",
      original: "same and same",
      edits: [{ oldText: "same", newText: "changed" }],
      code: "EDIT_NOT_UNIQUE",
    },
    {
      label: "重叠出现且不唯一",
      original: "aaa",
      edits: [{ oldText: "aa", newText: "changed" }],
      code: "EDIT_NOT_UNIQUE",
    },
    {
      label: "重叠",
      original: "abcdef",
      edits: [
        { oldText: "abc", newText: "A" },
        { oldText: "bcd", newText: "B" },
      ],
      code: "EDIT_OVERLAP",
    },
    {
      label: "未匹配",
      original: "abcdef",
      edits: [{ oldText: "missing", newText: "changed" }],
      code: "EDIT_NO_MATCH",
    },
  ])("edit 拒绝$label的 oldText", async ({ original, edits, code }) => {
    const writeFile = vi.fn();
    const tested = fixture("edit", {
      readFile: async () => original,
      writeFile,
    } as unknown as SandboxHandle);

    await expect(
      tested.execute(
        `call_edit_${code}`,
        { path: "/workspace/source.txt", edits },
        undefined,
        () => undefined,
      ),
    ).rejects.toThrow(code);
    expect(writeFile).not.toHaveBeenCalled();
    expect(parseControlledToolReceipt(tested.receipts[0] ?? "").outcome).toBe("failed");
  });

  it("write 创建父目录后覆盖文件，并按 UTF-8 字节报告结果", async () => {
    const command = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const writeFile = vi.fn(async () => undefined);
    const tested = fixture("write", { command, writeFile } as unknown as SandboxHandle);

    const result = await tested.execute(
      "call_write",
      { path: "reports/a'b.txt", content: "中文" },
      undefined,
      () => undefined,
    );

    expect(command).toHaveBeenCalledWith(
      `mkdir -p -- '/workspace/reports'`,
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
    expect(writeFile).toHaveBeenCalledWith(
      "/workspace/reports/a'b.txt",
      "中文",
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
    expect(textContent(result)).toBe("Successfully wrote 6 bytes to reports/a'b.txt");
    expect(parseControlledToolReceipt(tested.receipts[0] ?? "")).toMatchObject({
      toolName: "write",
      outcome: "succeeded",
    });
  });

  it("write 对同一 Sandbox 路径的重叠修改立即返回 FILE_BUSY", async () => {
    let releaseFirst: () => void = () => undefined;
    let markFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let commandCalls = 0;
    const command = vi.fn(async () => {
      commandCalls += 1;
      if (commandCalls === 1) {
        markFirstStarted();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const writes: string[] = [];
    const sandbox = {
      command,
      writeFile: async (_path: string, content: string) => {
        writes.push(content);
      },
    } as unknown as SandboxHandle;
    const tested = fixture("write", sandbox);

    const first = tested.execute(
      "call_write_first",
      { path: "/workspace/shared.txt", content: "first" },
      undefined,
      () => undefined,
    );
    await firstStarted;
    const second = tested.execute(
      "call_write_second",
      { path: "/workspace/shared.txt", content: "second" },
      undefined,
      () => undefined,
    );
    await expect(second).rejects.toThrow('"code":"FILE_BUSY"');
    expect(tested.authorized.map((call) => call.callId)).toEqual(["call_write_first"]);
    releaseFirst();
    await first;
    expect(writes).toEqual(["first"]);
  });

  it.each(["read", "edit", "write"] as const)(
    "%s 的 schema 错误不申请许可或触碰 Sandbox，但形成失败回执",
    async (toolName) => {
      const sandboxOperation = vi.fn();
      const tested = fixture(toolName, {
        command: sandboxOperation,
        readFile: sandboxOperation,
        writeFile: sandboxOperation,
      } as unknown as SandboxHandle);
      if (tested.prepareArguments === undefined) throw new Error("测试缺少 schema 参数桥");
      const prepared = tested.prepareArguments({ path: 123 });

      expect(Value.Check(tested.parameters, prepared)).toBe(true);
      await expect(
        tested.execute(
          `call_invalid_${toolName}`,
          prepared as Record<string, unknown>,
          undefined,
          () => undefined,
        ),
      ).rejects.toThrow(`${toolName.toUpperCase()}_INVALID_ARGUMENTS`);
      expect(tested.authorized).toEqual([]);
      expect(sandboxOperation).not.toHaveBeenCalled();
      expect(parseControlledToolReceipt(tested.receipts[0] ?? "").outcome).toBe("failed");
    },
  );

  it("read 的非法 offset 在申请许可前失败", async () => {
    const command = vi.fn();
    const tested = fixture("read", { command } as unknown as SandboxHandle);

    await expect(
      tested.execute(
        "call_read_invalid_offset",
        { path: "/workspace/input.txt", offset: 1.5 },
        undefined,
        () => undefined,
      ),
    ).rejects.toThrow("READ_INVALID_ARGUMENTS");
    expect(tested.authorized).toEqual([]);
    expect(command).not.toHaveBeenCalled();
  });

  it("文件工具许可拒绝时不触碰 Sandbox，并阻断后续模型请求", async () => {
    const command = vi.fn();
    const readFile = vi.fn();
    const tested = fixture("read", { command, readFile } as unknown as SandboxHandle, async () => {
      throw new Error("private DB reason");
    });

    await expect(
      tested.execute(
        "call_read_rejected",
        { path: "/workspace/input.txt" },
        undefined,
        () => undefined,
      ),
    ).rejects.toThrow("READ_REJECTED");
    expect(command).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(parseControlledToolReceipt(tested.receipts[0] ?? "").outcome).toBe("failed");
  });
});

function immediateAuthorization() {
  return {
    consumedAtMonotonicMs: performance.now(),
    maxContinuationDelayMs: 1_000,
  };
}

function base64Result(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  return { stdout: bytes.toString("base64"), stderr: "", exitCode: 0 };
}

function textContent(result: Awaited<ReturnType<ToolExecute>>): string {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("测试结果缺少文本内容");
  return first.text;
}

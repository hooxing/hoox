import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createTodoWritePiTool } from "./todo-write-tool.js";

describe("todo_write Pi 工具", () => {
  it("提交完整清单并在 durable 回执后返回快照", async () => {
    const order: string[] = [];
    const tool = createTodoWritePiTool(
      {
        write: async ({ command }) => {
          order.push("write");
          return { schemaVersion: 1, version: 1, todos: command.todos };
        },
        projectError: () => ({
          status: "failed",
          code: "TODO_PERSISTENCE_UNAVAILABLE",
          message: "暂不可用",
          correctable: false,
          fatal: true,
        }),
      },
      async (_callId, toolName, outcome) => {
        order.push(`${toolName}:${outcome}`);
        return { outcome: "recorded", observation: "recorded", isTruncated: false };
      },
    );

    const result = await tool.execute(
      "call-todo",
      { todos: [{ id: "first", content: "第一步", status: "pending" }] },
      undefined,
      () => undefined,
      {} as never,
    );

    expect(tool.name).toBe("todo_write");
    expect(tool.executionMode).toBe("sequential");
    expect(order).toEqual(["write", "todo_write:succeeded"]);
    expect(JSON.stringify(result)).toContain('\\"version\\":1');
  });

  it("schema 级无效参数只形成失败回执", async () => {
    let writes = 0;
    const outcomes: string[] = [];
    const tool = createTodoWritePiTool(
      {
        write: async () => {
          writes += 1;
          throw new Error("不应执行");
        },
        projectError: () => ({
          status: "failed",
          code: "TODO_PERSISTENCE_UNAVAILABLE",
          message: "暂不可用",
          correctable: false,
          fatal: true,
        }),
      },
      async (_callId, _toolName, outcome) => {
        outcomes.push(outcome);
        return { outcome: "recorded", observation: "recorded", isTruncated: false };
      },
    );
    if (tool.prepareArguments === undefined) throw new Error("测试缺少 schema 参数桥");

    const prepared = tool.prepareArguments({ todos: [] });
    expect(Value.Check(tool.parameters, prepared)).toBe(true);
    await expect(
      tool.execute("call-invalid", prepared, undefined, () => undefined, {} as never),
    ).rejects.toThrow("TODO_ARGUMENTS_INVALID");
    expect(writes).toBe(0);
    expect(outcomes).toEqual(["failed"]);
  });

  it("持久化未知会先记录失败再阻止模型继续", async () => {
    const order: string[] = [];
    const tool = createTodoWritePiTool(
      {
        write: async () => {
          throw new Error("unknown");
        },
        projectError: () => ({
          status: "failed",
          code: "TODO_PERSISTENCE_UNAVAILABLE",
          message: "任务清单暂时无法保存",
          correctable: false,
          fatal: true,
        }),
      },
      async (_callId, _toolName, outcome) => {
        order.push(`receipt:${outcome}`);
        return { outcome: "recorded", observation: "recorded", isTruncated: false };
      },
      () => order.push("continuation:rejected"),
    );

    await expect(
      tool.execute(
        "call-failed",
        { todos: [{ id: "first", content: "第一步", status: "pending" }] },
        undefined,
        () => undefined,
        {} as never,
      ),
    ).rejects.toThrow("TODO_PERSISTENCE_UNAVAILABLE");
    expect(order).toEqual(["receipt:failed", "continuation:rejected"]);
  });
});

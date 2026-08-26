import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  AutomationUpdateToolArgumentsSchema,
  automationToolMutation,
  createAutomationUpdatePiTool,
} from "./automation-update-tool.js";

const task = {
  id: "automation_1",
  tenantId: "tenant_1",
  ownerUserId: "user_1",
  sourceThreadId: "thread_1",
  targetThreadId: "thread_1",
  name: "日报",
  instruction: "生成日报",
  timezone: "Asia/Shanghai",
  status: "active" as const,
  overlapPolicy: "coalesce" as const,
  nextRunAt: "2026-08-18T01:00:00.000Z",
  currentRevision: 1,
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
};

describe("automation_update Pi 工具", () => {
  it("向 Provider 暴露顶层 object schema，并保留 action 分支严格校验", () => {
    expect((AutomationUpdateToolArgumentsSchema as { type?: unknown }).type).toBe("object");
    expect(Value.Check(AutomationUpdateToolArgumentsSchema, { action: "create" })).toBe(false);
  });

  it("创建 schema 允许省略时区", () => {
    expect(
      Value.Check(AutomationUpdateToolArgumentsSchema, {
        action: "create",
        name: "日报",
        instruction: "生成日报",
        first_run_at: "2026-08-18T09:00:00.000+08:00",
      }),
    ).toBe(true);
  });

  it("把创建请求绑定到当前 Thread、默认使用东八区并在 durable 回执后返回", async () => {
    const order: string[] = [];
    const tool = createAutomationUpdatePiTool(
      {
        apply: async ({ arguments: args }) => {
          order.push("apply");
          expect(automationToolMutation(args, "thread_1")).toMatchObject({
            action: "create",
            sourceThreadId: "thread_1",
            targetThreadId: "thread_1",
            timezone: "Asia/Shanghai",
          });
          return task;
        },
        projectError: () => ({
          status: "failed",
          code: "FAILED",
          message: "失败",
          correctable: false,
          fatal: true,
        }),
      },
      async (_callId, name, outcome) => {
        order.push(`${name}:${outcome}`);
        return { outcome: "recorded", observation: "recorded", isTruncated: false };
      },
    );
    const result = await tool.execute(
      "call_1",
      {
        action: "create",
        name: "日报",
        instruction: "生成日报",
        first_run_at: "2026-08-18T09:00:00.000+08:00",
      },
      undefined,
      () => undefined,
      {} as never,
    );
    expect(order).toEqual(["apply", "automation_update:succeeded"]);
    expect(JSON.stringify(result)).toContain("automation_1");
  });

  it("创建请求显式指定时区时保留调用方选择", () => {
    expect(
      automationToolMutation(
        {
          action: "create",
          name: "纽约提醒",
          instruction: "发送提醒",
          first_run_at: "2026-08-18T09:00:00.000-04:00",
          timezone: "America/New_York",
        },
        "thread_1",
      ),
    ).toMatchObject({ timezone: "America/New_York" });
  });

  it("schema 无效时不触发写入并形成失败回执", async () => {
    let writes = 0;
    const tool = createAutomationUpdatePiTool(
      {
        apply: async () => {
          writes += 1;
          return task;
        },
        projectError: () => ({
          status: "failed",
          code: "FAILED",
          message: "失败",
          correctable: false,
          fatal: true,
        }),
      },
      async () => ({ outcome: "recorded", observation: "recorded", isTruncated: false }),
    );
    if (tool.prepareArguments === undefined) throw new Error("缺少参数桥");
    const prepared = tool.prepareArguments({ action: "create", name: "" });
    expect(Value.Check(tool.parameters, prepared)).toBe(true);
    await expect(
      tool.execute("call_bad", prepared, undefined, () => undefined, {} as never),
    ).rejects.toThrow("AUTOMATION_ARGUMENTS_INVALID");
    expect(writes).toBe(0);
  });
});

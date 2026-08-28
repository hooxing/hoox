import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  AutomationUpdateArgumentError,
  AutomationUpdateToolArgumentsSchema,
  AutomationUpdateToolProviderSchema,
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

const recorded = async () => ({
  outcome: "recorded" as const,
  observation: "recorded",
  isTruncated: false,
});

async function rejectedFailure(operation: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await operation;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return JSON.parse(error.message) as Record<string, unknown>;
  }
  throw new Error("预期工具失败");
}

describe("automation_update Pi 工具", () => {
  it("向 Provider 暴露无顶层 anyOf 的 object schema，并保留 Runtime action 严格校验", () => {
    expect((AutomationUpdateToolProviderSchema as { type?: unknown }).type).toBe("object");
    expect("anyOf" in AutomationUpdateToolProviderSchema).toBe(false);
    expect(Value.Check(AutomationUpdateToolProviderSchema, { action: "create" })).toBe(true);
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
        return recorded();
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

  it("Provider 参数桥接受省略可选字段、显式时区和 RRULE 三种合规创建请求", async () => {
    let writes = 0;
    const tool = createAutomationUpdatePiTool(
      {
        apply: async ({ arguments: args }) => {
          writes += 1;
          automationToolMutation(args, "thread_1");
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
      recorded,
    );
    if (tool.prepareArguments === undefined) throw new Error("缺少参数桥");
    const inputs = [
      {
        action: "create",
        name: "一次性提醒",
        instruction: "发送提醒",
        first_run_at: "2026-08-28T12:30:00Z",
      },
      {
        action: "create",
        name: "上海提醒",
        instruction: "发送提醒",
        first_run_at: "2026-08-28T20:30:00+08:00",
        timezone: "Asia/Shanghai",
      },
      {
        action: "create",
        name: "周期提醒",
        instruction: "发送提醒",
        first_run_at: "2026-08-28T20:30:00+08:00",
        rrule: "FREQ=MINUTELY;INTERVAL=5",
      },
    ];
    for (const [index, input] of inputs.entries()) {
      const prepared = tool.prepareArguments(input);
      await tool.execute(
        `call_valid_${String(index)}`,
        prepared,
        undefined,
        () => undefined,
        {} as never,
      );
    }
    expect(writes).toBe(3);
  });

  it("创建请求显式指定时区时保留调用方选择并规范化时间与 RRULE", () => {
    expect(
      automationToolMutation(
        {
          action: "create",
          name: "纽约提醒",
          instruction: "发送提醒",
          first_run_at: "2026-08-18T09:00:00.000-04:00",
          timezone: "America/New_York",
          rrule: "freq=daily;interval=2",
        },
        "thread_1",
      ),
    ).toMatchObject({
      timezone: "America/New_York",
      firstRunAt: "2026-08-18T13:00:00.000Z",
      rrule: "FREQ=DAILY;INTERVAL=2",
    });
  });

  it("schema 无效时不触发写入，并返回字段级可纠正详情", async () => {
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
      recorded,
    );
    if (tool.prepareArguments === undefined) throw new Error("缺少参数桥");
    const prepared = tool.prepareArguments({ action: "create", name: "" });
    expect(Value.Check(tool.parameters, prepared)).toBe(true);
    const failure = await rejectedFailure(
      tool.execute("call_bad", prepared, undefined, () => undefined, {} as never),
    );
    expect(failure).toMatchObject({
      code: "AUTOMATION_ARGUMENTS_INVALID",
      correctable: true,
      fatal: false,
      details: expect.arrayContaining([
        { field: "name", reason: "长度不能少于 1 个字符" },
        { field: "instruction", reason: "缺少必填字段" },
        { field: "first_run_at", reason: "缺少必填字段" },
      ]),
    });
    expect(writes).toBe(0);
  });

  it("字段值未通过领域校验时保留字段与原因", () => {
    expect(() =>
      automationToolMutation(
        {
          action: "create",
          name: "提醒",
          instruction: "发送提醒",
          first_run_at: "2026-08-28T12:30:00",
          timezone: "Mars/Base",
        },
        "thread_1",
      ),
    ).toThrow(AutomationUpdateArgumentError);
    try {
      automationToolMutation(
        {
          action: "create",
          name: "提醒",
          instruction: "发送提醒",
          first_run_at: "2026-08-28T12:30:00",
        },
        "thread_1",
      );
    } catch (error) {
      expect(error).toMatchObject({
        code: "AUTOMATION_ARGUMENT_VALUE_INVALID",
        details: [{ field: "first_run_at", reason: "首次执行时间必须携带时区偏移" }],
      });
    }
  });
});

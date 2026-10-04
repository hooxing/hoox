import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { RuntimeAgentEvent } from "./events.js";
import { projectToolPresentation } from "./events.js";
import { buildPtcSdk, createPtcTool } from "./ptc-tools.js";

function harness(
  options: { failPrepare?: boolean; failReceipt?: boolean; timeoutMs?: number } = {},
) {
  const facts: string[] = [];
  const parents: string[] = [];
  let unsafe = false;
  const schema = Type.Object({ value: Type.Number() }, { additionalProperties: false });
  const tool: AgentTool<typeof schema> = {
    name: "sample",
    label: "测试工具",
    description: "返回结构化测试数据",
    parameters: schema,
    execute: async (id, args, signal) => {
      facts.push(`effect:${id}`);
      if (args.value === -1) throw new Error("private-provider-error");
      if (args.value === -2) {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        facts.push(`settled:${id}`);
      }
      return { content: [{ type: "text", text: "middle-data" }], details: { value: args.value } };
    },
  };
  const wrapper = createPtcTool({
    tools: [tool],
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    emit: (event) => facts.push(`${event.type}:${event.callId}`),
    prepareProgram: async (id) => {
      facts.push(`parent:${id}`);
    },
    prepareTool: async (call) => {
      facts.push(`durable:${call.callId}`);
      parents.push(call.parentCallId);
      if (options.failPrepare) {
        unsafe = true;
        throw new Error("unknown-start");
      }
    },
    ensureReceipt: async (id) => {
      facts.push(`receipt:${id}`);
      if (options.failReceipt) {
        unsafe = true;
        throw new Error("unknown-receipt");
      }
    },
    recordProgramReceipt: async (id, _name, outcome) => {
      facts.push(`program:${id}:${outcome}`);
      return { outcome: "recorded", observation: "固定回执", isTruncated: false };
    },
    assertContinuationAllowed: () => {
      if (unsafe) throw new Error("recovery-required");
    },
  });
  return { wrapper, tool, facts, parents };
}

describe("PTC 受控工具包装", () => {
  it("SDK 对工具顺序和 Schema 键顺序稳定，不包含请求上下文", () => {
    const { tool } = harness();
    const other = {
      ...tool,
      name: "other",
      parameters: Type.Object({ a: Type.String(), b: Type.Number() }),
    };
    const reordered = { ...other, parameters: Type.Object({ b: Type.Number(), a: Type.String() }) };
    expect(buildPtcSdk([tool, other])).toBe(buildPtcSdk([reordered, tool]));
    expect(buildPtcSdk([tool])).not.toMatch(/threadId|runId|attemptId/);
  });
  it("真实 VM 筛选结果；内部 started 先于持久开始与副作用且单独闭合", async () => {
    const { wrapper, facts, parents } = harness();
    const result = await wrapper.execute("parent", {
      code: "const values=[]; for (const value of [1,2,3]) { const r=await tools.sample({value}); if(r.details.value>1) values.push(r.details.value); } console.log(values); return values;",
    });
    const output = JSON.parse((result.content[0] as { text: string }).text);
    expect(output.value).toEqual([2, 3]);
    expect(output.logs).toHaveLength(1);
    expect(parents).toEqual(["parent", "parent", "parent"]);
    const ids = facts.filter((x) => x.startsWith("durable:")).map((x) => x.slice(8));
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(facts.indexOf(`tool.started:${id}`)).toBeLessThan(facts.indexOf(`durable:${id}`));
      expect(facts.indexOf(`durable:${id}`)).toBeLessThan(facts.indexOf(`effect:${id}`));
      expect(facts.indexOf(`effect:${id}`)).toBeLessThan(facts.indexOf(`receipt:${id}`));
      expect(facts.indexOf(`receipt:${id}`)).toBeLessThan(facts.indexOf(`tool.completed:${id}`));
    }
    expect(facts.at(-1)).toBe("program:parent:succeeded");
  });
  it("普通工具失败可捕获，参数失败也有独立回执但不执行工具", async () => {
    const { wrapper, facts } = harness();
    const result = await wrapper.execute("parent", {
      code: 'try { await tools.sample({value:-1}); } catch(e) { console.log(e.message); } try { await tools.sample({value:"invalid"}); } catch {} return 1;',
    });
    expect(JSON.stringify(result)).not.toContain("private-provider-error");
    expect(facts.filter((x) => x.startsWith("effect:"))).toHaveLength(1);
    expect(facts.filter((x) => x.startsWith("receipt:"))).toHaveLength(2);
    expect(facts.at(-1)).toBe("program:parent:succeeded");
  });
  it.each(["failPrepare", "failReceipt"] as const)(
    "%s 未知不可被 guest catch 后继续产生副作用",
    async (key) => {
      const { wrapper, facts } = harness({ [key]: true });
      await expect(
        wrapper.execute("parent", {
          code: 'try { await tools.sample({value:1}); } catch {} try { await tools.sample({value:2}); } catch {} return "pretend-ok";',
        }),
      ).rejects.toThrow();
      expect(facts.filter((x) => x.startsWith("effect:"))).toHaveLength(
        key === "failPrepare" ? 0 : 1,
      );
      expect(facts.at(-1)).toBe("program:parent:failed");
    },
  );
  it("参数准备期间取消，不进入底层 execute 但闭合内部失败事实", async () => {
    const { wrapper, tool, facts } = harness();
    const abort = new AbortController();
    tool.prepareArguments = () => {
      queueMicrotask(() => abort.abort());
      return { value: 1 };
    };
    await expect(
      wrapper.execute("parent", { code: "await tools.sample({value:1});" }, abort.signal),
    ).rejects.toThrow();
    expect(facts.filter((x) => x.startsWith("effect:"))).toHaveLength(0);
    expect(facts.filter((x) => x.startsWith("receipt:"))).toHaveLength(1);
    expect(facts.at(-1)).toBe("program:parent:failed");
  });
  it("非法外层参数穿过 Pi 参数准备后记录失败，不执行占位程序", async () => {
    const { wrapper, facts } = harness();
    const args = await wrapper.prepareArguments?.({ code: 42 });
    if (args === undefined) throw new Error("缺少参数准备");
    await expect(wrapper.execute("parent", args)).rejects.toThrow("Schema");
    expect(facts).toEqual(["parent:parent", "program:parent:failed"]);
  });
  it("超时取消传给在途工具，收束后才写外层失败且不启动队列", async () => {
    const { wrapper, facts } = harness({ timeoutMs: 50 });
    await expect(
      wrapper.execute("parent", {
        code: "await tools.sample({value:-2}); await tools.sample({value:2});",
      }),
    ).rejects.toThrow();
    expect(facts.filter((x) => x.startsWith("effect:"))).toHaveLength(1);
    expect(facts.some((x) => x.startsWith("settled:"))).toBe(true);
    expect(facts.at(-1)).toBe("program:parent:failed");
  });
});

describe("PTC 子调用的用户展示", () => {
  function presentationHarness() {
    const events: RuntimeAgentEvent[] = [];
    const schema = Type.Object(
      {
        path: Type.Optional(Type.String()),
        cmd: Type.Optional(Type.String()),
        user_facing_purpose: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    );
    const tools: AgentTool[] = ["read", "exec_command", "todo_write"].map((name) => ({
      name,
      label: name,
      description: "测试工具",
      parameters: schema,
      execute: async () => {
        if (name === "read")
          throw new Error(
            JSON.stringify({ code: "READ_NOT_FOUND", message: "private-host-secret" }),
          );
        return {
          content: [{ type: "text", text: "private-tool-output" }],
          details: { exit_code: 7 },
        };
      },
    }));
    const wrapper = createPtcTool({
      tools,
      emit: (event) => events.push(event),
      prepareProgram: async () => {},
      prepareTool: async () => {},
      ensureReceipt: async () => {},
      recordProgramReceipt: async () => ({
        outcome: "recorded",
        observation: "固定回执",
        isTruncated: false,
      }),
      assertContinuationAllowed: () => {},
    });
    return { wrapper, events };
  }
  it("真实 VM 子调用与正常模式共用摘要，失败可捕获且不被外层成功抹除", async () => {
    const { wrapper, events } = presentationHarness();
    const result = await wrapper.execute("parent", {
      code: 'let failure; try { await tools.read({path:"/workspace/reports/missing.md"}); } catch(e) { failure={code:e.code,toolName:e.toolName,message:e.message}; } const command=await tools.exec_command({cmd:"private-command",user_facing_purpose:"检查环境"}); await tools.todo_write({}); return {failure,exit_code:command.details.exit_code};',
    });
    const output = JSON.parse((result.content[0] as { text: string }).text).value;
    expect(output).toEqual({
      failure: {
        code: "READ_NOT_FOUND",
        toolName: "read",
        message: "指定文件或目录不存在，请检查路径",
      },
      exit_code: 7,
    });
    const starts = events.filter((event) => event.type === "tool.started");
    expect(starts).toHaveLength(3);
    expect(starts[0]).toMatchObject({
      name: "read",
      parentCallId: "parent",
      presentation: projectToolPresentation("read", { path: "/workspace/reports/missing.md" }),
    });
    expect(starts[1]).toMatchObject({
      name: "exec_command",
      parentCallId: "parent",
      presentation: projectToolPresentation("exec_command", { user_facing_purpose: "检查环境" }),
    });
    expect(starts[2]).toMatchObject({
      name: "todo_write",
      presentation: { action: "other", title: "更新任务清单" },
    });
    expect(events.filter((event) => event.type === "tool.completed")).toMatchObject([
      {
        name: "read",
        isError: true,
        failure: { code: "READ_NOT_FOUND", message: "指定文件或目录不存在，请检查路径" },
      },
      { name: "exec_command", isError: false },
      { name: "todo_write", isError: false },
    ]);
    expect(JSON.stringify(events)).not.toMatch(
      /private-command|private-host-secret|private-tool-output/,
    );
  });
  it("参数拒绝也带安全错误码与独立终态", async () => {
    const { wrapper, events } = presentationHarness();
    const result = await wrapper.execute("parent", {
      code: "try { await tools.read({path:42}); } catch(e) { return {code:e.code,toolName:e.toolName}; }",
    });
    expect(JSON.parse((result.content[0] as { text: string }).text).value).toEqual({
      code: "PTC_TOOL_INVALID_ARGUMENTS",
      toolName: "read",
    });
    expect(events.at(-1)).toMatchObject({
      type: "tool.completed",
      name: "read",
      isError: true,
      failure: { code: "PTC_TOOL_INVALID_ARGUMENTS" },
    });
  });
});

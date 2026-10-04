import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
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

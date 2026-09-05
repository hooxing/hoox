import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { createAgentControlPiTools } from "./agent-control-tools.js";

function tools() {
  const spawn = vi.fn(async (input) => ({ path: "/root/agent_1", ...input }));
  const record = vi.fn(async () => ({
    outcome: "recorded" as const,
    observation: "recorded",
    isTruncated: false,
  }));
  const list = vi.fn(async () => []);
  const wait = vi.fn(async () => ({ updates: [], nextAfterSequence: 0, timedOut: true }));
  const created = createAgentControlPiTools(
    {
      spawn,
      sendMessage: async () => undefined,
      followUp: async () => ({}),
      interrupt: async () => ({}),
      list,
      wait,
      projectError: (error) => ({
        status: "failed",
        code: "AGENT_CONTROL_FAILED",
        message: error instanceof Error ? error.message : "失败",
        correctable: true,
        fatal: false,
      }),
    },
    record,
  );
  return { created, spawn, list, wait, record };
}

describe("SubAgent Pi 协作工具", () => {
  it("wait_agent 将 AgentTool 的第三参数作为取消信号传入控制面", async () => {
    const tested = tools();
    const wait = tested.created.find((tool) => tool.name === "wait_agent");
    if (wait === undefined) throw new Error("测试缺少 wait_agent");
    const controller = new AbortController();

    await wait.execute("call_wait_signal", { after_sequence: 7 }, controller.signal);

    expect(tested.wait).toHaveBeenCalledWith({
      afterSequence: 7,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
  });

  it("只向 root 提供六个控制面工具，并由 spawn_agent 显式选择 child 工具", async () => {
    const tested = tools();
    expect(tested.created.map((tool) => tool.name)).toEqual([
      "spawn_agent",
      "send_message",
      "followup_task",
      "wait_agent",
      "interrupt_agent",
      "list_agents",
    ]);
    expect(tested.created.map((tool) => tool.executionMode)).toEqual(Array(6).fill("sequential"));
    expect(tested.created.find((tool) => tool.name === "wait_agent")?.description).toContain(
      "序号可以跳跃，空洞不表示丢消息",
    );
    const spawn = tested.created[0];
    if (spawn?.name !== "spawn_agent") throw new Error("测试缺少 spawn_agent");
    const result = await spawn.execute("call_spawn", {
      task: "分析模块",
      tools: ["read", "read", "exec_command"],
      fork_turns: "3",
    });

    expect(tested.spawn).toHaveBeenCalledWith({
      callId: "call_spawn",
      task: "分析模块",
      tools: ["read", "exec_command"],
      forkTurns: 3,
    });
    expect(JSON.stringify(result)).toContain("/root/agent_1");
    expect(tested.record).toHaveBeenCalledWith("call_spawn", "spawn_agent", "succeeded");
  });

  it("控制面失败先写 durable 失败回执，再把稳定错误交给模型", async () => {
    const tested = tools();
    tested.spawn.mockRejectedValueOnce(new Error("AGENT_CAPACITY_EXCEEDED"));
    const spawn = tested.created[0];
    if (spawn?.name !== "spawn_agent") throw new Error("测试缺少 spawn_agent");

    await expect(
      spawn.execute("call_spawn_full", { task: "分析模块", tools: ["read"], fork_turns: "none" }),
    ).rejects.toThrow("AGENT_CONTROL_FAILED");
    expect(tested.record).toHaveBeenCalledWith("call_spawn_full", "spawn_agent", "failed");
  });

  it("fork_turns 缺失时由 schema 桥拒绝，不再隐式继承全部历史", async () => {
    const tested = tools();
    const spawn = tested.created[0];
    if (spawn?.name !== "spawn_agent" || spawn.prepareArguments === undefined) {
      throw new Error("测试缺少 spawn_agent schema 参数桥");
    }
    const prepared = spawn.prepareArguments({ task: "分析模块", tools: ["read"] });
    expect(Value.Check(spawn.parameters, prepared)).toBe(true);

    await expect(
      spawn.execute("call_spawn_missing_fork", structuredClone(prepared) as SpawnArgumentsForTest),
    ).rejects.toThrow("AGENT_CONTROL_FAILED");
    expect(tested.spawn).not.toHaveBeenCalled();
  });

  it("wait_agent 必须显式传入游标，避免遗漏后重复读取历史消息", async () => {
    const tested = tools();
    const wait = tested.created.find((tool) => tool.name === "wait_agent");
    if (wait?.name !== "wait_agent" || wait.prepareArguments === undefined) {
      throw new Error("测试缺少 wait_agent schema 参数桥");
    }
    const prepared = wait.prepareArguments({ timeout_ms: 1_000 });
    expect(Value.Check(wait.parameters, prepared)).toBe(true);

    await expect(
      wait.execute("call_wait_missing_cursor", structuredClone(prepared) as WaitArgumentsForTest),
    ).rejects.toThrow("AGENT_CONTROL_FAILED");
    expect(tested.record).toHaveBeenCalledWith("call_wait_missing_cursor", "wait_agent", "failed");
  });
  it("同批合法与非法的无字符串参数调用不会互相错认", async () => {
    const tested = tools();
    const wait = tested.created.find((tool) => tool.name === "wait_agent");
    const list = tested.created.find((tool) => tool.name === "list_agents");
    if (
      wait?.name !== "wait_agent" ||
      wait.prepareArguments === undefined ||
      list?.name !== "list_agents" ||
      list.prepareArguments === undefined
    ) {
      throw new Error("测试缺少 wait_agent/list_agents schema 参数桥");
    }

    const validWait = structuredClone(
      wait.prepareArguments({ after_sequence: 0, timeout_ms: 1 }),
    ) as WaitArgumentsForTest;
    const invalidWait = structuredClone(
      wait.prepareArguments({ timeout_ms: 1 }),
    ) as WaitArgumentsForTest;
    const validList = structuredClone(list.prepareArguments({})) as EmptyArgumentsForTest;
    const invalidList = structuredClone(
      list.prepareArguments({ unexpected: true }),
    ) as EmptyArgumentsForTest;

    await expect(wait.execute("call_wait_valid_first", validWait)).resolves.toBeDefined();
    await expect(wait.execute("call_wait_invalid_second", invalidWait)).rejects.toThrow(
      "AGENT_CONTROL_FAILED",
    );
    await expect(list.execute("call_list_valid_first", validList)).resolves.toBeDefined();
    await expect(list.execute("call_list_invalid_second", invalidList)).rejects.toThrow(
      "AGENT_CONTROL_FAILED",
    );

    expect(tested.wait).toHaveBeenCalledTimes(1);
    expect(tested.list).toHaveBeenCalledTimes(1);
  });
  it("schema 错误不调用控制面，但仍形成 durable 失败回执", async () => {
    const tested = tools();
    const spawn = tested.created[0];
    if (spawn?.name !== "spawn_agent" || spawn.prepareArguments === undefined) {
      throw new Error("测试缺少 spawn_agent schema 参数桥");
    }
    const prepared = spawn.prepareArguments({ task: 123, tools: ["read"], fork_turns: "none" });
    expect(Value.Check(spawn.parameters, prepared)).toBe(true);

    await expect(
      spawn.execute("call_spawn_invalid", structuredClone(prepared) as SpawnArgumentsForTest),
    ).rejects.toThrow("AGENT_CONTROL_FAILED");
    expect(tested.spawn).not.toHaveBeenCalled();
    expect(tested.record).toHaveBeenCalledWith("call_spawn_invalid", "spawn_agent", "failed");
  });
});

type SpawnArgumentsForTest = {
  readonly task: string;
  readonly tools: ("exec_command" | "read" | "edit" | "write" | "skill")[];
  readonly fork_turns: string;
};

type WaitArgumentsForTest = {
  readonly after_sequence: number;
  readonly timeout_ms?: number;
};

type EmptyArgumentsForTest = {
  readonly runtime_invalid_arguments_token?: string;
};

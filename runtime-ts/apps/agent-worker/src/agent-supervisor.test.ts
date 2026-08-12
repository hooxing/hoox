import {
  agentThreadId,
  isoTimestamp,
  runId,
  tenantId,
  threadId,
  workspaceId,
} from "@cube-runtime/domain";
import {
  type RuntimeAgentEvent,
  type ThreadActiveHistoryV1,
  threadActiveHistoryDigest,
} from "@cube-runtime/pi-adapter";
import { describe, expect, it, vi } from "vitest";
import { AgentSupervisor } from "./agent-supervisor.js";
import { digestCanonical } from "./mutation-protocol.js";
import type {
  AgentControlPersistencePort,
  ConsumedExternalEffectAuthorization,
  ExecutionFence,
  WorkerAgentSessionPort,
} from "./ports.js";

const scope = {
  tenantId: tenantId("tenant_agent_supervisor"),
  threadId: threadId("thread_agent_supervisor"),
  runId: runId("run_agent_supervisor"),
  rootRunId: runId("run_agent_supervisor"),
  workspaceId: workspaceId("workspace_agent_supervisor"),
} as const;
const fence: ExecutionFence = {
  scope,
  runClaim: {
    token: "claim_agent_supervisor",
    epoch: 1,
    expiresAt: isoTimestamp("2030-01-01T00:00:00.000Z"),
  },
  workspaceLease: {
    rootRunId: scope.rootRunId,
    epoch: 1,
    expiresAt: isoTimestamp("2030-01-01T00:00:00.000Z"),
  },
};

function parentHistory(): ThreadActiveHistoryV1 {
  const unsigned = {
    schemaVersion: 1 as const,
    projectionSchemaVersion: 1 as const,
    throughSequence: 4,
    messages: Object.freeze([
      { sequence: 1, role: "user" as const, text: "旧问题", timestamp: 1 },
      {
        sequence: 2,
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "旧答案" }],
        api: "test",
        provider: "test",
        model: "test",
        stopReason: "stop" as const,
        timestamp: 2,
      },
      { sequence: 3, role: "user" as const, text: "新问题", timestamp: 3 },
      {
        sequence: 4,
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "新答案" }],
        api: "test",
        provider: "test",
        model: "test",
        stopReason: "stop" as const,
        timestamp: 4,
      },
    ]),
  };
  return Object.freeze({ ...unsigned, digest: threadActiveHistoryDigest(unsigned) });
}

function persistence(): AgentControlPersistencePort {
  let mailboxSequence = 0;
  const spawned = new Map<
    string,
    Parameters<AgentControlPersistencePort["spawn"]>[0]["snapshot"]
  >();
  const followUps = new Set<string>();
  const mailbox = new Map<string, number>();
  const commands = new Set<string>();
  return {
    initializeRoot: async () => ({ outcome: "ready", conversations: [] }),
    spawn: async (input) => {
      const previous = spawned.get(input.commandId);
      if (previous !== undefined) return { outcome: "replayed", snapshot: previous };
      spawned.set(input.commandId, input.snapshot);
      return { outcome: "created", snapshot: input.snapshot };
    },
    queueFollowUp: async (input) => {
      if (followUps.has(input.commandId)) return "replayed";
      followUps.add(input.commandId);
      return "created";
    },
    startTurn: async () => "started",
    settleTurn: async () => "settled",
    appendMailbox: async (input) => {
      const previous = mailbox.get(input.commandId);
      if (previous !== undefined) return { outcome: "replayed", sequence: previous };
      const sequence = ++mailboxSequence;
      mailbox.set(input.commandId, sequence);
      return { outcome: "created", sequence };
    },
    recordCommand: async (input) => {
      const key = `${input.callerAgentThreadId}:${input.commandId}`;
      if (commands.has(key)) return "replayed";
      commands.add(key);
      return "recorded";
    },
  };
}

function completedSession(
  answer: string,
  beforeComplete?: RuntimeAgentEvent,
): WorkerAgentSessionPort {
  const listeners = new Set<(event: RuntimeAgentEvent) => void>();
  return {
    prepareInput: async (input) => ({ text: input.text, images: [] }),
    runPrompt: async () => {
      if (beforeComplete !== undefined) {
        for (const listener of listeners) listener(beforeComplete);
      }
      for (const listener of listeners) {
        listener({
          type: "turn.completed",
          assistant: {
            content: [{ type: "text", text: answer }],
            api: "test",
            provider: "test",
            model: "test",
            stopReason: "stop",
            timestamp: 10,
          },
          toolResults: [],
        });
      }
      return { kind: "completed" };
    },
    steer: async () => undefined,
    abort: async () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => undefined,
  };
}

const authorization = {} as ConsumedExternalEffectAuthorization;

describe("AgentSupervisor", () => {
  it("按父 Agent 选择的工具和最近 N turn 创建独立 Session，并通过 mailbox 交付", async () => {
    const created: Parameters<
      ConstructorParameters<typeof AgentSupervisor>[0]["createSession"]
    >[0][] = [];
    const supervisor = new AgentSupervisor({
      persistence: persistence(),
      rootAgentThreadId: agentThreadId("root_agent_supervisor"),
      attemptId: "attempt_agent_supervisor",
      fence,
      createSession: async (input) => {
        created.push(input);
        return completedSession("子任务答案");
      },
      authorizeModelStart: async () => authorization,
      onToolEvent: async () => undefined,
    });
    await supervisor.initialize();
    supervisor.setParentHistory(parentHistory());

    const child = await supervisor.spawn({
      callId: "call_spawn_agent",
      task: "查找答案",
      tools: ["read", "exec_command"],
      forkTurns: 1,
    });
    expect(child.tools).toEqual(["read", "exec_command"]);
    const batch = await supervisor.wait({ afterSequence: 0, timeoutMs: 1_000 });

    expect(batch).toEqual({
      updates: [
        expect.objectContaining({
          kind: "final_answer",
          status: "completed",
          payload: "子任务答案",
        }),
      ],
      nextAfterSequence: 1,
      timedOut: false,
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.history?.messages.map((message) => message.sequence)).toEqual([3, 4]);
    expect((await supervisor.list())[0]?.status).toBe("idle");
  });

  it("follow-up 复用 Agent 历史，而 send_message 不会为闲置 Agent 自动启动 turn", async () => {
    const sessions: Parameters<
      ConstructorParameters<typeof AgentSupervisor>[0]["createSession"]
    >[0][] = [];
    const prompts: string[] = [];
    const supervisor = new AgentSupervisor({
      persistence: persistence(),
      rootAgentThreadId: agentThreadId("root_agent_followup"),
      attemptId: "attempt_agent_followup",
      fence,
      createSession: async (input) => {
        sessions.push(input);
        return completedSession(sessions.length === 1 ? "首次答案" : "补充答案");
      },
      authorizeModelStart: async (input) => {
        prompts.push(input.prompt);
        return authorization;
      },
      onToolEvent: async () => undefined,
    });
    await supervisor.initialize();
    const child = await supervisor.spawn({
      callId: "call_spawn_followup",
      task: "首次任务",
      tools: ["read"],
      forkTurns: "none",
    });
    await supervisor.drain();
    await expect(
      supervisor.sendMessage({
        callId: "call_send_idle",
        target: child.path,
        message: "补充背景",
      }),
    ).rejects.toThrow("AGENT_NOT_RUNNING");
    expect(sessions).toHaveLength(1);

    await supervisor.followUp({
      callId: "call_followup",
      target: child.agentThreadId,
      task: "继续分析",
    });
    await supervisor.drain();
    await supervisor.followUp({
      callId: "call_followup",
      target: child.agentThreadId,
      task: "继续分析",
    });

    expect(sessions).toHaveLength(2);
    expect(prompts[1]).toBe("继续分析");
    expect(sessions[1]?.history?.messages.some((message) => message.role === "assistant")).toBe(
      true,
    );
    expect(
      (await supervisor.wait({ afterSequence: 1, timeoutMs: 1_000 })).updates[0]?.payload,
    ).toBe("补充答案");
  });

  it("下一次 Root Run 可恢复同一主 Thread 的闲置对话，并沿用固定工具和历史", async () => {
    const history = parentHistory();
    const storedAgentId = agentThreadId("agent_persisted_conversation");
    const storedTools = ["read"] as const;
    const durable = persistence();
    durable.initializeRoot = async () => ({
      outcome: "ready",
      conversations: [
        {
          agentThreadId: storedAgentId,
          canonicalPath: "/root/persisted",
          task: "首次任务",
          currentTask: "上一轮任务",
          tools: storedTools,
          toolManifestDigest: digestCanonical({ tools: storedTools }),
          forkTurns: "none",
          turnOrdinal: 2,
          history,
        },
      ],
    });
    const sessions: Parameters<
      ConstructorParameters<typeof AgentSupervisor>[0]["createSession"]
    >[0][] = [];
    const supervisor = new AgentSupervisor({
      persistence: durable,
      rootAgentThreadId: agentThreadId("root_agent_next_run"),
      attemptId: "attempt_agent_next_run",
      fence,
      createSession: async (input) => {
        sessions.push(input);
        return completedSession("跨 Run 补充答案");
      },
      authorizeModelStart: async () => authorization,
      onToolEvent: async () => undefined,
    });

    await supervisor.initialize();
    expect(await supervisor.list()).toEqual([
      expect.objectContaining({
        agentThreadId: storedAgentId,
        initialTask: "首次任务",
        currentTask: "上一轮任务",
        status: "idle",
        turnOrdinal: 2,
        tools: ["read"],
      }),
    ]);
    await supervisor.followUp({
      callId: "call_cross_run_followup",
      target: storedAgentId,
      task: "在新 Run 中继续",
    });
    await supervisor.drain();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tools).toEqual(["read"]);
    expect(sessions[0]?.history).toBe(history);
    expect((await supervisor.list())[0]).toEqual(
      expect.objectContaining({
        initialTask: "首次任务",
        currentTask: "在新 Run 中继续",
        status: "idle",
        turnOrdinal: 3,
        tools: ["read"],
      }),
    );
  });

  it("总并发槽位包含 root，默认最多同时运行三个子 Agent", async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const createSession = vi.fn(async () => {
      const session = completedSession("完成");
      return {
        ...session,
        runPrompt: async () => {
          await blocked;
          return await session.runPrompt({ text: "", images: [] }, authorization);
        },
      };
    });
    const supervisor = new AgentSupervisor({
      persistence: persistence(),
      rootAgentThreadId: agentThreadId("root_agent_capacity"),
      attemptId: "attempt_agent_capacity",
      fence,
      createSession,
      authorizeModelStart: async () => authorization,
      onToolEvent: async () => undefined,
    });
    await supervisor.initialize();
    await Promise.all(
      [1, 2, 3].map((ordinal) =>
        supervisor.spawn({
          callId: `call_capacity_${ordinal}`,
          task: `任务 ${ordinal}`,
          tools: ["read"],
          forkTurns: "none",
        }),
      ),
    );
    await expect(
      supervisor.spawn({
        callId: "call_capacity_1",
        task: "任务 1",
        tools: ["read"],
        forkTurns: "none",
      }),
    ).resolves.toMatchObject({ status: "running" });
    await expect(
      supervisor.spawn({
        callId: "call_capacity_4",
        task: "第四个任务",
        tools: ["read"],
        forkTurns: "none",
      }),
    ).rejects.toThrow("AGENT_CAPACITY_EXCEEDED");
    release();
    await supervisor.drain();
  });

  it("使用 canonical 参数摘要中断运行中的子 Agent，并保持命令幂等", async () => {
    let now = 1_000;
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const abort = vi.fn(async () => release());
    const recorded: Parameters<AgentControlPersistencePort["recordCommand"]>[0][] = [];
    const durable = persistence();
    durable.recordCommand = async (input) => {
      recorded.push(input);
      return recorded.length === 1 ? "recorded" : "replayed";
    };
    const supervisor = new AgentSupervisor({
      persistence: durable,
      rootAgentThreadId: agentThreadId("root_agent_interrupt"),
      attemptId: "attempt_agent_interrupt",
      fence,
      now: () => now,
      createSession: async () => {
        const session = completedSession("不应完成");
        return {
          ...session,
          runPrompt: async () => {
            await blocked;
            throw new Error("SESSION_ABORTED");
          },
          abort,
        };
      },
      authorizeModelStart: async () => authorization,
      onToolEvent: async () => undefined,
    });
    await supervisor.initialize();
    const child = await supervisor.spawn({
      callId: "call_interrupt_spawn",
      task: "等待中断",
      tools: ["exec_command"],
      forkTurns: "none",
    });
    await vi.waitFor(async () => expect((await supervisor.list())[0]?.status).toBe("running"));
    now = 2_500;
    expect((await supervisor.list())[0]).toEqual(
      expect.objectContaining({
        startedAt: "1970-01-01T00:00:01.000Z",
        activeForMs: 1_500,
        lastMailboxSequence: 0,
      }),
    );

    await expect(
      supervisor.interrupt({ callId: "call_interrupt", target: child.agentThreadId }),
    ).resolves.toMatchObject({ status: "interrupted", lastMailboxSequence: 1 });
    await expect(
      supervisor.interrupt({ callId: "call_interrupt", target: child.agentThreadId }),
    ).resolves.toMatchObject({ agentThreadId: child.agentThreadId });
    await supervisor.drain();

    expect(abort).toHaveBeenCalledOnce();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.argsDigest).toBe(digestCanonical({ target: child.agentThreadId }));
    expect((await supervisor.list())[0]).toEqual(
      expect.objectContaining({
        status: "interrupted",
        lastMailboxSequence: 1,
      }),
    );
    expect((await supervisor.list())[0]).not.toHaveProperty("activeForMs");
    expect(await supervisor.wait({ afterSequence: 0, timeoutMs: 1_000 })).toEqual({
      updates: [
        expect.objectContaining({
          kind: "error",
          status: "interrupted",
          errorCode: "INTERRUPTED",
        }),
      ],
      nextAfterSequence: 1,
      timedOut: false,
    });
  });

  it("主动中断优先于 Pi completed，部分答案不得发布为成功终态", async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settled: Parameters<AgentControlPersistencePort["settleTurn"]>[0][] = [];
    const durable = persistence();
    durable.settleTurn = async (input) => {
      settled.push(input);
      return "settled";
    };
    const supervisor = new AgentSupervisor({
      persistence: durable,
      rootAgentThreadId: agentThreadId("root_agent_completed_after_interrupt"),
      attemptId: "attempt_agent_completed_after_interrupt",
      fence,
      createSession: async () => {
        const listeners = new Set<(event: RuntimeAgentEvent) => void>();
        return {
          prepareInput: async (input) => ({ text: input.text, images: [] }),
          runPrompt: async () => {
            await blocked;
            for (const listener of listeners) {
              listener({
                type: "turn.completed",
                assistant: {
                  content: [{ type: "text", text: "只完成了中断前的部分任务" }],
                  api: "test",
                  provider: "test",
                  model: "test",
                  stopReason: "stop",
                  timestamp: 10,
                },
                toolResults: [
                  {
                    toolCallId: "call_cancelled",
                    toolName: "exec_command",
                    text: '{"code":"EXEC_CANCELLED"}',
                    isError: true,
                    timestamp: 9,
                  },
                ],
              });
            }
            return { kind: "completed" };
          },
          steer: async () => undefined,
          abort: async () => release(),
          subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          dispose: () => undefined,
        };
      },
      authorizeModelStart: async () => authorization,
      onToolEvent: async () => undefined,
    });
    await supervisor.initialize();
    const child = await supervisor.spawn({
      callId: "call_completed_after_interrupt_spawn",
      task: "执行长任务",
      tools: ["exec_command"],
      forkTurns: "none",
    });
    await vi.waitFor(async () => expect((await supervisor.list())[0]?.status).toBe("running"));

    await expect(
      supervisor.interrupt({
        callId: "call_completed_after_interrupt",
        target: child.agentThreadId,
      }),
    ).resolves.toMatchObject({ status: "interrupted", lastMailboxSequence: 1 });

    expect(settled).toEqual([
      expect.objectContaining({ status: "interrupted", errorCode: "INTERRUPTED" }),
    ]);
    expect(await supervisor.wait({ afterSequence: 0, timeoutMs: 1_000 })).toEqual({
      updates: [
        expect.objectContaining({
          kind: "error",
          status: "interrupted",
          errorCode: "INTERRUPTED",
        }),
      ],
      nextAfterSequence: 1,
      timedOut: false,
    });
  });
  it("达到 Agent Thread 数量上限后仍可复用已有闲置 Agent", async () => {
    const supervisor = new AgentSupervisor({
      persistence: persistence(),
      rootAgentThreadId: agentThreadId("root_agent_thread_limit"),
      attemptId: "attempt_agent_thread_limit",
      fence,
      maxThreads: 2,
      createSession: async () => completedSession("完成"),
      authorizeModelStart: async () => authorization,
      onToolEvent: async () => undefined,
    });
    await supervisor.initialize();
    const first = await supervisor.spawn({
      callId: "call_thread_limit_1",
      task: "任务一",
      tools: ["read"],
      forkTurns: "none",
    });
    await supervisor.drain();
    await supervisor.spawn({
      callId: "call_thread_limit_2",
      task: "任务二",
      tools: ["read"],
      forkTurns: "none",
    });
    await supervisor.drain();

    await expect(
      supervisor.followUp({
        callId: "call_thread_limit_followup",
        target: first.agentThreadId,
        task: "继续任务一",
      }),
    ).resolves.toEqual(expect.objectContaining({ turnOrdinal: 2, status: "running" }));
    await supervisor.drain();
  });

  it("tool.started 的 durable 写入完成前不发布子 Agent 最终结果", async () => {
    let release: () => void = () => undefined;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onToolEvent = vi.fn(async () => await persisted);
    const supervisor = new AgentSupervisor({
      persistence: persistence(),
      rootAgentThreadId: agentThreadId("root_agent_tool_gate"),
      attemptId: "attempt_agent_tool_gate",
      fence,
      createSession: async () =>
        completedSession("工具任务完成", {
          type: "tool.started",
          callId: "child_tool_call",
          name: "read",
        }),
      authorizeModelStart: async () => authorization,
      onToolEvent,
    });
    await supervisor.initialize();
    await supervisor.spawn({
      callId: "call_spawn_tool_gate",
      task: "执行工具",
      tools: ["read"],
      forkTurns: "none",
    });
    await vi.waitFor(() => expect(onToolEvent).toHaveBeenCalledOnce());
    expect(await supervisor.wait({ afterSequence: 0, timeoutMs: 1 })).toEqual({
      updates: [],
      nextAfterSequence: 0,
      timedOut: true,
    });

    release();
    await supervisor.drain();
    expect(await supervisor.wait({ afterSequence: 0, timeoutMs: 1_000 })).toEqual({
      updates: [expect.objectContaining({ kind: "final_answer", payload: "工具任务完成" })],
      nextAfterSequence: 1,
      timedOut: false,
    });
  });
});

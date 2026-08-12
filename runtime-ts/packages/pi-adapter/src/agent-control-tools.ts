import type { ToolObservationResult } from "@cube-runtime/context-policy";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { createSchemaInvalidArgumentsBridge } from "./tools.js";

const strict = { additionalProperties: false } as const;
export const DELEGABLE_PI_TOOL_NAMES = ["exec_command", "read", "edit", "write", "skill"] as const;
export type DelegablePiToolName = (typeof DELEGABLE_PI_TOOL_NAMES)[number];

const ToolNameSchema = Type.Union([
  Type.Literal("exec_command"),
  Type.Literal("read"),
  Type.Literal("edit"),
  Type.Literal("write"),
  Type.Literal("skill"),
]);
const SpawnArgumentsSchema = Type.Object(
  {
    task: Type.String({ minLength: 1, maxLength: 32 * 1024 }),
    tools: Type.Array(ToolNameSchema, { maxItems: DELEGABLE_PI_TOOL_NAMES.length }),
    fork_turns: Type.String({
      pattern: "^(none|all|[1-9][0-9]*)$",
      maxLength: 6,
      description: "必须显式选择 none、all 或最近 N 个父 Agent turn。",
    }),
  },
  strict,
);
const TargetMessageArgumentsSchema = Type.Object(
  {
    target: Type.String({ minLength: 1, maxLength: 200 }),
    message: Type.String({ minLength: 1, maxLength: 32 * 1024 }),
  },
  strict,
);
const FollowUpArgumentsSchema = Type.Object(
  {
    target: Type.String({ minLength: 1, maxLength: 200 }),
    task: Type.String({ minLength: 1, maxLength: 32 * 1024 }),
  },
  strict,
);
const TargetArgumentsSchema = Type.Object(
  { target: Type.String({ minLength: 1, maxLength: 200 }) },
  strict,
);
const EmptyArgumentsSchema = Type.Object({}, strict);
const WaitArgumentsSchema = Type.Object(
  {
    after_sequence: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000 })),
  },
  strict,
);

type SpawnArguments = Static<typeof SpawnArgumentsSchema>;
type TargetMessageArguments = Static<typeof TargetMessageArgumentsSchema>;
type FollowUpArguments = Static<typeof FollowUpArgumentsSchema>;
type TargetArguments = Static<typeof TargetArgumentsSchema>;
type WaitArguments = Static<typeof WaitArgumentsSchema>;

const invalidArgumentsToken = Symbol("agent-control-invalid-arguments");

function invalidFallback<T extends object>(value: T, token: string): T {
  Object.defineProperty(value, invalidArgumentsToken, { value: token });
  return value;
}

function invalidToken(value: object): string | undefined {
  return (value as { readonly [invalidArgumentsToken]?: string })[invalidArgumentsToken];
}

export interface AgentControlPiToolExecutorPort {
  spawn(input: {
    readonly callId: string;
    readonly task: string;
    readonly tools: readonly DelegablePiToolName[];
    readonly forkTurns: "none" | "all" | number;
  }): Promise<unknown>;
  sendMessage(input: {
    readonly callId: string;
    readonly target: string;
    readonly message: string;
  }): Promise<void>;
  followUp(input: {
    readonly callId: string;
    readonly target: string;
    readonly task: string;
  }): Promise<unknown>;
  interrupt(input: { readonly callId: string; readonly target: string }): Promise<unknown>;
  list(): Promise<unknown>;
  wait(input: {
    readonly afterSequence: number;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
  projectError(error: unknown): Readonly<{
    status: "failed";
    code: string;
    message: string;
    correctable: boolean;
    fatal: boolean;
  }>;
}

type ReceiptWriter = (
  callId: string,
  toolName: string,
  outcome: "succeeded" | "failed",
) => Promise<ToolObservationResult>;

function forkTurns(value: string): "none" | "all" | number {
  if (value === "all") return "all";
  if (value === "none") return "none";
  return Number(value);
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value ?? { outcome: "ok" }) }],
    details: {},
  };
}

async function executeObserved(
  callId: string,
  toolName: string,
  record: ReceiptWriter,
  executor: AgentControlPiToolExecutorPort,
  operation: () => Promise<unknown>,
) {
  let value: unknown;
  let failure: ReturnType<AgentControlPiToolExecutorPort["projectError"]> | undefined;
  try {
    value = await operation();
  } catch (error) {
    failure = executor.projectError(error);
  }
  const observation = await record(
    callId,
    toolName,
    failure === undefined ? "succeeded" : "failed",
  );
  if (observation.outcome !== "recorded" && observation.outcome !== "replayed") {
    throw new Error(`${toolName} Tool Observation 未能形成 durable 事实`);
  }
  if (failure !== undefined) throw new Error(JSON.stringify(failure));
  return jsonResult(value);
}

/** 协作工具只注册到 root Session；子 Agent 的工具集合由 spawn_agent 参数显式选择。 */
export function createAgentControlPiTools(
  executor: AgentControlPiToolExecutorPort,
  record: ReceiptWriter,
) {
  const spawnArguments = createSchemaInvalidArgumentsBridge<SpawnArguments>(
    SpawnArgumentsSchema,
    (token) => invalidFallback({ task: token, tools: ["read"], fork_turns: "none" }, token),
    invalidToken,
  );
  const messageArguments = createSchemaInvalidArgumentsBridge<TargetMessageArguments>(
    TargetMessageArgumentsSchema,
    (token) => invalidFallback({ target: token, message: token }, token),
    invalidToken,
  );
  const followUpArguments = createSchemaInvalidArgumentsBridge<FollowUpArguments>(
    FollowUpArgumentsSchema,
    (token) => invalidFallback({ target: token, task: token }, token),
    invalidToken,
  );
  const targetArguments = createSchemaInvalidArgumentsBridge<TargetArguments>(
    TargetArgumentsSchema,
    (token) => invalidFallback({ target: token }, token),
    invalidToken,
  );
  const waitArguments = createSchemaInvalidArgumentsBridge<WaitArguments>(
    WaitArgumentsSchema,
    (token) => invalidFallback({ after_sequence: 0, timeout_ms: 1 }, token),
    invalidToken,
  );
  const emptyArguments = createSchemaInvalidArgumentsBridge<Record<string, never>>(
    EmptyArgumentsSchema,
    (token) => invalidFallback({}, token),
    invalidToken,
  );
  const assertArguments = (invalid: boolean): void => {
    if (invalid) throw new Error("AGENT_CONTROL_INVALID_ARGUMENTS");
  };
  return [
    defineTool({
      name: "spawn_agent",
      label: "启动子 Agent",
      description:
        "为边界清晰、可独立完成的子任务创建可复用的独立对话并启动当前 turn。子 Agent 与你共享同一 Sandbox；必须显式选择工具，创建后工具清单不可修改。",
      executionMode: "parallel",
      parameters: SpawnArgumentsSchema,
      prepareArguments: spawnArguments.prepareArguments,
      execute: async (callId, args: SpawnArguments) =>
        executeObserved(callId, "spawn_agent", record, executor, () => {
          assertArguments(spawnArguments.consume(args));
          return executor.spawn({
            callId,
            task: args.task,
            tools: [...new Set(args.tools)],
            forkTurns: forkTurns(args.fork_turns),
          });
        }),
    }),
    defineTool({
      name: "send_message",
      label: "发送子 Agent 消息",
      description:
        "向当前正在运行的子 Agent 追加消息，不启动新 turn；目标已闲置或结束时调用会失败，应改用 followup_task。",
      executionMode: "parallel",
      parameters: TargetMessageArgumentsSchema,
      prepareArguments: messageArguments.prepareArguments,
      execute: async (callId, args: TargetMessageArguments) =>
        executeObserved(callId, "send_message", record, executor, async () => {
          assertArguments(messageArguments.consume(args));
          await executor.sendMessage({ callId, target: args.target, message: args.message });
          return { outcome: "delivered" };
        }),
    }),
    defineTool({
      name: "followup_task",
      label: "追加子 Agent 任务",
      description:
        "复用同一主 Thread 中已保存的闲置子 Agent 对话并启动新的 turn，可跨主 Agent Run 使用；沿用创建时的固定工具清单，正在运行时调用会失败。",
      executionMode: "parallel",
      parameters: FollowUpArgumentsSchema,
      prepareArguments: followUpArguments.prepareArguments,
      execute: async (callId, args: FollowUpArguments) =>
        executeObserved(callId, "followup_task", record, executor, () => {
          assertArguments(followUpArguments.consume(args));
          return executor.followUp({ callId, target: args.target, task: args.task });
        }),
    }),
    defineTool({
      name: "wait_agent",
      label: "等待子 Agent",
      description:
        "等待当前 Root Run 中子 Agent mailbox 的新消息、完成通知或超时。使用返回的最大 sequence 继续等待可避免重复结果。",
      executionMode: "parallel",
      parameters: WaitArgumentsSchema,
      prepareArguments: waitArguments.prepareArguments,
      execute: async (callId, args: WaitArguments, signal) =>
        executeObserved(callId, "wait_agent", record, executor, () => {
          assertArguments(waitArguments.consume(args));
          return executor.wait({
            afterSequence: args.after_sequence ?? 0,
            timeoutMs: args.timeout_ms ?? 30_000,
            ...(signal === undefined ? {} : { signal }),
          });
        }),
    }),
    defineTool({
      name: "interrupt_agent",
      label: "中断子 Agent",
      description:
        "中断目标子 Agent 在当前 Root Run 中的 turn；未完成内容不写入可复用历史，对话仍保留以便后续 follow-up。",
      executionMode: "parallel",
      parameters: TargetArgumentsSchema,
      prepareArguments: targetArguments.prepareArguments,
      execute: async (callId, args: TargetArguments) =>
        executeObserved(callId, "interrupt_agent", record, executor, () => {
          assertArguments(targetArguments.consume(args));
          return executor.interrupt({ callId, target: args.target });
        }),
    }),
    defineTool({
      name: "list_agents",
      label: "列出子 Agent",
      description:
        "列出当前主 Thread 中可复用的子 Agent 对话、当前 Root Run 状态、turn 序号和固定工具能力。",
      executionMode: "parallel",
      parameters: EmptyArgumentsSchema,
      prepareArguments: emptyArguments.prepareArguments,
      execute: async (callId, args: Record<string, never>) =>
        executeObserved(callId, "list_agents", record, executor, () => {
          assertArguments(emptyArguments.consume(args));
          return executor.list();
        }),
    }),
  ];
}

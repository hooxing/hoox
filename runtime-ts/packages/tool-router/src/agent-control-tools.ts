import type { ToolObservationResult } from "@hoox/context-policy";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { registerRuntimeToolParameters } from "./tool-parameter-schemas.js";
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
    after_sequence: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      description: "首次等待传 0；后续必须传上次返回的 nextAfterSequence。",
    }),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000 })),
  },
  strict,
);

const runtimeToken = {
  runtime_invalid_arguments_token: Type.Optional(Type.String({ pattern: "^[0-9a-f-]{36}$" })),
};
const WaitRuntimeArgumentsSchema = Type.Object(
  { ...WaitArgumentsSchema.properties, ...runtimeToken },
  strict,
);
const EmptyRuntimeArgumentsSchema = Type.Object(runtimeToken, strict);
registerRuntimeToolParameters(WaitArgumentsSchema, WaitRuntimeArgumentsSchema);
registerRuntimeToolParameters(EmptyArgumentsSchema, EmptyRuntimeArgumentsSchema);

type SpawnArguments = Static<typeof SpawnArgumentsSchema>;
type TargetMessageArguments = Static<typeof TargetMessageArgumentsSchema>;
type FollowUpArguments = Static<typeof FollowUpArgumentsSchema>;
type TargetArguments = Static<typeof TargetArgumentsSchema>;
type WaitArguments = Static<typeof WaitRuntimeArgumentsSchema>;
type EmptyArguments = Static<typeof EmptyRuntimeArgumentsSchema>;

const INVALID_ARGUMENT_PREFIX = "runtime-invalid-agent-control:";

function invalidArgumentValue(token: string): string {
  return `${INVALID_ARGUMENT_PREFIX}${token}`;
}

function invalidArgumentToken(value: string): string | undefined {
  return value.startsWith(INVALID_ARGUMENT_PREFIX)
    ? value.slice(INVALID_ARGUMENT_PREFIX.length)
    : undefined;
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
    (token) => ({ task: invalidArgumentValue(token), tools: ["read"], fork_turns: "none" }),
    (value) => invalidArgumentToken(value.task),
  );
  const messageArguments = createSchemaInvalidArgumentsBridge<TargetMessageArguments>(
    TargetMessageArgumentsSchema,
    (token) => ({ target: invalidArgumentValue(token), message: invalidArgumentValue(token) }),
    (value) => invalidArgumentToken(value.target),
  );
  const followUpArguments = createSchemaInvalidArgumentsBridge<FollowUpArguments>(
    FollowUpArgumentsSchema,
    (token) => ({ target: invalidArgumentValue(token), task: invalidArgumentValue(token) }),
    (value) => invalidArgumentToken(value.target),
  );
  const targetArguments = createSchemaInvalidArgumentsBridge<TargetArguments>(
    TargetArgumentsSchema,
    (token) => ({ target: invalidArgumentValue(token) }),
    (value) => invalidArgumentToken(value.target),
  );
  const waitArguments = createSchemaInvalidArgumentsBridge<WaitArguments>(
    WaitArgumentsSchema,
    (token) => ({
      after_sequence: 0,
      timeout_ms: 1,
      runtime_invalid_arguments_token: token,
    }),
    (value) => value.runtime_invalid_arguments_token,
  );
  const emptyArguments = createSchemaInvalidArgumentsBridge<EmptyArguments>(
    EmptyArgumentsSchema,
    (token) => ({ runtime_invalid_arguments_token: token }),
    (value) => value.runtime_invalid_arguments_token,
  );
  const assertArguments = (invalid: boolean): void => {
    if (invalid) throw new Error("AGENT_CONTROL_INVALID_ARGUMENTS");
  };
  return [
    {
      name: "spawn_agent" as const,
      label: "启动子 Agent",
      description:
        "为边界清晰、可独立完成的子任务创建可复用的独立对话并启动当前 turn。子 Agent 与你共享同一 Sandbox；必须显式选择工具，创建后工具清单不可修改。",
      executionMode: "sequential",
      parameters: SpawnArgumentsSchema,
      prepareArguments: spawnArguments.prepareArguments,
      execute: async (callId, args: SpawnArguments) =>
        executeObserved(callId, "spawn_agent", record, executor, () => {
          assertArguments(
            spawnArguments.consume(args) || invalidArgumentToken(args.task) !== undefined,
          );
          return executor.spawn({
            callId,
            task: args.task,
            tools: [...new Set(args.tools)],
            forkTurns: forkTurns(args.fork_turns),
          });
        }),
    } satisfies AgentTool<typeof SpawnArgumentsSchema, unknown>,
    {
      name: "send_message" as const,
      label: "发送子 Agent 消息",
      description:
        "向当前正在运行的子 Agent 追加消息，不启动新 turn；目标已闲置或结束时调用会失败，应改用 followup_task。",
      executionMode: "sequential",
      parameters: TargetMessageArgumentsSchema,
      prepareArguments: messageArguments.prepareArguments,
      execute: async (callId, args: TargetMessageArguments) =>
        executeObserved(callId, "send_message", record, executor, async () => {
          assertArguments(
            messageArguments.consume(args) || invalidArgumentToken(args.target) !== undefined,
          );
          await executor.sendMessage({ callId, target: args.target, message: args.message });
          return { outcome: "delivered" };
        }),
    } satisfies AgentTool<typeof TargetMessageArgumentsSchema, unknown>,
    {
      name: "followup_task" as const,
      label: "追加子 Agent 任务",
      description:
        "复用同一主 Thread 中已保存的闲置子 Agent 对话并启动新的 turn，可跨主 Agent Run 使用；沿用创建时的固定工具清单，正在运行时调用会失败。",
      executionMode: "sequential",
      parameters: FollowUpArgumentsSchema,
      prepareArguments: followUpArguments.prepareArguments,
      execute: async (callId, args: FollowUpArguments) =>
        executeObserved(callId, "followup_task", record, executor, () => {
          assertArguments(
            followUpArguments.consume(args) || invalidArgumentToken(args.target) !== undefined,
          );
          return executor.followUp({ callId, target: args.target, task: args.task });
        }),
    } satisfies AgentTool<typeof FollowUpArgumentsSchema, unknown>,
    {
      name: "wait_agent" as const,
      label: "等待子 Agent",
      description:
        "等待当前 Root Run 中子 Agent mailbox 的新消息、完成通知或超时。首次必须传 after_sequence=0，后续必须传上次返回的 nextAfterSequence。sequence 是当前 Attempt 的全局 mailbox 序号；发往子 Agent 的反向消息不会出现在 updates 中，因此序号可以跳跃，空洞不表示丢消息。",
      executionMode: "sequential",
      parameters: WaitArgumentsSchema,
      prepareArguments: waitArguments.prepareArguments,
      execute: async (callId, args: WaitArguments, signal?: AbortSignal) =>
        executeObserved(callId, "wait_agent", record, executor, () => {
          assertArguments(
            waitArguments.consume(args) || args.runtime_invalid_arguments_token !== undefined,
          );
          return executor.wait({
            afterSequence: args.after_sequence,
            timeoutMs: args.timeout_ms ?? 30_000,
            ...(signal === undefined ? {} : { signal }),
          });
        }),
    } satisfies AgentTool<typeof WaitArgumentsSchema, unknown>,
    {
      name: "interrupt_agent" as const,
      label: "中断子 Agent",
      description:
        "中断目标子 Agent 在当前 Root Run 中的 turn；未完成内容不写入可复用历史，对话仍保留以便后续 follow-up。",
      executionMode: "sequential",
      parameters: TargetArgumentsSchema,
      prepareArguments: targetArguments.prepareArguments,
      execute: async (callId, args: TargetArguments) =>
        executeObserved(callId, "interrupt_agent", record, executor, () => {
          assertArguments(
            targetArguments.consume(args) || invalidArgumentToken(args.target) !== undefined,
          );
          return executor.interrupt({ callId, target: args.target });
        }),
    } satisfies AgentTool<typeof TargetArgumentsSchema, unknown>,
    {
      name: "list_agents" as const,
      label: "列出子 Agent",
      description:
        "列出当前主 Thread 中可复用的子 Agent 对话、当前 Root Run 状态、turn 序号和固定工具能力。",
      executionMode: "sequential",
      parameters: EmptyArgumentsSchema,
      prepareArguments: emptyArguments.prepareArguments,
      execute: async (callId, args: EmptyArguments) =>
        executeObserved(callId, "list_agents", record, executor, () => {
          assertArguments(
            emptyArguments.consume(args) || args.runtime_invalid_arguments_token !== undefined,
          );
          return executor.list();
        }),
    } satisfies AgentTool<typeof EmptyArgumentsSchema, unknown>,
  ];
}

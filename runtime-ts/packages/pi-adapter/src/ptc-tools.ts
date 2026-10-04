import { createHash } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolObservationResult } from "@hoox/context-policy";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { RuntimeAgentEvent } from "./events.js";
import { runPtcProgram } from "./ptc-runtime.js";
import { createSchemaInvalidArgumentsBridge } from "./tools.js";

export type ToolCallingMode = "native" | "ptc";
export type PtcToolEvent = Extract<
  RuntimeAgentEvent,
  { type: "tool.started" | "tool.updated" | "tool.completed" }
>;

const ProgramSchema = Type.Object(
  {
    code: Type.String({
      minLength: 1,
      maxLength: 64 * 1024,
      description: "异步 JavaScript 函数体，支持顶层 await 和 return。",
    }),
  },
  { additionalProperties: false },
);

/** SDK 只描述静态工具能力；参数与运行结果不得进入其描述。 */
export function buildPtcSdk(
  tools: readonly Pick<AgentTool, "name" | "description" | "parameters">[],
): string {
  return [
    "当前使用 PTC 模式。模型只能直接调用 run_code；Harness 中提及的业务工具必须在程序里通过 tools[工具名](参数) 调用。",
    "PTC 模式不提供可选的最终答复过程折叠标记。图片结果是程序数据，不会自动作为模型视觉输入。",
    "每次程序都是独立的纯计算环境，只提供 tools 和 console.log；没有 process、require、文件、网络或其他宿主 IO。程序结束后变量不保留。",
    "工具返回 { content, details }；content 是文本或图片内容块，details 是工具提供的结构化结果。工具失败会抛错，可用 try/catch 处理；已发生的副作用不会回滚。",
    "内部调用按提交顺序串行执行。不要把未 await 的调用当作后台任务。只打印或返回解决任务所需的结果，避免把全部中间数据放回模型上下文。",
    "默认执行上限为 30 秒、64 次工具调用、64 KiB 程序输出；执行时间包含等待工具的时间。超时后等待已开始调用收束，不会自动重跑。",
    "以下是 tools 命名空间的固定能力说明与参数 JSON Schema：",
    JSON.stringify(
      tools
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: canonical(tool.parameters),
        }))
        .sort((a, b) => a.name.localeCompare(b.name, "en")),
    ),
  ].join("\n");
}

/** 将程序子调用接回同一套工具实现和受控生命周期，不授予额外宿主能力。 */
export function createPtcTool(input: {
  readonly timeoutMs?: number;
  readonly tools: readonly AgentTool[];
  readonly emit: (event: PtcToolEvent) => void;
  readonly prepareProgram: (callId: string) => Promise<void>;
  readonly prepareTool: (call: {
    readonly callId: string;
    readonly toolName: string;
    readonly parentCallId: string;
  }) => Promise<void>;
  readonly ensureReceipt: (
    callId: string,
    toolName: string,
    outcome: "succeeded" | "failed",
  ) => Promise<void>;
  readonly recordProgramReceipt: (
    callId: string,
    toolName: string,
    outcome: "succeeded" | "failed",
  ) => Promise<ToolObservationResult>;
  readonly assertContinuationAllowed: () => void;
}): AgentTool<typeof ProgramSchema, unknown> {
  const byName = new Map(input.tools.map((tool) => [tool.name, tool]));
  if (byName.size !== input.tools.length || byName.has("run_code"))
    throw new TypeError("PTC 工具能力名称重复或递归");
  const invalidArguments = createSchemaInvalidArgumentsBridge<{ code: string }>(
    ProgramSchema,
    (token) => ({ code: token }),
    (value) => value.code,
  );
  return {
    prepareArguments: invalidArguments.prepareArguments,
    name: "run_code",
    label: "执行 PTC 程序",
    description: "在隔离的 JavaScript 环境中编排受控工具；固定 SDK 和参数约束见 code 字段说明。",
    parameters: Type.Object(
      {
        code: Type.String({
          minLength: 1,
          maxLength: 64 * 1024,
          description: buildPtcSdk(input.tools),
        }),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    execute: async (parentCallId, args, signal) => {
      await input.prepareProgram(parentCallId);
      let outcome: "succeeded" | "failed" = "failed";
      let programResult: AgentToolResult<unknown> | undefined;
      let failure: { readonly error: unknown } | undefined;
      const timeoutMs = input.timeoutMs ?? 30_000;
      const programAbort = new AbortController();
      const onAbort = () => programAbort.abort();
      if (signal?.aborted) programAbort.abort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(onAbort, timeoutMs);
      try {
        if (invalidArguments.consume(args)) throw new TypeError("PTC 程序参数不符合 Schema");
        input.assertContinuationAllowed();
        let ordinal = 0;
        const value = await runPtcProgram({
          code: args.code,
          toolNames: [...byName.keys()],
          signal: programAbort.signal,
          timeoutMs,
          callTool: async (name, rawArgs) => {
            input.assertContinuationAllowed();
            const tool = byName.get(name);
            if (tool === undefined) throw new Error("PTC 工具不存在");
            const callId = `ptc.${createHash("sha256").update(parentCallId).digest("hex")}.${++ordinal}`;
            input.emit({ type: "tool.started", callId, name, parentCallId });
            // durable 开始必须先于任何工具实现；外层 run_code 的许可不能替代子调用许可。
            await input.prepareTool({ callId, toolName: name, parentCallId });
            let isError = true;
            try {
              if (programAbort.signal.aborted) throw new Error("PTC 程序已取消");
              const prepared =
                tool.prepareArguments === undefined
                  ? rawArgs
                  : await tool.prepareArguments(rawArgs);
              if (tool.prepareArguments === undefined && !Value.Check(tool.parameters, prepared))
                throw new TypeError("PTC 工具参数不符合 Schema");
              input.assertContinuationAllowed();
              if (programAbort.signal.aborted) throw new Error("PTC 程序已取消");
              const result: AgentToolResult<unknown> = await tool.execute(
                callId,
                prepared,
                programAbort.signal,
                () => input.emit({ type: "tool.updated", callId, name }),
              );
              input.assertContinuationAllowed();
              isError = false;
              return result;
            } finally {
              await input.ensureReceipt(callId, name, isError ? "failed" : "succeeded");
              input.emit({ type: "tool.completed", callId, name, isError });
            }
          },
        });
        input.assertContinuationAllowed();
        outcome = "succeeded";
        programResult = { content: [{ type: "text", text: JSON.stringify(value) }], details: {} };
      } catch (error) {
        failure = { error };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
      // durable 未知优先于程序错误；不能把缺失的闭合事实当作普通可捕获失败。
      const receipt = await input.recordProgramReceipt(parentCallId, "run_code", outcome);
      if (receipt.outcome !== "recorded" && receipt.outcome !== "replayed")
        throw new Error("PTC 程序回执未能持久化");
      if (failure !== undefined) throw failure.error;
      if (programResult === undefined) throw new Error("PTC 程序结果缺失");
      return programResult;
    },
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([key, child]) => [
          key,
          canonical(key === "required" && Array.isArray(child) ? [...child].sort() : child),
        ]),
    );
  return value;
}

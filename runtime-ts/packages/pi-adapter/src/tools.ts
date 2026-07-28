import type { SandboxHandle } from "@cube-runtime/sandbox";
import type {
  ControlledToolReceiptSource,
  ToolObservationResult,
} from "@cube-runtime/context-policy";
import { encodeControlledToolReceipt } from "@cube-runtime/context-policy";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";

export const SANDBOX_TOOL_NAMES = [
  "sandbox_command",
  "sandbox_run_code",
  "sandbox_read_file",
  "sandbox_write_file",
] as const;

export interface SandboxToolEffectAuthorizer {
  /** 每次工具副作用前都向 Runtime DB 重新领取短时许可。 */
  authorizeToolEffect(input: {
    readonly callId: string;
    readonly toolName: string;
    readonly argsDigest: string;
  }): Promise<{
    readonly consumedAtMonotonicMs: number;
    readonly maxContinuationDelayMs: number;
  }>;
}

export function createSandboxTools(
  sandbox: SandboxHandle,
  authorizer: SandboxToolEffectAuthorizer,
) {
  return createSandboxToolsInternal(sandbox, authorizer);
}

/** 原始 Tool 结果只存在于闭包；对外只暴露完成统一脱敏后的只读 Observation source。 */
export function createObservedSandboxTools(
  sandbox: SandboxHandle,
  authorizer: SandboxToolEffectAuthorizer,
  createRecorder: (outputs: ControlledToolReceiptSource) => {
    record(input: {
      readonly toolCallId: string;
      readonly toolName: string;
    }): Promise<ToolObservationResult>;
  },
): {
  readonly tools: ReturnType<typeof createSandboxTools>;
  readonly outputs: ControlledToolReceiptSource;
} {
  const outputs = new Map<string, { readonly name: string; readonly text: string }>();
  const source: ControlledToolReceiptSource = {
    async readControlledReceipt(input) {
      const found = outputs.get(input.toolCallId);
      if (found === undefined || found.name !== input.toolName) return undefined;
      return found.text;
    },
  };
  const recorder = createRecorder(source);
  const capture = async (callId: string, name: string, text: string) => {
    outputs.set(callId, { name, text });
    return recorder.record({
      toolCallId: callId,
      toolName: name,
    });
  };
  return {
    tools: createSandboxToolsInternal(sandbox, authorizer, capture),
    outputs: source,
  };
}

function createSandboxToolsInternal(
  sandbox: SandboxHandle,
  authorizer: SandboxToolEffectAuthorizer,
  capture?: (callId: string, name: string, text: string) => Promise<ToolObservationResult>,
) {
  return [
    defineTool({
      name: "sandbox_command",
      label: "Sandbox 命令",
      description: "只在隔离的 CubeSandbox 中执行命令，不访问 Agent Worker 宿主机。",
      parameters: Type.Object({ command: Type.String({ minLength: 1 }) }),
      execute: async (_id, params, signal) => {
        const authorization = await authorizeTool(authorizer, _id, "sandbox_command", params);
        assertImmediateContinuation(authorization, signal);
        return toolResult(_id, "sandbox_command", capture, () =>
          sandbox.command(params.command, signalControl(signal)),
        );
      },
    }),
    defineTool({
      name: "sandbox_run_code",
      label: "Sandbox 代码",
      description: "只在隔离的 CubeSandbox Jupyter 环境中执行代码。",
      parameters: Type.Object({
        code: Type.String({ minLength: 1 }),
        language: Type.Optional(Type.String()),
      }),
      execute: async (_id, params, signal) => {
        const authorization = await authorizeTool(authorizer, _id, "sandbox_run_code", params);
        assertImmediateContinuation(authorization, signal);
        return toolResult(_id, "sandbox_run_code", capture, () =>
          sandbox.runCode(params.code, {
            ...signalControl(signal),
            ...(params.language ? { language: params.language } : {}),
          }),
        );
      },
    }),
    defineTool({
      name: "sandbox_read_file",
      label: "读取 Sandbox 文件",
      description: "读取 CubeSandbox 中的绝对路径文件；不能读取 Worker 宿主机。",
      parameters: Type.Object({ path: Type.String({ pattern: "^/" }) }),
      execute: async (_id, params, signal) => {
        const authorization = await authorizeTool(authorizer, _id, "sandbox_read_file", params);
        assertImmediateContinuation(authorization, signal);
        return toolResult(_id, "sandbox_read_file", capture, () =>
          sandbox.readFile(params.path, signalControl(signal)),
        );
      },
    }),
    defineTool({
      name: "sandbox_write_file",
      label: "写入 Sandbox 文件",
      description: "写入 CubeSandbox 中的绝对路径文件；不能写入 Worker 宿主机。",
      parameters: Type.Object({
        path: Type.String({ pattern: "^/" }),
        content: Type.String(),
      }),
      execute: async (_id, params, signal) => {
        const authorization = await authorizeTool(authorizer, _id, "sandbox_write_file", params);
        assertImmediateContinuation(authorization, signal);
        return toolResult(_id, "sandbox_write_file", capture, async () => {
          await sandbox.writeFile(params.path, params.content, signalControl(signal));
          return { written: true };
        });
      },
    }),
  ];
}

async function authorizeTool(
  authorizer: SandboxToolEffectAuthorizer,
  callId: string,
  toolName: string,
  args: unknown,
): ReturnType<SandboxToolEffectAuthorizer["authorizeToolEffect"]> {
  try {
    return await authorizer.authorizeToolEffect({
      callId,
      toolName,
      argsDigest: createHash("sha256").update(canonicalJson(args)).digest("hex"),
    });
  } catch {
    // 不泄漏 DB/栅栏细节；抛错让 Pi 将工具调用标记为失败，同时保证 Sandbox 尚未被触碰。
    throw new Error("Runtime 已拒绝本次工具副作用");
  }
}

/** authorize 返回后的 continuation 不再 await；检查后下一条语句必须直接调用 Sandbox。 */
function assertImmediateContinuation(
  authorization: Awaited<ReturnType<SandboxToolEffectAuthorizer["authorizeToolEffect"]>>,
  signal: AbortSignal | undefined,
): void {
  if (
    signal?.aborted ||
    performance.now() - authorization.consumedAtMonotonicMs >= authorization.maxContinuationDelayMs
  ) {
    throw new Error("Runtime 工具副作用许可已过期或调用已取消");
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

function signalControl(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal ? { signal } : {};
}

/**
 * Sandbox 返回的 stdout、文件内容和异常 message 都属于低信任原始数据：其中既可能有密钥，
 * 也可能含有提示注入。当前策略只持久化固定结构的观察事实，原始值不进入模型、Rollout 或 Blob。
 */
function controlledObservation(toolName: string, outcome: "succeeded" | "failed"): string {
  return encodeControlledToolReceipt(toolName, outcome);
}

async function toolResult(
  callId: string,
  toolName: string,
  capture:
    | ((callId: string, name: string, text: string) => Promise<ToolObservationResult>)
    | undefined,
  action: () => Promise<unknown>,
) {
  let outcome: "succeeded" | "failed" = "succeeded";
  try {
    await action();
  } catch (error) {
    // SandboxRuntimeError.message/code 同样来自上游，不能作为安全分类或模型文本使用。
    void error;
    outcome = "failed";
  }
  const text = controlledObservation(toolName, outcome);
  // capture 位于 Sandbox try/catch 之外：持久化异常绝不能被误分类成普通 Tool 失败。
  const observation = await capture?.(callId, toolName, text);
  if (
    observation !== undefined &&
    observation.outcome !== "recorded" &&
    observation.outcome !== "replayed"
  ) {
    throw new ToolObservationPersistenceError(observation.outcome);
  }
  return {
    content: [{ type: "text" as const, text: observation?.observation ?? text }],
    details: {},
    ...(outcome === "failed" ? { isError: true } : {}),
  };
}

class ToolObservationPersistenceError extends Error {
  constructor(readonly outcome: "conflict" | "unavailable" | "unknown") {
    super("Tool Observation 未能形成 durable 事实");
    this.name = "ToolObservationPersistenceError";
  }
}

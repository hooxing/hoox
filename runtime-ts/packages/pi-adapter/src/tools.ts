import { createHash, randomUUID } from "node:crypto";
import type {
  ControlledToolReceiptSource,
  ToolObservationResult,
} from "@cube-runtime/context-policy";
import { encodeControlledToolReceipt } from "@cube-runtime/context-policy";
import { type SandboxHandle, SandboxRuntimeError } from "@cube-runtime/sandbox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

export const SANDBOX_TOOL_NAMES = ["exec_command"] as const;

const DEFAULT_WORKDIR = "/workspace";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const MAX_OUTPUT_TOKENS = 20_000;
const APPROX_BYTES_PER_TOKEN = 4;
const TRUNCATION_MARKER = "\n...[输出已截断]...\n";
const ExecCommandArgumentsSchema = Type.Object(
  {
    cmd: Type.String({ minLength: 1 }),
    workdir: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, pattern: "^/" })),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_MS })),
    max_output_tokens: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OUTPUT_TOKENS })),
  },
  { additionalProperties: false },
);
type ExecCommandArguments = Static<typeof ExecCommandArgumentsSchema>;

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

export interface ExecCommandResult {
  readonly exit_code: number;
  readonly wall_time_seconds: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output_truncated: boolean;
  readonly original_output_bytes: number;
}

/**
 * Pi 会在 execute 之前拦截 schema 错误，使 Runtime 无法持久化对应的 tool_call/tool_result。
 * 这里把原始 schema 不通过的输入换成一次性、schema 合法的内部占位参数；工具
 * execute 识别后只写 durable 失败回执，不得申请副作用许可或触碰外部端口。
 */
export function createSchemaInvalidArgumentsBridge<T>(
  schema: TSchema,
  fallback: (token: string) => T,
  tokenOf: (value: T) => string | undefined,
): Readonly<{
  prepareArguments(value: unknown): T;
  consume(value: T): boolean;
}> {
  const pending = new Set<string>();
  return Object.freeze({
    prepareArguments(value: unknown): T {
      if (Value.Check(schema, value)) return value as T;
      const token = randomUUID();
      pending.add(token);
      return fallback(token);
    },
    consume(value: T): boolean {
      const token = tokenOf(value);
      return token !== undefined && pending.delete(token);
    },
  });
}

export function createSandboxTools(
  sandbox: SandboxHandle,
  authorizer: SandboxToolEffectAuthorizer,
) {
  return createSandboxToolsInternal(sandbox, authorizer);
}

/**
 * Tool 的真实有界结果直接返回 Pi；固定回执仍只承担 durable tool_call/tool_result 配对。
 * TODO(codex-alignment): 将真实结果纳入可恢复的终端 transcript，避免 Session 重建后只剩完成回执。
 */
export function createObservedSandboxTools(
  sandbox: SandboxHandle,
  authorizer: SandboxToolEffectAuthorizer,
  createRecorder: (outputs: ControlledToolReceiptSource) => {
    record(input: {
      readonly toolCallId: string;
      readonly toolName: string;
    }): Promise<ToolObservationResult>;
  },
  rejectModelContinuation: () => void = () => undefined,
): {
  readonly tools: ReturnType<typeof createSandboxTools>;
  readonly outputs: ControlledToolReceiptSource;
  /** 仅供同一 Pi Session 内的其他受审工具写入相同固定回执与 durable result。 */
  readonly recordControlledReceipt: (
    callId: string,
    toolName: string,
    outcome: "succeeded" | "failed",
  ) => Promise<ToolObservationResult>;
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
    try {
      const result = await recorder.record({
        toolCallId: callId,
        toolName: name,
      });
      if (result.outcome !== "recorded" && result.outcome !== "replayed") {
        rejectModelContinuation();
      }
      return result;
    } catch (error) {
      rejectModelContinuation();
      throw error;
    }
  };
  return {
    tools: createSandboxToolsInternal(sandbox, authorizer, capture, rejectModelContinuation),
    outputs: source,
    recordControlledReceipt: (callId, toolName, outcome) =>
      capture(callId, toolName, encodeControlledToolReceipt(toolName, outcome)),
  };
}

function createSandboxToolsInternal(
  sandbox: SandboxHandle,
  authorizer: SandboxToolEffectAuthorizer,
  capture?: (callId: string, name: string, text: string) => Promise<ToolObservationResult>,
  rejectModelContinuation: () => void = () => undefined,
) {
  // TODO(codex-alignment): 同步 MVP 暂无 PTY、yield/session、write_stdin、shell/login 参数；
  // 即使允许最长 1 小时，长任务仍未对齐 Codex 返回 session_id 后 wait/write_stdin 的可恢复会话模式。
  const execArguments = createSchemaInvalidArgumentsBridge<ExecCommandArguments>(
    ExecCommandArgumentsSchema,
    (token) => ({ cmd: token }),
    (value) => value.cmd,
  );
  return [
    defineTool({
      name: "exec_command",
      label: "执行 Sandbox 命令",
      description:
        "在当前 CubeSandbox 中同步执行 Bash 命令并返回真实输出。默认工作目录是 /workspace；可使用 Shell、Python 和常规命令读写 Sandbox 文件。",
      // Rollout 的 tool_call 必须等本次副作用对应的 tool_result 落库后才能开放下一对。
      // Pi 仍接受同一模型消息中的多个调用，但按消息顺序完成每个 durable pair。
      executionMode: "sequential",
      parameters: ExecCommandArgumentsSchema,
      prepareArguments: execArguments.prepareArguments,
      execute: async (callId, params, signal) => {
        const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
        const maxOutputTokens = params.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
        const workdir = params.workdir ?? DEFAULT_WORKDIR;
        if (execArguments.consume(params)) {
          await persistReceipt(callId, "failed", capture);
          throw new Error(
            JSON.stringify({ code: "EXEC_INVALID_ARGUMENTS", message: "exec_command 参数无效" }),
          );
        }
        let effectRejected = false;
        let result: ExecCommandResult;
        try {
          const authorization = await authorizeTool(authorizer, callId, "exec_command", params);
          assertImmediateContinuation(authorization, signal);
          const startedAt = performance.now();
          const commandOutput = await sandbox.command(buildBashCommand(params.cmd, workdir), {
            ...signalControl(signal),
            timeoutMs,
          });
          result = projectCommandResult(
            commandOutput,
            Math.max(0, performance.now() - startedAt),
            maxOutputTokens,
          );
        } catch (error) {
          effectRejected = error instanceof ToolEffectRejectedError;
          await persistReceipt(callId, "failed", capture);
          if (effectRejected) rejectModelContinuation();
          throw new Error(projectInfrastructureError(error, timeoutMs));
        }
        await persistReceipt(callId, "succeeded", capture);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
        };
      },
    }),
  ];
}

async function persistReceipt(
  callId: string,
  outcome: "succeeded" | "failed",
  capture:
    | ((callId: string, name: string, text: string) => Promise<ToolObservationResult>)
    | undefined,
): Promise<void> {
  const text = encodeControlledToolReceipt("exec_command", outcome);
  const observation = await capture?.(callId, "exec_command", text);
  if (
    observation !== undefined &&
    observation.outcome !== "recorded" &&
    observation.outcome !== "replayed"
  ) {
    throw new ToolObservationPersistenceError(observation.outcome);
  }
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
    throw new ToolEffectRejectedError("Runtime 已拒绝本次工具副作用");
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
    throw new ToolEffectRejectedError("Runtime 工具副作用许可已过期或调用已取消");
  }
}

function buildBashCommand(cmd: string, workdir: string): string {
  if (!workdir.startsWith("/") || workdir.includes("\0")) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "workdir 必须是 Sandbox Linux 绝对路径");
  }
  // SDK 暂无 cwd/shell 独立参数，用安全引号把工作目录和命令交给固定 Bash。
  // TODO(codex-alignment): CubeSandbox SDK 支持 cwd 后改为参数传递，不再由包装命令切换目录。
  return `cd -- ${shellQuote(workdir)} && exec /bin/bash -c ${shellQuote(cmd)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function projectCommandResult(
  output: { readonly stdout: string; readonly stderr: string; readonly exitCode: number },
  wallTimeMs: number,
  maxOutputTokens: number,
): ExecCommandResult {
  const stdoutBytes = Buffer.byteLength(output.stdout, "utf8");
  const stderrBytes = Buffer.byteLength(output.stderr, "utf8");
  const originalOutputBytes = stdoutBytes + stderrBytes;
  // TODO(codex-alignment): 接入与当前模型一致的 tokenizer；同步 MVP 先按 4 UTF-8 bytes/token 近似。
  const byteBudget = maxOutputTokens * APPROX_BYTES_PER_TOKEN;
  const truncated = truncateStreams(output.stdout, output.stderr, byteBudget);
  return Object.freeze({
    exit_code: output.exitCode,
    wall_time_seconds: Number((wallTimeMs / 1000).toFixed(3)),
    stdout: truncated.stdout,
    stderr: truncated.stderr,
    output_truncated: originalOutputBytes > byteBudget,
    original_output_bytes: originalOutputBytes,
  });
}

function truncateStreams(
  stdout: string,
  stderr: string,
  byteBudget: number,
): { readonly stdout: string; readonly stderr: string } {
  const stdoutBytes = Buffer.byteLength(stdout, "utf8");
  const stderrBytes = Buffer.byteLength(stderr, "utf8");
  const totalBytes = stdoutBytes + stderrBytes;
  if (totalBytes <= byteBudget) return { stdout, stderr };
  if (totalBytes === 0 || byteBudget === 0) return { stdout: "", stderr: "" };
  const stdoutBudget = Math.floor((byteBudget * stdoutBytes) / totalBytes);
  const stderrBudget = byteBudget - stdoutBudget;
  return {
    stdout: truncateHeadTailUtf8(stdout, stdoutBudget),
    stderr: truncateHeadTailUtf8(stderr, stderrBudget),
  };
}

function truncateHeadTailUtf8(value: string, byteBudget: number): string {
  if (Buffer.byteLength(value, "utf8") <= byteBudget) return value;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  if (byteBudget <= markerBytes) return takeUtf8Prefix(value, byteBudget);
  const contentBudget = byteBudget - markerBytes;
  const headBudget = Math.ceil(contentBudget / 2);
  const tailBudget = contentBudget - headBudget;
  return `${takeUtf8Prefix(value, headBudget)}${TRUNCATION_MARKER}${takeUtf8Suffix(value, tailBudget)}`;
}

function takeUtf8Prefix(value: string, byteBudget: number): string {
  let used = 0;
  let result = "";
  for (const point of value) {
    const bytes = Buffer.byteLength(point, "utf8");
    if (used + bytes > byteBudget) break;
    result += point;
    used += bytes;
  }
  return result;
}

function takeUtf8Suffix(value: string, byteBudget: number): string {
  let used = 0;
  const points = [...value];
  const result: string[] = [];
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index] ?? "";
    const bytes = Buffer.byteLength(point, "utf8");
    if (used + bytes > byteBudget) break;
    result.push(point);
    used += bytes;
  }
  return result.reverse().join("");
}

function projectInfrastructureError(error: unknown, timeoutMs: number): string {
  if (error instanceof ToolEffectRejectedError) {
    return JSON.stringify({ code: "EXEC_REJECTED", message: error.message });
  }
  if (error instanceof SandboxRuntimeError) {
    if (error.code === "TIMEOUT") {
      // TODO(codex-alignment): 当前 SDK 超时异常不携带可验证的部分 stdout/stderr。
      return JSON.stringify({
        code: "EXEC_TIMEOUT",
        message: `命令执行超过 ${timeoutMs} 毫秒`,
      });
    }
    if (error.code === "CANCELLED") {
      return JSON.stringify({ code: "EXEC_CANCELLED", message: "命令执行已取消" });
    }
    if (error.code === "INVALID_ARGUMENT") {
      return JSON.stringify({ code: "EXEC_INVALID_ARGUMENT", message: error.message });
    }
  }
  return JSON.stringify({ code: "EXEC_UNAVAILABLE", message: "CubeSandbox 命令服务暂时不可用" });
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

class ToolEffectRejectedError extends Error {
  override readonly name = "ToolEffectRejectedError";
}

class ToolObservationPersistenceError extends Error {
  constructor(readonly outcome: "conflict" | "unavailable" | "unknown") {
    super("Tool Observation 未能形成 durable 事实");
    this.name = "ToolObservationPersistenceError";
  }
}

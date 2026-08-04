import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type {
  ControlledToolReceiptSource,
  ToolObservationResult,
} from "@cube-runtime/context-policy";
import { encodeControlledToolReceipt } from "@cube-runtime/context-policy";
import { type SandboxHandle, SandboxRuntimeError } from "@cube-runtime/sandbox";
import { defineTool, truncateHead } from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

export const SANDBOX_TOOL_NAMES = ["exec_command", "read", "edit", "write"] as const;

const DEFAULT_WORKDIR = "/workspace";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const MAX_OUTPUT_TOKENS = 20_000;
const APPROX_BYTES_PER_TOKEN = 4;
const TRUNCATION_MARKER = "\n...[输出已截断]...\n";
const DEFAULT_MAX_READ_LINES = 2_000;
const DEFAULT_MAX_READ_BYTES = 50 * 1_024;
const MAX_INLINE_IMAGE_BYTES = 32 * 1_024 * 1_024;
const IMAGE_SNIFF_BYTES = 4_100;
const INVALID_ARGUMENT_PATH_PREFIX = "/workspace/.runtime-invalid/";
const strictSchema = { additionalProperties: false } as const;
const sandboxFileMutationQueues = new WeakMap<SandboxHandle, Map<string, Promise<void>>>();
const SANDBOX_INFRASTRUCTURE_FAILURE_LIMIT = 3;
export type ToolContinuationFailure = "SANDBOX_FAILED";
type RejectModelContinuation = (failure?: ToolContinuationFailure) => void;
const ExecCommandArgumentsSchema = Type.Object(
  {
    cmd: Type.String({ minLength: 1 }),
    workdir: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, pattern: "^/" })),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_MS })),
    max_output_tokens: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OUTPUT_TOKENS })),
  },
  strictSchema,
);
type ExecCommandArguments = Static<typeof ExecCommandArgumentsSchema>;

const ReadArgumentsSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(
    Type.Number({ description: "Line number to start reading from (1-indexed)" }),
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});
type ReadArguments = Static<typeof ReadArgumentsSchema>;

const EditReplacementSchema = Type.Object({
  oldText: Type.String({
    description:
      "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
  }),
  newText: Type.String({ description: "Replacement text for this targeted edit." }),
});
const EditArgumentsSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  edits: Type.Array(EditReplacementSchema, {
    description:
      "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
  }),
});
type EditArguments = Static<typeof EditArgumentsSchema>;

const WriteArgumentsSchema = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
});
type WriteArguments = Static<typeof WriteArgumentsSchema>;

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

export interface SandboxToolHandleProvider {
  /** 在短时副作用许可签发前准备 Sandbox，避免 acquire/materialize 消耗许可窗口。 */
  prepareSandboxTool(input: {
    readonly callId: string;
    readonly toolName: string;
    readonly argsDigest: string;
    readonly signal?: AbortSignal;
  }): Promise<SandboxHandle>;
}

type SandboxToolTarget = SandboxHandle | SandboxToolHandleProvider;

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
  sandbox: SandboxToolTarget,
  authorizer: SandboxToolEffectAuthorizer,
) {
  return createSandboxToolsInternal(sandbox, authorizer);
}

/**
 * Tool 的真实有界结果直接返回 Pi；固定回执仍只承担 durable tool_call/tool_result 配对。
 * TODO(codex-alignment): 将真实结果纳入可恢复的终端 transcript，避免 Session 重建后只剩完成回执。
 */
export function createObservedSandboxTools(
  sandbox: SandboxToolTarget,
  authorizer: SandboxToolEffectAuthorizer,
  createRecorder: (outputs: ControlledToolReceiptSource) => {
    record(input: {
      readonly toolCallId: string;
      readonly toolName: string;
    }): Promise<ToolObservationResult>;
  },
  rejectModelContinuation: RejectModelContinuation = () => undefined,
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
  sandbox: SandboxToolTarget,
  authorizer: SandboxToolEffectAuthorizer,
  capture?: (callId: string, name: string, text: string) => Promise<ToolObservationResult>,
  rejectModelContinuation: RejectModelContinuation = () => undefined,
) {
  const execInfrastructureCircuit = createSandboxInfrastructureCircuit();
  const execArguments = createSchemaInvalidArgumentsBridge<ExecCommandArguments>(
    ExecCommandArgumentsSchema,
    (token) => ({ cmd: token }),
    (value) => value.cmd,
  );
  const readArguments = createSchemaInvalidArgumentsBridge<ReadArguments>(
    ReadArgumentsSchema,
    (token) => ({ path: `${INVALID_ARGUMENT_PATH_PREFIX}${token}` }),
    (value) => value.path.slice(INVALID_ARGUMENT_PATH_PREFIX.length),
  );
  const editArguments = createSchemaInvalidArgumentsBridge<EditArguments>(
    EditArgumentsSchema,
    (token) => ({
      path: `${INVALID_ARGUMENT_PATH_PREFIX}${token}`,
      edits: [{ oldText: token, newText: "" }],
    }),
    (value) => value.path.slice(INVALID_ARGUMENT_PATH_PREFIX.length),
  );
  const writeArguments = createSchemaInvalidArgumentsBridge<WriteArguments>(
    WriteArgumentsSchema,
    (token) => ({ path: `${INVALID_ARGUMENT_PATH_PREFIX}${token}`, content: "" }),
    (value) => value.path.slice(INVALID_ARGUMENT_PATH_PREFIX.length),
  );
  return [
    createExecCommandTool(
      sandbox,
      authorizer,
      execArguments,
      capture,
      rejectModelContinuation,
      execInfrastructureCircuit,
    ),
    createReadTool(sandbox, authorizer, readArguments, capture, rejectModelContinuation),
    createEditTool(sandbox, authorizer, editArguments, capture, rejectModelContinuation),
    createWriteTool(sandbox, authorizer, writeArguments, capture, rejectModelContinuation),
  ];
}

function createExecCommandTool(
  sandbox: SandboxToolTarget,
  authorizer: SandboxToolEffectAuthorizer,
  invalidArguments: ReturnType<typeof createSchemaInvalidArgumentsBridge<ExecCommandArguments>>,
  capture:
    | ((callId: string, name: string, text: string) => Promise<ToolObservationResult>)
    | undefined,
  rejectModelContinuation: RejectModelContinuation,
  infrastructureCircuit: SandboxInfrastructureCircuit,
) {
  // TODO(codex-alignment): 同步 MVP 暂无 PTY、yield/session、write_stdin、shell/login 参数；
  // 即使允许最长 1 小时，长任务仍未对齐 Codex 返回 session_id 后 wait/write_stdin 的可恢复会话模式。
  return defineTool({
    name: "exec_command",
    label: "执行 Sandbox 命令",
    description:
      "在当前 CubeSandbox 中同步执行 Bash 命令并返回真实输出。默认工作目录是 /workspace；可使用 Shell、Python 和常规命令读写 Sandbox 文件。",
    // Rollout 的 tool_call 必须等本次副作用对应的 tool_result 落库后才能开放下一对。
    // Pi 仍接受同一模型消息中的多个调用，但按消息顺序完成每个 durable pair。
    executionMode: "sequential",
    parameters: ExecCommandArgumentsSchema,
    prepareArguments: invalidArguments.prepareArguments,
    execute: async (callId, params, signal) => {
      const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      const maxOutputTokens = params.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
      const workdir = params.workdir ?? DEFAULT_WORKDIR;
      if (invalidArguments.consume(params)) {
        await persistReceipt(callId, "exec_command", "failed", capture);
        throw new Error(
          JSON.stringify({ code: "EXEC_INVALID_ARGUMENTS", message: "exec_command 参数无效" }),
        );
      }
      if (infrastructureCircuit.isOpen()) {
        await persistReceipt(callId, "exec_command", "failed", capture);
        rejectModelContinuation("SANDBOX_FAILED");
        throw new Error(execUnavailableError());
      }
      let effectRejected = false;
      let result: ExecCommandResult;
      try {
        const preparedSandbox = await prepareSandboxTool(
          sandbox,
          callId,
          "exec_command",
          params,
          signal,
        );
        const authorization = await authorizeTool(authorizer, callId, "exec_command", params);
        assertImmediateContinuation(authorization, signal);
        const startedAt = performance.now();
        const commandOutput = await preparedSandbox.command(buildBashCommand(params.cmd, workdir), {
          ...signalControl(signal),
          timeoutMs,
        });
        result = projectCommandResult(
          commandOutput,
          Math.max(0, performance.now() - startedAt),
          maxOutputTokens,
        );
        infrastructureCircuit.recordSuccess();
      } catch (error) {
        effectRejected = error instanceof ToolEffectRejectedError;
        await persistReceipt(callId, "exec_command", "failed", capture);
        if (effectRejected) rejectModelContinuation();
        if (
          !effectRejected &&
          isSandboxInfrastructureFailure(error) &&
          infrastructureCircuit.recordFailure()
        ) {
          // 同一 Sandbox 的命令数据面连续失败后不会靠模型改写命令恢复；持久化第三个
          // 失败回执后关闭下一次 Provider 请求，避免无界消耗 token 和副作用许可。
          rejectModelContinuation("SANDBOX_FAILED");
        }
        throw new Error(projectInfrastructureError(error, timeoutMs));
      }
      await persistReceipt(callId, "exec_command", "succeeded", capture);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}

function createReadTool(
  sandbox: SandboxToolTarget,
  authorizer: SandboxToolEffectAuthorizer,
  invalidArguments: ReturnType<typeof createSchemaInvalidArgumentsBridge<ReadArguments>>,
  capture:
    | ((callId: string, name: string, text: string) => Promise<ToolObservationResult>)
    | undefined,
  rejectModelContinuation: RejectModelContinuation,
) {
  return defineTool({
    name: "read",
    label: "读取 Sandbox 文件",
    description:
      "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
    executionMode: "sequential",
    parameters: ReadArgumentsSchema,
    prepareArguments: invalidArguments.prepareArguments,
    execute: async (callId, params, signal) => {
      if (invalidArguments.consume(params)) {
        await persistReceipt(callId, "read", "failed", capture);
        throw new Error(fileToolError("READ_INVALID_ARGUMENTS", "read 参数无效"));
      }
      let effectRejected = false;
      let result: {
        readonly content: Array<
          | { readonly type: "text"; readonly text: string }
          | { readonly type: "image"; readonly data: string; readonly mimeType: string }
        >;
        readonly details: Readonly<Record<string, unknown>>;
      };
      try {
        assertReadRange(params.offset, "offset");
        assertReadRange(params.limit, "limit");
        const path = resolveSandboxPath(params.path);
        const preparedSandbox = await prepareSandboxTool(sandbox, callId, "read", params, signal);
        const authorization = await authorizeTool(authorizer, callId, "read", params);
        assertImmediateContinuation(authorization, signal);
        const probe = await preparedSandbox.command(
          buildBase64ReadCommand(path, IMAGE_SNIFF_BYTES),
          {
            ...signalControl(signal),
            timeoutMs: DEFAULT_TIMEOUT_MS,
          },
        );
        if (probe.exitCode !== 0) {
          throw new FileToolUsageError("READ_NOT_FOUND", "无法读取指定的 Sandbox 文件");
        }
        const mimeType = detectSupportedImageMimeType(decodeBase64Output(probe.stdout));
        let content: Array<
          | { readonly type: "text"; readonly text: string }
          | { readonly type: "image"; readonly data: string; readonly mimeType: string }
        >;
        let details: Readonly<Record<string, unknown>>;
        if (mimeType === undefined) {
          const text = await preparedSandbox.readFile(path, {
            ...signalControl(signal),
            timeoutMs: DEFAULT_TIMEOUT_MS,
          });
          const projected = projectTextRead(text, params);
          content = [{ type: "text", text: projected.text }];
          details = projected.details;
        } else {
          const image = await preparedSandbox.command(buildBase64ReadCommand(path), {
            ...signalControl(signal),
            timeoutMs: DEFAULT_TIMEOUT_MS,
          });
          if (image.exitCode !== 0) {
            throw new FileToolUsageError("READ_NOT_FOUND", "无法读取指定的 Sandbox 图片");
          }
          const bytes = decodeBase64Output(image.stdout);
          if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
            throw new FileToolUsageError(
              "READ_IMAGE_TOO_LARGE",
              "图片超过 32MB 的模型内联输入上限",
            );
          }
          const verifiedMimeType = detectSupportedImageMimeType(bytes);
          if (verifiedMimeType === undefined) {
            throw new FileToolUsageError("READ_INVALID_IMAGE", "图片内容与受支持的格式不匹配");
          }
          content = [
            { type: "text", text: `Read image file [${verifiedMimeType}]` },
            {
              type: "image",
              data: bytes.toString("base64"),
              mimeType: verifiedMimeType,
            },
          ];
          details = Object.freeze({ path, media_type: verifiedMimeType, bytes: bytes.byteLength });
        }
        result = { content, details };
      } catch (error) {
        effectRejected = error instanceof ToolEffectRejectedError;
        await persistReceipt(callId, "read", "failed", capture);
        if (effectRejected) rejectModelContinuation();
        throw new Error(projectFileToolError("READ", error));
      }
      await persistReceipt(callId, "read", "succeeded", capture);
      return result;
    },
  });
}

function createEditTool(
  sandbox: SandboxToolTarget,
  authorizer: SandboxToolEffectAuthorizer,
  invalidArguments: ReturnType<typeof createSchemaInvalidArgumentsBridge<EditArguments>>,
  capture:
    | ((callId: string, name: string, text: string) => Promise<ToolObservationResult>)
    | undefined,
  rejectModelContinuation: RejectModelContinuation,
) {
  return defineTool({
    name: "edit",
    label: "精确修改 Sandbox 文件",
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    executionMode: "sequential",
    parameters: EditArgumentsSchema,
    prepareArguments: invalidArguments.prepareArguments,
    execute: async (callId, params, signal) => {
      if (invalidArguments.consume(params)) {
        await persistReceipt(callId, "edit", "failed", capture);
        throw new Error(fileToolError("EDIT_INVALID_ARGUMENTS", "edit 参数无效"));
      }
      let effectRejected = false;
      let result: {
        readonly content: Array<{ readonly type: "text"; readonly text: string }>;
        readonly details: Readonly<Record<string, unknown>>;
      };
      try {
        if (params.edits.length === 0) {
          throw new FileToolUsageError("EDIT_INVALID_ARGUMENTS", "edits 至少需要一个替换项");
        }
        const path = resolveSandboxPath(params.path);
        const preparedSandbox = await prepareSandboxTool(sandbox, callId, "edit", params, signal);
        result = await withSandboxFileMutation(preparedSandbox, path, async () => {
          const authorization = await authorizeTool(authorizer, callId, "edit", params);
          assertImmediateContinuation(authorization, signal);
          const original = await preparedSandbox.readFile(path, {
            ...signalControl(signal),
            timeoutMs: DEFAULT_TIMEOUT_MS,
          });
          const applied = applyExactEdits(original, params.edits);
          if (signal?.aborted) {
            throw new SandboxRuntimeError("CANCELLED", "文件修改已取消");
          }
          await preparedSandbox.writeFile(path, applied.content, {
            ...signalControl(signal),
            timeoutMs: DEFAULT_TIMEOUT_MS,
          });
          const details = Object.freeze({
            path,
            replacements: params.edits.length,
            bytes: Buffer.byteLength(applied.content, "utf8"),
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `Successfully applied ${params.edits.length} replacement(s) to ${params.path}`,
              },
            ],
            details,
          };
        });
      } catch (error) {
        effectRejected = error instanceof ToolEffectRejectedError;
        await persistReceipt(callId, "edit", "failed", capture);
        if (effectRejected) rejectModelContinuation();
        throw new Error(projectFileToolError("EDIT", error));
      }
      await persistReceipt(callId, "edit", "succeeded", capture);
      return result;
    },
  });
}

function createWriteTool(
  sandbox: SandboxToolTarget,
  authorizer: SandboxToolEffectAuthorizer,
  invalidArguments: ReturnType<typeof createSchemaInvalidArgumentsBridge<WriteArguments>>,
  capture:
    | ((callId: string, name: string, text: string) => Promise<ToolObservationResult>)
    | undefined,
  rejectModelContinuation: RejectModelContinuation,
) {
  return defineTool({
    name: "write",
    label: "写入 Sandbox 文件",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    executionMode: "sequential",
    parameters: WriteArgumentsSchema,
    prepareArguments: invalidArguments.prepareArguments,
    execute: async (callId, params, signal) => {
      if (invalidArguments.consume(params)) {
        await persistReceipt(callId, "write", "failed", capture);
        throw new Error(fileToolError("WRITE_INVALID_ARGUMENTS", "write 参数无效"));
      }
      let effectRejected = false;
      let result: {
        readonly content: Array<{ readonly type: "text"; readonly text: string }>;
        readonly details: Readonly<Record<string, unknown>>;
      };
      try {
        const path = resolveSandboxPath(params.path);
        const preparedSandbox = await prepareSandboxTool(sandbox, callId, "write", params, signal);
        result = await withSandboxFileMutation(preparedSandbox, path, async () => {
          const authorization = await authorizeTool(authorizer, callId, "write", params);
          assertImmediateContinuation(authorization, signal);
          const prepared = await preparedSandbox.command(
            `mkdir -p -- ${shellQuote(posix.dirname(path))}`,
            {
              ...signalControl(signal),
              timeoutMs: DEFAULT_TIMEOUT_MS,
            },
          );
          if (prepared.exitCode !== 0) {
            throw new FileToolUsageError("WRITE_PARENT_FAILED", "无法创建 Sandbox 父目录");
          }
          if (signal?.aborted) {
            throw new SandboxRuntimeError("CANCELLED", "文件写入已取消");
          }
          await preparedSandbox.writeFile(path, params.content, {
            ...signalControl(signal),
            timeoutMs: DEFAULT_TIMEOUT_MS,
          });
          const bytes = Buffer.byteLength(params.content, "utf8");
          return {
            content: [
              {
                type: "text" as const,
                text: `Successfully wrote ${bytes} bytes to ${params.path}`,
              },
            ],
            details: Object.freeze({ path, bytes }),
          };
        });
      } catch (error) {
        effectRejected = error instanceof ToolEffectRejectedError;
        await persistReceipt(callId, "write", "failed", capture);
        if (effectRejected) rejectModelContinuation();
        throw new Error(projectFileToolError("WRITE", error));
      }
      await persistReceipt(callId, "write", "succeeded", capture);
      return result;
    },
  });
}

async function persistReceipt(
  callId: string,
  toolName: string,
  outcome: "succeeded" | "failed",
  capture:
    | ((callId: string, name: string, text: string) => Promise<ToolObservationResult>)
    | undefined,
): Promise<void> {
  const text = encodeControlledToolReceipt(toolName, outcome);
  const observation = await capture?.(callId, toolName, text);
  if (
    observation !== undefined &&
    observation.outcome !== "recorded" &&
    observation.outcome !== "replayed"
  ) {
    throw new ToolObservationPersistenceError(observation.outcome);
  }
}

async function prepareSandboxTool(
  target: SandboxToolTarget,
  callId: string,
  toolName: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<SandboxHandle> {
  if (!("prepareSandboxTool" in target)) return target;
  try {
    return await target.prepareSandboxTool({
      callId,
      toolName,
      argsDigest: createHash("sha256").update(canonicalJson(args)).digest("hex"),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new ToolEffectRejectedError("Runtime 未能准备本次工具所需的 Sandbox");
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

function resolveSandboxPath(path: string): string {
  if (path.length === 0 || path.length > 4_096 || path.includes("\0")) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "Sandbox 文件路径不能为空、超长或包含 NUL");
  }
  const resolved = path.startsWith("/")
    ? posix.normalize(path)
    : posix.resolve(DEFAULT_WORKDIR, path);
  if (!resolved.startsWith("/") || resolved.length > 4_096) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "Sandbox 文件路径无效");
  }
  return resolved;
}

function assertReadRange(value: number | undefined, label: "offset" | "limit"): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new FileToolUsageError("READ_INVALID_ARGUMENTS", `${label} 必须是大于或等于 1 的整数`);
  }
}

async function withSandboxFileMutation<T>(
  sandbox: SandboxHandle,
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queues = sandboxFileMutationQueues.get(sandbox);
  if (queues === undefined) {
    queues = new Map();
    sandboxFileMutationQueues.set(sandbox, queues);
  }
  const previous = queues.get(path) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  queues.set(path, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(path) === tail) queues.delete(path);
  }
}

function buildBase64ReadCommand(path: string, byteLimit?: number): string {
  const command =
    byteLimit === undefined
      ? `base64 -w0 -- ${shellQuote(path)}`
      : `head -c ${byteLimit} -- ${shellQuote(path)} | base64 -w0`;
  return `exec /bin/bash -o pipefail -c ${shellQuote(command)}`;
}

function decodeBase64Output(value: string): Buffer {
  const normalized = value.replaceAll(/\s/gu, "");
  if (
    normalized.length % 4 === 1 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(normalized)
  ) {
    throw new Error("CubeSandbox 文件读取返回了无效 Base64");
  }
  return Buffer.from(normalized, "base64");
}

function detectSupportedImageMimeType(bytes: Uint8Array): string | undefined {
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWithAscii(bytes, 0, "GIF87a") || startsWithAscii(bytes, 0, "GIF89a")) {
    return "image/gif";
  }
  if (startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WEBP")) {
    return "image/webp";
  }
  if (startsWithAscii(bytes, 0, "BM") && bytes.byteLength >= 26) return "image/bmp";
  return undefined;
}

function startsWithBytes(value: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((byte, index) => value[index] === byte);
}

function startsWithAscii(value: Uint8Array, offset: number, expected: string): boolean {
  if (value.byteLength < offset + expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (value[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function projectTextRead(
  value: string,
  input: ReadArguments,
): {
  readonly text: string;
  readonly details: Readonly<Record<string, unknown>>;
} {
  const allLines = value.split("\n");
  const startIndex = (input.offset ?? 1) - 1;
  if (startIndex >= allLines.length) {
    throw new FileToolUsageError(
      "READ_OFFSET_OUT_OF_RANGE",
      `offset ${input.offset} 超过文件总行数 ${allLines.length}`,
    );
  }
  const startLine = startIndex + 1;
  const selectedEnd =
    input.limit === undefined
      ? allLines.length
      : Math.min(allLines.length, startIndex + input.limit);
  const selected = allLines.slice(startIndex, selectedEnd).join("\n");
  const truncation = truncateHead(selected, {
    maxLines: DEFAULT_MAX_READ_LINES,
    maxBytes: DEFAULT_MAX_READ_BYTES,
  });
  const endLine = truncation.outputLines === 0 ? startLine : startLine + truncation.outputLines - 1;
  let text: string;
  if (truncation.firstLineExceedsLimit) {
    text =
      `[Line ${startLine} exceeds the 50KB read limit. ` +
      `Use exec_command with a bounded byte-range command to inspect it.]`;
  } else if (truncation.truncated) {
    text =
      `${truncation.content}\n\n[Showing lines ${startLine}-${endLine} of ${allLines.length}` +
      `${truncation.truncatedBy === "bytes" ? " (50KB limit)" : ""}. ` +
      `Use offset=${endLine + 1} to continue.]`;
  } else if (input.limit !== undefined && selectedEnd < allLines.length) {
    text =
      `${truncation.content}\n\n[${allLines.length - selectedEnd} more lines in file. ` +
      `Use offset=${selectedEnd + 1} to continue.]`;
  } else {
    text = truncation.content;
  }
  return {
    text,
    details: Object.freeze({
      path: input.path,
      start_line: startLine,
      end_line: endLine,
      total_lines: allLines.length,
      truncated: truncation.truncated,
      ...(truncation.truncatedBy === null ? {} : { truncated_by: truncation.truncatedBy }),
    }),
  };
}

function applyExactEdits(
  original: string,
  edits: readonly Readonly<{ readonly oldText: string; readonly newText: string }>[],
): { readonly content: string } {
  // 与 Pi 一致地隐藏 UTF-8 BOM 并统一换行后匹配；写回时恢复原文件换行，
  // 使模型仍可提供可见的精确文本而无需猜测不可见编码细节。
  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
  const originalWithoutBom = bom === "" ? original : original.slice(1);
  const lineEnding = detectLineEnding(originalWithoutBom);
  const normalizedOriginal = normalizeLineEndings(originalWithoutBom);
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeLineEndings(edit.oldText),
    newText: normalizeLineEndings(edit.newText),
  }));
  const located = normalizedEdits.map((edit, index) => {
    if (edit.oldText.length === 0) {
      throw new FileToolUsageError("EDIT_EMPTY_OLD_TEXT", `edits[${index}].oldText 不能为空`);
    }
    const start = normalizedOriginal.indexOf(edit.oldText);
    if (start === -1) {
      throw new FileToolUsageError("EDIT_NO_MATCH", `edits[${index}].oldText 未在原文件中匹配`);
    }
    if (normalizedOriginal.indexOf(edit.oldText, start + 1) !== -1) {
      throw new FileToolUsageError("EDIT_NOT_UNIQUE", `edits[${index}].oldText 在原文件中不唯一`);
    }
    return { ...edit, index, start, end: start + edit.oldText.length };
  });
  located.sort((left, right) => left.start - right.start || left.index - right.index);
  for (let index = 1; index < located.length; index += 1) {
    const previous = located[index - 1];
    const current = located[index];
    if (previous !== undefined && current !== undefined && current.start < previous.end) {
      throw new FileToolUsageError(
        "EDIT_OVERLAP",
        `edits[${previous.index}] 与 edits[${current.index}] 在原文件中重叠`,
      );
    }
  }
  let content = normalizedOriginal;
  for (const edit of located.toReversed()) {
    content = `${content.slice(0, edit.start)}${edit.newText}${content.slice(edit.end)}`;
  }
  if (content === normalizedOriginal) {
    throw new FileToolUsageError("EDIT_NO_CHANGE", "替换后的文件内容没有变化");
  }
  return Object.freeze({
    content: `${bom}${lineEnding === "\r\n" ? content.replaceAll("\n", "\r\n") : content}`,
  });
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function detectLineEnding(value: string): "\n" | "\r\n" {
  const crlf = value.indexOf("\r\n");
  const lf = value.indexOf("\n");
  return crlf !== -1 && crlf < lf ? "\r\n" : "\n";
}

function projectFileToolError(prefix: "READ" | "EDIT" | "WRITE", error: unknown): string {
  if (error instanceof ToolEffectRejectedError) {
    return fileToolError(`${prefix}_REJECTED`, error.message);
  }
  if (error instanceof FileToolUsageError) return fileToolError(error.code, error.message);
  if (error instanceof SandboxRuntimeError) {
    if (error.code === "TIMEOUT") {
      return fileToolError(`${prefix}_TIMEOUT`, "Sandbox 文件操作超时");
    }
    if (error.code === "CANCELLED") {
      return fileToolError(`${prefix}_CANCELLED`, "Sandbox 文件操作已取消");
    }
    if (error.code === "NOT_FOUND") {
      return fileToolError(`${prefix}_NOT_FOUND`, "Sandbox 文件或目录不存在");
    }
    if (error.code === "INVALID_ARGUMENT") {
      return fileToolError(`${prefix}_INVALID_ARGUMENT`, error.message);
    }
  }
  return fileToolError(`${prefix}_UNAVAILABLE`, "CubeSandbox 文件服务暂时不可用");
}

function fileToolError(code: string, message: string): string {
  return JSON.stringify({ code, message });
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
  return execUnavailableError();
}

function execUnavailableError(): string {
  return JSON.stringify({ code: "EXEC_UNAVAILABLE", message: "CubeSandbox 命令服务暂时不可用" });
}

interface SandboxInfrastructureCircuit {
  isOpen(): boolean;
  recordFailure(): boolean;
  recordSuccess(): void;
}

function createSandboxInfrastructureCircuit(): SandboxInfrastructureCircuit {
  let failures = 0;
  return Object.freeze({
    isOpen: () => failures >= SANDBOX_INFRASTRUCTURE_FAILURE_LIMIT,
    recordFailure: () => {
      failures += 1;
      return failures >= SANDBOX_INFRASTRUCTURE_FAILURE_LIMIT;
    },
    recordSuccess: () => {
      failures = 0;
    },
  });
}

function isSandboxInfrastructureFailure(error: unknown): boolean {
  if (!(error instanceof SandboxRuntimeError)) return true;
  return !["TIMEOUT", "CANCELLED", "INVALID_ARGUMENT"].includes(error.code);
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

class FileToolUsageError extends Error {
  override readonly name = "FileToolUsageError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class ToolObservationPersistenceError extends Error {
  constructor(readonly outcome: "conflict" | "unavailable" | "unknown") {
    super("Tool Observation 未能形成 durable 事实");
    this.name = "ToolObservationPersistenceError";
  }
}

import {
  ApiError,
  AuthenticationError,
  CubeSandboxError,
  FilesystemNotFoundError,
  SandboxNotFoundError,
  TemplateNotFoundError,
} from "@cubesandbox/sdk";

export type SandboxErrorCode =
  | "CANCELLED"
  | "TIMEOUT"
  | "NOT_FOUND"
  | "AUTHENTICATION"
  | "INVALID_ARGUMENT"
  | "UNKNOWN"
  | "PROTOCOL"
  | "UPSTREAM";

/** 对外只暴露稳定错误码，禁止业务层依赖上游 SDK 的类名或英文消息。 */
export class SandboxRuntimeError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "SandboxRuntimeError";
  }
}

export function mapSandboxError(error: unknown, operation: string): SandboxRuntimeError {
  if (error instanceof SandboxRuntimeError) return error;
  if (
    error instanceof SandboxNotFoundError ||
    error instanceof TemplateNotFoundError ||
    error instanceof FilesystemNotFoundError
  ) {
    return new SandboxRuntimeError("NOT_FOUND", `${operation} 的目标不存在`, error);
  }
  if (error instanceof AuthenticationError) {
    return new SandboxRuntimeError("AUTHENTICATION", `${operation} 未通过 CubeSandbox 鉴权`, error);
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/abort|cancel/i.test(message)) {
    return new SandboxRuntimeError("CANCELLED", `${operation} 已取消`, error);
  }
  if (/timed?\s*out|timeout/i.test(message)) {
    return new SandboxRuntimeError("TIMEOUT", `${operation} 超时`, error);
  }
  if (/not[ -]?found|http\s*404/i.test(message)) {
    return new SandboxRuntimeError("NOT_FOUND", `${operation} 的目标不存在`, error);
  }
  if (error instanceof ApiError || error instanceof CubeSandboxError) {
    return new SandboxRuntimeError("UPSTREAM", `${operation} 的 CubeSandbox 请求失败`, error);
  }
  if (error instanceof SyntaxError || /invalid json|unexpected token/i.test(message)) {
    return new SandboxRuntimeError("PROTOCOL", `${operation} 收到无法解析的上游响应`, error);
  }
  return new SandboxRuntimeError("UPSTREAM", `${operation} 发生未知上游错误`, error);
}

/**
 * 不可远端取消操作的安全包装：AbortSignal 只记录取消请求，操作一旦开始就等待上游 settle。
 * 这样调用方不会在文件写入仍可能迟到时误以为操作已经停止。
 */
export async function settledOperation<T>(
  operation: string,
  action: () => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
  timeoutMode: "native" | "after-settle" = "after-settle",
): Promise<T> {
  assertPositiveInteger(options.timeoutMs, `${operation} timeoutMs`);
  if (options.signal?.aborted) {
    throw new SandboxRuntimeError(
      "CANCELLED",
      `${operation} 未开始：已请求取消`,
      options.signal.reason,
    );
  }

  let cancellationRequested = false;
  const onAbort = () => {
    cancellationRequested = true;
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const startedAt = Date.now();
  let result: T;
  try {
    result = await action();
  } catch (error) {
    throw mapSandboxError(error, operation);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }

  if (cancellationRequested) {
    throw new SandboxRuntimeError(
      "CANCELLED",
      `${operation} 已安全结束，但执行期间收到取消请求`,
      options.signal?.reason,
    );
  }
  if (
    timeoutMode === "after-settle" &&
    options.timeoutMs !== undefined &&
    Date.now() - startedAt >= options.timeoutMs
  ) {
    throw new SandboxRuntimeError("TIMEOUT", `${operation} 已安全结束，但超过调用方期限`);
  }
  return result;
}

export function assertPositiveInteger(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", `${label} 必须是正整数`);
  }
}

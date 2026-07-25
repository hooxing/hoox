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

export async function guardedOperation<T>(
  operation: string,
  action: () => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  if (options.signal?.aborted) {
    throw new SandboxRuntimeError("CANCELLED", `${operation} 已取消`, options.signal.reason);
  }

  let timer: NodeJS.Timeout | undefined;
  let removeAbort: (() => void) | undefined;
  try {
    const guards: Promise<never>[] = [];
    if (options.timeoutMs !== undefined) {
      guards.push(
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new SandboxRuntimeError("TIMEOUT", `${operation} 超时`)),
            options.timeoutMs,
          );
        }),
      );
    }
    if (options.signal) {
      guards.push(
        new Promise((_, reject) => {
          const listener = () =>
            reject(
              new SandboxRuntimeError("CANCELLED", `${operation} 已取消`, options.signal?.reason),
            );
          options.signal?.addEventListener("abort", listener, { once: true });
          removeAbort = () => options.signal?.removeEventListener("abort", listener);
        }),
      );
    }
    return await Promise.race([action(), ...guards]);
  } catch (error) {
    throw mapSandboxError(error, operation);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort?.();
  }
}

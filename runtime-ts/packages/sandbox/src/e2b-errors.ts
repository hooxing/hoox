import {
  AuthenticationError,
  FileNotFoundError,
  InvalidArgumentError,
  RateLimitError,
  SandboxError,
  SandboxNotFoundError,
  TemplateError,
  TimeoutError,
} from "e2b";
import { SandboxRuntimeError } from "./errors.js";

/** E2B 错误只映射为 Runtime 稳定码，禁止向业务层透出 SDK 消息。 */
export function mapE2BError(error: unknown, operation: string): SandboxRuntimeError {
  if (error instanceof SandboxRuntimeError) return error;
  if (error instanceof SandboxNotFoundError || error instanceof FileNotFoundError) {
    return new SandboxRuntimeError("NOT_FOUND", `${operation} 的目标不存在`, error);
  }
  if (error instanceof AuthenticationError) {
    return new SandboxRuntimeError("AUTHENTICATION", `${operation} 未通过 E2B 鉴权`, error);
  }
  if (error instanceof InvalidArgumentError) {
    return new SandboxRuntimeError("INVALID_ARGUMENT", `${operation} 的参数无效`, error);
  }
  if (error instanceof TimeoutError) {
    return new SandboxRuntimeError("TIMEOUT", `${operation} 超时`, error);
  }
  if (error instanceof TemplateError) {
    return new SandboxRuntimeError(
      "CREATE_UNAVAILABLE",
      `${operation} 的 E2B Template 不可用`,
      error,
    );
  }
  if (error instanceof RateLimitError) {
    return new SandboxRuntimeError("UPSTREAM", `${operation} 被 E2B 限流`, error);
  }
  const message = error instanceof Error ? error.message : String(error);
  // E2B SDK 2.x 会把部分 HTTP 400（例如账户 timeout 上限）包装成 SandboxError；
  // 必须先按明确的 400 响应归为参数错误，不能因正文含 timeout 而误报远端结果未知。
  if (/^(?:[^\d\r\n]*\s)?400\s*:/iu.test(message)) {
    return new SandboxRuntimeError("INVALID_ARGUMENT", `${operation} 的参数无效`, error);
  }
  if (/abort|cancel/iu.test(message)) {
    return new SandboxRuntimeError("CANCELLED", `${operation} 已取消`, error);
  }
  if (/timed?\s*out|timeout/iu.test(message)) {
    return new SandboxRuntimeError("TIMEOUT", `${operation} 超时`, error);
  }
  if (/not[ -]?found|http\s*404/iu.test(message)) {
    return new SandboxRuntimeError("NOT_FOUND", `${operation} 的目标不存在`, error);
  }
  if (error instanceof SyntaxError || /invalid json|unexpected token/iu.test(message)) {
    return new SandboxRuntimeError("PROTOCOL", `${operation} 收到无法解析的 E2B 响应`, error);
  }
  if (error instanceof SandboxError) {
    return new SandboxRuntimeError("UPSTREAM", `${operation} 的 E2B 请求失败`, error);
  }
  return new SandboxRuntimeError("UPSTREAM", `${operation} 发生未知 E2B 上游错误`, error);
}

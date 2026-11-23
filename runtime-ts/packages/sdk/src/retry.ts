import { HooxError } from "./errors.js";
import type { RetryOptions } from "./types.js";

export function retryPolicy(options: RetryOptions = {}) {
  const policy = {
    initialDelayMs: options.initialDelayMs ?? 250,
    maxDelayMs: options.maxDelayMs ?? 5_000,
    maxRetries: options.maxRetries ?? 8,
  };
  if (
    !Number.isFinite(policy.initialDelayMs) ||
    policy.initialDelayMs < 1 ||
    !Number.isFinite(policy.maxDelayMs) ||
    policy.maxDelayMs < policy.initialDelayMs ||
    !Number.isInteger(policy.maxRetries) ||
    policy.maxRetries < 0
  ) {
    throw new HooxError("重连配置无效", "INVALID_CONFIG");
  }
  return policy;
}

export function retryDelay(attempt: number, policy: ReturnType<typeof retryPolicy>): number {
  return Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** Math.min(attempt, 30));
}

export function aborted(): HooxError {
  return new HooxError("操作已取消", "ABORTED");
}

export async function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw aborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

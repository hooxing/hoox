import type { E2BSdkSandbox } from "./e2b-gateway.js";
import type { SandboxHandle } from "./types.js";

/**
 * 包内部模块，不从 index 导出。记录本包创建的 E2B Handle 到其 SDK 连接；外部对象（包括伪造的
 * 同形 Handle）永远查不到。
 */
const handleSdk = new WeakMap<object, E2BSdkSandbox>();

export function registerE2BHandleSdk(handle: SandboxHandle, sdk: E2BSdkSandbox): void {
  handleSdk.set(handle, sdk);
}

/**
 * Run 已经通过 create/connect 持有同一 Sandbox 的 Handle 时，Workspace 直接复用其 SDK 连接，
 * 省去一次控制面 connect（Demo 实测约 0.4～0.6 秒）。只接受本包创建且 ID 与可信 binding
 * 一致的 Handle；否则返回 undefined，由调用方照常 connect。
 */
export function reusableE2BSdk(
  handle: SandboxHandle | undefined,
  sessionId: string,
): E2BSdkSandbox | undefined {
  if (handle === undefined) return undefined;
  const sdk = handleSdk.get(handle);
  return sdk !== undefined && sdk.sandboxId === sessionId ? sdk : undefined;
}

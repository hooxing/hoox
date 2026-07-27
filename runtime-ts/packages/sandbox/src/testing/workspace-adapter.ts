import type { SandboxSessionIdentity } from "@cube-runtime/workspace";
import type { CubeSdkSandbox } from "../cube-gateway.js";
import {
  type CubeWorkspaceAdapterOptions,
  openCubeWorkspaceAdapterForTesting,
  type TrustedSandboxSessionCapability,
} from "../workspace-adapter.js";

/** 测试专用入口：只绕过宿主平台检查，不绕过 Session capability、路径或协议校验。 */
export function openWorkspaceAdapterForTesting(input: {
  readonly capability: TrustedSandboxSessionCapability;
  readonly identity: SandboxSessionIdentity;
  readonly sandbox: CubeSdkSandbox;
  readonly options: CubeWorkspaceAdapterOptions;
}) {
  return openCubeWorkspaceAdapterForTesting(input);
}

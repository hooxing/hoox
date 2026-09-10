import type { ResolvedSandboxProfile } from "@hoox/admin-control";
import { CubeTenantResourceVolume } from "@hoox/sandbox";
import {
  CubeSandboxSessionRegistry,
  E2BSandboxSessionRegistry,
  TencentAgsSandboxSessionRegistry,
} from "./production-worker-runtime.js";
import type { SandboxResourceFilesystemMaterializerPort } from "./sandbox-resource-filesystem-materializer.js";

export function createManagedSandboxRegistry(
  profile: ResolvedSandboxProfile,
  resourceVolumeDriver: string,
  materializer?: SandboxResourceFilesystemMaterializerPort,
) {
  const { providerKey, endpoint, policy } = profile.configuration;
  if (providerKey === "cube") {
    return new CubeSandboxSessionRegistry(
      {
        apiUrl: endpoint,
        apiKey: profile.apiKey ?? null,
        proxyNodeIp: profile.configuration.cubeProxy?.host ?? null,
        proxyPort: profile.configuration.cubeProxy?.port ?? 80,
        proxyScheme: profile.configuration.cubeProxy?.scheme ?? "http",
        defaultOperationTimeoutMs: policy.operationTimeoutMs,
      },
      policy.templateId,
      policy.sessionTtlSeconds,
      policy.lifecycleTimeoutMs,
      new CubeTenantResourceVolume({
        apiUrl: endpoint,
        apiKey: profile.apiKey ?? null,
        driver: resourceVolumeDriver,
        requestTimeoutMs: policy.operationTimeoutMs,
      }),
    );
  }
  if (!profile.apiKey) throw new Error("托管沙箱凭据缺失");
  const options = {
    apiKey: profile.apiKey,
    domain: endpoint,
    defaultOperationTimeoutMs: policy.operationTimeoutMs,
  };
  return providerKey === "e2b"
    ? new E2BSandboxSessionRegistry(
        options,
        policy.templateId,
        policy.sessionTtlSeconds,
        policy.lifecycleTimeoutMs,
        materializer,
      )
    : new TencentAgsSandboxSessionRegistry(
        options,
        policy.templateId,
        policy.sessionTtlSeconds,
        policy.lifecycleTimeoutMs,
        materializer,
      );
}

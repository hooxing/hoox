import type { ExecutionScope } from "@cube-runtime/run-contracts";
import type { SandboxHandle } from "@cube-runtime/sandbox";
import {
  type ResourceFilesystemCapabilityCodec,
  RESOURCE_FILESYSTEM_ROOT,
} from "@cube-runtime/resource";

export interface SandboxResourceFilesystemMounter {
  mount(input: { readonly scope: ExecutionScope; readonly sandbox: SandboxHandle }): Promise<void>;
}

/**
 * 当前作为 Worker 内部适配器装配；以后可连同 capability 签发和挂载观测拆成独立子模块，
 * 但 `/resources` 路径、只读语义和 WebDAV 边界保持不变。
 */
export class RcloneResourceFilesystemMounter implements SandboxResourceFilesystemMounter {
  private readonly endpoint: string;

  constructor(
    endpoint: string,
    private readonly capabilities: ResourceFilesystemCapabilityCodec,
    private readonly capabilityTtlSeconds: number,
  ) {
    const parsed = new URL(endpoint);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      !parsed.pathname.endsWith("/v1/resource-filesystem")
    ) {
      throw new TypeError("Resource 文件系统端点必须是无凭据的 HTTP(S) WebDAV URL");
    }
    if (
      !Number.isSafeInteger(capabilityTtlSeconds) ||
      capabilityTtlSeconds < 1 ||
      capabilityTtlSeconds > 86_400
    ) {
      throw new TypeError("Resource 文件系统 capability TTL 无效");
    }
    this.endpoint = parsed.toString().replace(/\/$/u, "");
  }

  async mount(input: {
    readonly scope: ExecutionScope;
    readonly sandbox: SandboxHandle;
  }): Promise<void> {
    const token = this.capabilities.issue({
      tenantId: input.scope.tenantId,
      sandboxId: input.sandbox.id,
      ttlSeconds: this.capabilityTtlSeconds,
    });
    const command = buildMountCommand(this.endpoint, token);
    const result = await input.sandbox.command(command, { timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new Error("RESOURCE_FILESYSTEM_MOUNT_FAILED");
  }
}

export function buildMountCommand(endpoint: string, token: string): string {
  const endpointArgument = shellQuote(endpoint);
  const tokenArgument = shellQuote(token);
  return `set -eu
command -v rclone >/dev/null
command -v fusermount3 >/dev/null
command -v mountpoint >/dev/null
mkdir -p ${RESOURCE_FILESYSTEM_ROOT} /tmp/resource-fs-cache /tmp/resource-fs-log
if mountpoint -q ${RESOURCE_FILESYSTEM_ROOT}; then
  fusermount3 -uz ${RESOURCE_FILESYSTEM_ROOT}
  for _resource_fs_wait in 1 2 3 4 5 6 7 8 9 10; do
    mountpoint -q ${RESOURCE_FILESYSTEM_ROOT} || break
    sleep 0.1
  done
fi
env \
  RCLONE_CONFIG_RESOURCEFS_TYPE=webdav \
  RCLONE_CONFIG_RESOURCEFS_URL=${endpointArgument} \
  RCLONE_CONFIG_RESOURCEFS_VENDOR=other \
  RCLONE_CONFIG_RESOURCEFS_BEARER_TOKEN=${tokenArgument} \
  rclone mount resourcefs: ${RESOURCE_FILESYSTEM_ROOT} \
    --read-only \
    --daemon \
    --daemon-timeout 20s \
    --dir-cache-time 30s \
    --poll-interval 0 \
    --vfs-cache-mode full \
    --vfs-cache-max-size 256M \
    --vfs-cache-max-age 1h \
    --cache-dir /tmp/resource-fs-cache \
    --log-file /tmp/resource-fs-log/rclone.log \
    --log-level NOTICE
for _resource_fs_ready in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  mountpoint -q ${RESOURCE_FILESYSTEM_ROOT} && exit 0
  sleep 0.25
done
exit 71`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

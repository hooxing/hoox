import { runId, tenantId, threadId, workspaceId } from "@cube-runtime/domain";
import { createResourceFilesystemCapabilityCodec } from "@cube-runtime/resource";
import type { ExecutionScope } from "@cube-runtime/run-contracts";
import type { SandboxHandle } from "@cube-runtime/sandbox";
import { describe, expect, it, vi } from "vitest";
import {
  buildMountCommand,
  RcloneResourceFilesystemMounter,
} from "./resource-filesystem-mounter.js";

const scope: ExecutionScope = {
  tenantId: tenantId("tenant-resource-mount"),
  threadId: threadId("thread-resource-mount"),
  runId: runId("run-resource-mount"),
  rootRunId: runId("run-resource-mount"),
  workspaceId: workspaceId("workspace-resource-mount"),
};

describe("Sandbox Resource 文件系统挂载", () => {
  it("以只读 rclone/FUSE 挂载稳定 /resources 路径", async () => {
    const command = vi.fn(
      async (_script: string, _control?: Parameters<SandboxHandle["command"]>[1]) => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      }),
    );
    const sandbox = sandboxFixture(command);
    const mounter = new RcloneResourceFilesystemMounter(
      "https://api.example.invalid/v1/resource-filesystem",
      createResourceFilesystemCapabilityCodec({
        secret: "resource-filesystem-mounter-test-key-32-bytes",
        now: () => 1_000,
      }),
      120,
    );

    await mounter.mount({ scope, sandbox });

    expect(command).toHaveBeenCalledOnce();
    const [script, control] = command.mock.calls[0] ?? [];
    expect(script).toContain("rclone mount resourcefs: /resources");
    expect(script).toContain("--read-only");
    expect(script).toContain("RCLONE_CONFIG_RESOURCEFS_TYPE=webdav");
    expect(script).toContain("https://api.example.invalid/v1/resource-filesystem");
    expect(control).toEqual({ timeoutMs: 30_000 });
  });

  it("挂载命令失败时关闭当前 Run，且端点参数经过 shell 引号边界", async () => {
    const command = vi.fn(
      async (_script: string, _control?: Parameters<SandboxHandle["command"]>[1]) => ({
        stdout: "",
        stderr: "denied",
        exitCode: 71,
      }),
    );
    const mounter = new RcloneResourceFilesystemMounter(
      "http://127.0.0.1:3001/v1/resource-filesystem",
      createResourceFilesystemCapabilityCodec({
        secret: "resource-filesystem-mounter-test-key-32-bytes",
      }),
      60,
    );
    await expect(mounter.mount({ scope, sandbox: sandboxFixture(command) })).rejects.toThrow(
      "RESOURCE_FILESYSTEM_MOUNT_FAILED",
    );
    expect(buildMountCommand("https://example.invalid/a'b", "token'x")).toContain(
      `'https://example.invalid/a'"'"'b'`,
    );
  });
});

function sandboxFixture(command: SandboxHandle["command"]): SandboxHandle {
  return {
    id: "sandbox-resource-mount",
    command,
    runCode: async () => ({ stdout: [], stderr: [] }),
    readFile: async () => "",
    writeFile: async () => undefined,
    pause: async () => undefined,
    kill: async () => undefined,
  };
}

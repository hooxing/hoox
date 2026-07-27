import { Buffer } from "node:buffer";
import type { SandboxSessionIdentity, WorkspaceDependencyError } from "@cube-runtime/workspace";
import { describe, expect, it } from "vitest";
import type { CubeSdkSandbox } from "./cube-gateway.js";
import { openWorkspaceAdapterForTesting } from "./testing/workspace-adapter.js";

const IDENTITY: SandboxSessionIdentity = Object.freeze({
  sessionId: "sandbox-workspace-1",
  generation: 1,
});

const OPTIONS = Object.freeze({
  maxEntries: 16,
  maxFileBytes: 1024,
  maxTotalBytes: 4096,
  maxPathUtf8Bytes: 256,
  maxCommandOutputBytes: 2048,
  readChunkBytes: 4,
  maxSnapshots: 4,
  operationTimeoutMs: 1_000,
});

describe("CubeSandbox Workspace 适配器契约", () => {
  it("固定扫描 /workspace，并以同 operationKey 返回不可变快照", async () => {
    const fake = fakeWorkspaceSandbox({ "/workspace/a.txt": "hello" });
    const adapter = await openWorkspaceAdapterForTesting({
      capability: fixedCapability(IDENTITY),
      identity: IDENTITY,
      sandbox: fake.sandbox,
      options: OPTIONS,
    });

    const input = {
      operationKey: "publish-1",
      scope: { tenantId: "tenant-1", threadId: "thread-1", workspaceId: "workspace-1" },
    } as const;
    const first = await adapter.captureSnapshot(input);
    const second = await adapter.captureSnapshot(input);

    expect(second).toBe(first);
    expect(await collect(adapter.listWorkspace(first))).toEqual([
      { relativePath: "a.txt", kind: "file", size: 5 },
    ]);
    expect(Buffer.concat(await collect(adapter.readRegularFile(first, "a.txt"))).toString()).toBe(
      "hello",
    );
    expect(fake.listedPaths).toEqual(["/workspace"]);
  });

  it("拒绝路径逃逸，且不会把不可信路径交给 SDK", async () => {
    const fake = fakeWorkspaceSandbox({});
    const adapter = await openWorkspaceAdapterForTesting({
      capability: fixedCapability(IDENTITY),
      identity: IDENTITY,
      sandbox: fake.sandbox,
      options: OPTIONS,
    });

    await expect(adapter.inspectRegularFile(IDENTITY, "../secret")).rejects.toMatchObject({
      result: "known",
      dependencyCode: "UNSAFE_WORKSPACE_PATH",
    });
    expect(fake.stattedPaths).toEqual(["/workspace"]);
  });

  it("读取后内容或指纹变化时拒绝复用快照", async () => {
    const fake = fakeWorkspaceSandbox({ "/workspace/a.txt": "hello" });
    const adapter = await openWorkspaceAdapterForTesting({
      capability: fixedCapability(IDENTITY),
      identity: IDENTITY,
      sandbox: fake.sandbox,
      options: OPTIONS,
    });
    const snapshot = await adapter.captureSnapshot({
      operationKey: "publish-change",
      scope: { tenantId: "tenant-1", threadId: "thread-1", workspaceId: "workspace-1" },
    });
    fake.files.set("/workspace/a.txt", Buffer.from("HELLO"));

    await expect(collect(adapter.readRegularFile(snapshot, "a.txt"))).rejects.toMatchObject({
      result: "known",
      dependencyCode: "SNAPSHOT_CHANGED",
    });
  });

  it("Session generation 漂移后失败关闭", async () => {
    let current = IDENTITY;
    const fake = fakeWorkspaceSandbox({});
    const adapter = await openWorkspaceAdapterForTesting({
      capability: { current: async () => current },
      identity: IDENTITY,
      sandbox: fake.sandbox,
      options: OPTIONS,
    });
    current = Object.freeze({ ...IDENTITY, generation: 2 });

    await expect(adapter.currentSession()).rejects.toMatchObject({
      result: "known",
      dependencyCode: "SANDBOX_GENERATION_CHANGED",
    });
  });

  it("变更命令协议不完整时把结果标记为 unknown", async () => {
    const fake = fakeWorkspaceSandbox({});
    fake.sandbox.commands.run = async () => ({ stdout: "", stderr: "", exitCode: 0 });
    const adapter = await openWorkspaceAdapterForTesting({
      capability: fixedCapability(IDENTITY),
      identity: IDENTITY,
      sandbox: fake.sandbox,
      options: OPTIONS,
    });

    await expect(adapter.removeFile(IDENTITY, "a.txt")).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceDependencyError>>({
        result: "unknown",
        dependencyCode: "MUTATION_ACK_UNKNOWN",
      }),
    );
  });
});

function fixedCapability(identity: SandboxSessionIdentity) {
  return { current: async () => identity };
}

function fakeWorkspaceSandbox(initial: Record<string, string>) {
  const files = new Map(
    Object.entries(initial).map(([path, body]) => [path, Buffer.from(body)] as const),
  );
  const listedPaths: string[] = [];
  const stattedPaths: string[] = [];
  const sandbox: CubeSdkSandbox = {
    sandboxId: IDENTITY.sessionId,
    commands: {
      run: async (_script, commandOptions) => {
        const encodedPath = commandOptions?.envs?.CUBE_WS_PATH_B64;
        if (encodedPath === undefined) return { stdout: "OK\n", stderr: "", exitCode: 0 };
        const path = Buffer.from(encodedPath, "base64").toString("utf8");
        const body = files.get(path);
        if (body === undefined) return { stdout: "", stderr: "", exitCode: 40 };
        const fingerprint = `${body.byteLength}:1:2:3:4:81a4`;
        return {
          stdout: `CUBEWS1:${fingerprint}\n${body.toString("base64")}\nCUBEWS1:${fingerprint}\n`,
          stderr: "",
          exitCode: 0,
        };
      },
    },
    runCode: async () => ({}),
    files: {
      read: async (path) => files.get(path)?.toString() ?? "",
      write: async (path, data) => {
        files.set(path, Buffer.from(data));
      },
      list: async (path) => {
        listedPaths.push(path);
        if (path !== "/workspace") return [];
        return [...files.entries()].map(([filePath, body]) => ({
          name: filePath.slice("/workspace/".length),
          type: "FILE_TYPE_FILE",
          size: body.byteLength,
        }));
      },
      stat: async (path) => {
        stattedPaths.push(path);
        if (path === "/workspace") return { type: "FILE_TYPE_DIRECTORY" };
        const body = files.get(path);
        if (body === undefined) throw new Error("not found");
        return { type: "FILE_TYPE_FILE", size: body.byteLength };
      },
      remove: async () => undefined,
      rename: async () => ({}),
      makeDir: async () => ({ type: "FILE_TYPE_DIRECTORY" }),
    },
    pause: async () => undefined,
    kill: async () => undefined,
  };
  return { sandbox, files, listedPaths, stattedPaths };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

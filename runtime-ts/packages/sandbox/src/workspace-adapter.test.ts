import { Buffer } from "node:buffer";
import type { WorkspaceDependencyError } from "@cube-runtime/workspace";
import { describe, expect, it } from "vitest";
import type { CubeSdkSandbox } from "./cube-gateway.js";
import {
  CubeSandboxWorkspacePort,
  resolveTrustedSandboxWorkspaceBinding,
  type TrustedSandboxWorkspaceBinding,
} from "./workspace-adapter.js";

const SCOPE = Object.freeze({
  tenantId: "tenant-1",
  threadId: "thread-1",
  workspaceId: "workspace-1",
});
const BINDING: TrustedSandboxWorkspaceBinding = Object.freeze({
  sessionId: "sandbox-workspace-1",
  generation: 1,
  scope: SCOPE,
});
const IDENTITY = Object.freeze({ sessionId: BINDING.sessionId, generation: BINDING.generation });
const OPTIONS = Object.freeze({
  maxEntries: 16,
  maxFileBytes: 1024,
  maxTotalBytes: 4096,
  maxPathUtf8Bytes: 256,
  maxCommandOutputBytes: 4096,
  readChunkBytes: 4,
  maxSnapshots: 4,
  operationTimeoutMs: 1_000,
});

describe("CubeSandbox Workspace 适配器契约", () => {
  it("固定扫描 /workspace，并以同 operationKey 返回不可变快照", async () => {
    const fake = fakeWorkspaceSandbox({ "a.txt": "hello" });
    const adapter = await open(fake);
    const first = await adapter.captureSnapshot({ operationKey: "publish-1", scope: SCOPE });
    const second = await adapter.captureSnapshot({ operationKey: "publish-1", scope: SCOPE });

    expect(second).toBe(first);
    expect(await collect(adapter.listWorkspace(first))).toEqual([
      { relativePath: "a.txt", kind: "file", size: 5 },
    ]);
    expect(Buffer.concat(await collect(adapter.readRegularFile(first, "a.txt"))).toString()).toBe(
      "hello",
    );
    expect(fake.operations.filter((value) => value === "scan")).toHaveLength(1);
  });

  it("并发相同 operationKey 只执行一次扫描并共享 in-flight 结果", async () => {
    const fake = fakeWorkspaceSandbox({ "a.txt": "hello" });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.beforeScan = () => blocked;
    const adapter = await open(fake);
    const first = adapter.captureSnapshot({ operationKey: "parallel", scope: SCOPE });
    const second = adapter.captureSnapshot({ operationKey: "parallel", scope: SCOPE });
    await Promise.resolve();
    release();
    expect(await second).toBe(await first);
    expect(fake.operations.filter((value) => value === "scan")).toHaveLength(1);
  });

  it("operationKey 与可信 scope 原子绑定并拒绝跨 scope 复用", async () => {
    const fake = fakeWorkspaceSandbox({});
    const adapter = await open(fake);
    await expect(
      adapter.captureSnapshot({
        operationKey: "wrong-scope",
        scope: { ...SCOPE, workspaceId: "workspace-other" },
      }),
    ).rejects.toMatchObject({ result: "known", dependencyCode: "WORKSPACE_SCOPE_MISMATCH" });
    expect(fake.operations.filter((value) => value === "scan")).toHaveLength(0);
  });

  it("祖先 symlink 被 dirfd/O_NOFOLLOW 协议拒绝且不读取外部正文", async () => {
    const fake = fakeWorkspaceSandbox({});
    fake.unsafeAncestors.add("link/secret.txt");
    const adapter = await open(fake);
    await expect(adapter.inspectRegularFile(IDENTITY, "link/secret.txt")).rejects.toMatchObject({
      result: "known",
      dependencyCode: "FILESYSTEM_STAT_FAILED",
    });
    expect(fake.lastScript).toContain("os.O_NOFOLLOW");
    expect(fake.lastScript).toContain("RESOLVE_BENEATH");
    expect(fake.lastScript).toContain("SYS_OPENAT2");
    expect(fake.lastScript).toContain("dir_fd=");
    expect(fake.readPaths).toEqual([]);
  });

  it("延迟 body 在真正读取前重验 generation 与 scope", async () => {
    const fake = fakeWorkspaceSandbox({ "a.txt": "hello" });
    let current = BINDING;
    const adapter = await openWorkspaceAdapterForTesting({
      capability: { current: async () => current },
      binding: BINDING,
      sandbox: fake.sandbox,
      options: OPTIONS,
    });
    const inspected = await adapter.inspectRegularFile(IDENTITY, "a.txt");
    expect(inspected.status).toBe("regular");
    current = Object.freeze({ ...BINDING, generation: 2 });
    if (inspected.status !== "regular") throw new Error("测试前置条件失败");
    await expect(collect(inspected.body)).rejects.toMatchObject({
      result: "known",
      dependencyCode: "SANDBOX_GENERATION_CHANGED",
    });
    expect(fake.readPaths).toEqual([]);
  });

  it("延迟 body 在 scope 换绑后失败关闭", async () => {
    const fake = fakeWorkspaceSandbox({ "a.txt": "hello" });
    let current = BINDING;
    const adapter = await openWorkspaceAdapterForTesting({
      capability: { current: async () => current },
      binding: BINDING,
      sandbox: fake.sandbox,
      options: OPTIONS,
    });
    const inspected = await adapter.inspectRegularFile(IDENTITY, "a.txt");
    current = Object.freeze({ ...BINDING, scope: { ...SCOPE, threadId: "thread-other" } });
    if (inspected.status !== "regular") throw new Error("测试前置条件失败");
    await expect(collect(inspected.body)).rejects.toMatchObject({
      result: "known",
      dependencyCode: "WORKSPACE_SCOPE_CHANGED",
    });
    expect(fake.readPaths).toEqual([]);
  });

  it("释放快照后允许相同 operationKey 重新扫描且旧 token 失效", async () => {
    const fake = fakeWorkspaceSandbox({ "a.txt": "hello" });
    const adapter = await open(fake);
    const first = await adapter.captureSnapshot({ operationKey: "release", scope: SCOPE });
    await adapter.releaseSnapshot(first);
    await expect(collect(adapter.listWorkspace(first))).rejects.toMatchObject({
      result: "known",
      dependencyCode: "SNAPSHOT_NOT_FOUND",
    });
    const second = await adapter.captureSnapshot({ operationKey: "release", scope: SCOPE });
    expect(second.snapshotToken).not.toBe(first.snapshotToken);
    expect(fake.operations.filter((value) => value === "scan")).toHaveLength(2);
  });

  it("原子写已知拒绝后清理外部临时文件", async () => {
    const fake = fakeWorkspaceSandbox({});
    fake.finalizeExitCode = 44;
    const adapter = await open(fake);
    await expect(
      adapter.writeFileAtomically({
        sandbox: IDENTITY,
        relativePath: "a.txt",
        operationKey: "write-known-reject",
        body: bytes("hey"),
      }),
    ).rejects.toMatchObject({ result: "known", dependencyCode: "MUTATION_REJECTED_44" });
    expect(fake.operations).toContain("cleanup_temporary");
    expect([...fake.temporaryFiles.keys()]).toEqual([]);
  });

  it("路径字节上限在任何 SDK 调用前执行", async () => {
    const fake = fakeWorkspaceSandbox({});
    const adapter = await openWorkspaceAdapterForTesting({
      capability: fixedCapability(BINDING),
      binding: BINDING,
      sandbox: fake.sandbox,
      options: { ...OPTIONS, maxPathUtf8Bytes: 4 },
    });
    await expect(adapter.inspectRegularFile(IDENTITY, "12345")).rejects.toMatchObject({
      result: "known",
      dependencyCode: "PATH_LIMIT_EXCEEDED",
    });
    expect(fake.operations).toEqual(["stat"]);
  });

  it("capability 不响应 Abort 时仍受硬超时约束", async () => {
    const fake = fakeWorkspaceSandbox({});
    await expect(
      openWorkspaceAdapterForTesting({
        capability: { current: async () => await new Promise<never>(() => undefined) },
        binding: BINDING,
        sandbox: fake.sandbox,
        options: { ...OPTIONS, operationTimeoutMs: 10 },
      }),
    ).rejects.toMatchObject({ result: "known", dependencyCode: "SESSION_CAPABILITY_TIMEOUT" });
  });

  it("capability 忽略 Abort 时适配边界仍立即取消等待", async () => {
    const controller = new AbortController();
    const reading = resolveTrustedSandboxWorkspaceBinding(
      { current: async () => await new Promise<never>(() => undefined) },
      1_000,
      controller.signal,
    );
    controller.abort();
    await expect(reading).rejects.toMatchObject({ result: "known", dependencyCode: "CANCELLED" });
  });

  it("变更确认协议不完整时把结果标记为 unknown", async () => {
    const fake = fakeWorkspaceSandbox({});
    const adapter = await open(fake);
    fake.forceEmptyMutationAck = true;
    await expect(adapter.removeFile(IDENTITY, "a.txt")).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceDependencyError>>({
        result: "unknown",
        dependencyCode: "MUTATION_ACK_UNKNOWN",
      }),
    );
  });
});

function fixedCapability(binding: TrustedSandboxWorkspaceBinding) {
  return { current: async () => binding };
}

async function open(fake: ReturnType<typeof fakeWorkspaceSandbox>) {
  return openWorkspaceAdapterForTesting({
    capability: fixedCapability(BINDING),
    binding: BINDING,
    sandbox: fake.sandbox,
    options: OPTIONS,
  });
}

async function openWorkspaceAdapterForTesting(
  input: Parameters<typeof CubeSandboxWorkspacePort.open>[0],
) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  try {
    return await CubeSandboxWorkspacePort.open(input);
  } finally {
    if (original !== undefined) Object.defineProperty(process, "platform", original);
  }
}

function fakeWorkspaceSandbox(initial: Record<string, string>) {
  const files = new Map(
    Object.entries(initial).map(([path, body]) => [path, Buffer.from(body)] as const),
  );
  const temporaryFiles = new Map<string, Buffer>();
  const operations: string[] = [];
  const readPaths: string[] = [];
  const unsafeAncestors = new Set<string>();
  const state = {
    operations,
    readPaths,
    unsafeAncestors,
    temporaryFiles,
    beforeScan: undefined as (() => Promise<void>) | undefined,
    finalizeExitCode: 0,
    forceEmptyMutationAck: false,
    lastScript: "",
  };
  const sandbox: CubeSdkSandbox = {
    sandboxId: BINDING.sessionId,
    commands: {
      run: async (script, commandOptions) => {
        state.lastScript = script;
        const env = commandOptions?.envs ?? {};
        const operation = env.CUBE_WS_OP ?? "";
        operations.push(operation);
        if (operation === "scan") {
          await state.beforeScan?.();
          const entries = [...files.entries()].map(([path, body]) => ({
            relativePathB64: Buffer.from(path).toString("base64"),
            type: "FILE_TYPE_FILE",
            size: body.byteLength,
          }));
          return { stdout: JSON.stringify(entries), stderr: "", exitCode: 0 };
        }
        if (operation === "stat") {
          const path = decode(env.CUBE_WS_REL_B64);
          if (path === "")
            return {
              stdout: JSON.stringify({ type: "FILE_TYPE_DIRECTORY" }),
              stderr: "",
              exitCode: 0,
            };
          if (unsafeAncestors.has(path)) return { stdout: "", stderr: "", exitCode: 41 };
          const body = files.get(path);
          if (body === undefined) return { stdout: "", stderr: "", exitCode: 40 };
          return {
            stdout: JSON.stringify({ type: "FILE_TYPE_FILE", size: body.byteLength }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (operation === "read") {
          const path = decode(env.CUBE_WS_REL_B64);
          readPaths.push(path);
          const body = files.get(path);
          if (body === undefined) return { stdout: "", stderr: "", exitCode: 40 };
          const fingerprint = `${body.byteLength}:1:2:3:4:81a4`;
          return {
            stdout: `CUBEWS1:${fingerprint}\n${body.toString("base64")}\nCUBEWS1:${fingerprint}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        if (operation === "finalize_write") {
          if (state.finalizeExitCode !== 0)
            return { stdout: "", stderr: "", exitCode: state.finalizeExitCode };
          return { stdout: "OK\n", stderr: "", exitCode: 0 };
        }
        if (operation === "cleanup_temporary") {
          temporaryFiles.delete(decode(env.CUBE_WS_TEMP_B64));
          return { stdout: "OK\n", stderr: "", exitCode: 0 };
        }
        return { stdout: state.forceEmptyMutationAck ? "" : "OK\n", stderr: "", exitCode: 0 };
      },
    },
    runCode: async () => ({}),
    files: {
      read: async () => "",
      write: async (path, data) => {
        temporaryFiles.set(path, Buffer.from(data));
      },
      list: async () => {
        throw new Error("不允许使用非 dirfd list");
      },
      stat: async () => {
        throw new Error("不允许使用非 dirfd stat");
      },
      remove: async () => {
        throw new Error("不允许使用非 dirfd remove");
      },
      rename: async () => {
        throw new Error("不允许使用非 dirfd rename");
      },
      makeDir: async () => {
        throw new Error("不允许使用非 dirfd makeDir");
      },
    },
    pause: async () => undefined,
    kill: async () => undefined,
  };
  return Object.assign(state, { sandbox, files });
}

function decode(value: string | undefined): string {
  return Buffer.from(value ?? "", "base64").toString("utf8");
}

async function* bytes(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value);
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

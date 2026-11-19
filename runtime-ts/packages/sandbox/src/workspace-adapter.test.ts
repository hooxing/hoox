import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceDependencyError } from "@hoox/workspace";
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
    expect(fake.operations.filter((value) => value === "snapshot")).toHaveLength(1);
    expect(fake.readPaths).toEqual([]);
  });

  it("快照内容在捕获后不可变，Sandbox 文件再变化也只返回捕获时内容", async () => {
    const fake = fakeWorkspaceSandbox({ "a.txt": "hello" });
    const adapter = await open(fake);
    const snapshot = await adapter.captureSnapshot({ operationKey: "immutable", scope: SCOPE });
    fake.files.set("a.txt", Buffer.from("changed"));
    expect(
      Buffer.concat(await collect(adapter.readRegularFile(snapshot, "a.txt"))).toString(),
    ).toBe("hello");
    expect(fake.operations.filter((value) => value === "snapshot")).toHaveLength(1);
  });

  it("打包读取期间文件被改动时失败关闭，不缓存半成品快照", async () => {
    const fake = fakeWorkspaceSandbox({ "a.txt": "hello" });
    fake.snapshotExitCode = 48;
    const adapter = await open(fake);
    await expect(
      adapter.captureSnapshot({ operationKey: "changed", scope: SCOPE }),
    ).rejects.toMatchObject({ result: "known", dependencyCode: "FILE_CHANGED_DURING_READ" });
    fake.snapshotExitCode = 0;
    const retried = await adapter.captureSnapshot({ operationKey: "changed", scope: SCOPE });
    expect(await collect(adapter.listWorkspace(retried))).toEqual([
      { relativePath: "a.txt", kind: "file", size: 5 },
    ]);
  });

  it("快照排除可由锁文件重建的 node_modules 依赖缓存", async () => {
    const fake = fakeWorkspaceSandbox({
      "node_modules/package/index.js": "generated dependency",
      "packages/app/node_modules/package/index.js": "nested generated dependency",
      "packages/app/src/index.ts": "export const value = 1;",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'",
    });
    const adapter = await open(fake);
    const snapshot = await adapter.captureSnapshot({
      operationKey: "exclude-node-modules",
      scope: SCOPE,
    });

    expect(await collect(adapter.listWorkspace(snapshot))).toEqual([
      { relativePath: "packages/app/src/index.ts", kind: "file", size: 23 },
      { relativePath: "pnpm-lock.yaml", kind: "file", size: 22 },
    ]);
    // 打包快照在同一次命令内带回内容，不再逐文件 read。
    expect(fake.readPaths).toEqual([]);
    expect(
      Buffer.concat(
        await collect(adapter.readRegularFile(snapshot, "packages/app/src/index.ts")),
      ).toString(),
    ).toBe("export const value = 1;");
    expect(fake.operations.filter((value) => value === "snapshot")).toHaveLength(1);
  });

  it("Session 与 Snapshot 只返回端口规定字段并可经严格 Journal JSON 往返", async () => {
    const fake = fakeWorkspaceSandbox({ "a.txt": "hello" });
    const adapter = await open(fake);
    const session = await adapter.currentSession();
    const snapshot = await adapter.captureSnapshot({
      operationKey: "exact-identity",
      scope: SCOPE,
    });
    expect(Object.keys(session).sort()).toEqual(["generation", "sessionId"]);
    expect(Object.keys(snapshot).sort()).toEqual(["generation", "sessionId", "snapshotToken"]);
    expect(JSON.parse(JSON.stringify({ sandbox: session, snapshot }))).toEqual({
      sandbox: session,
      snapshot,
    });
    expect(JSON.stringify({ sandbox: session, snapshot })).not.toContain("tenantId");
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
    expect(fake.operations.filter((value) => value === "snapshot")).toHaveLength(1);
  });

  it("release 与同 key capture 原子互斥，释放完成后才允许确定性重建", async () => {
    const fake = fakeWorkspaceSandbox({ "a.txt": "hello" });
    let releaseScan!: () => void;
    let markScanStarted!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const scanStarted = new Promise<void>((resolve) => {
      markScanStarted = resolve;
    });
    fake.beforeScan = () => {
      markScanStarted();
      return blocked;
    };
    const adapter = await open(fake);
    const capturing = adapter.captureSnapshot({ operationKey: "release-race", scope: SCOPE });
    await scanStarted;
    const releasing = adapter.releaseSnapshots({ sandbox: IDENTITY, operationKey: "release-race" });
    await expect(
      adapter.captureSnapshot({ operationKey: "release-race", scope: SCOPE }),
    ).rejects.toMatchObject({ result: "known", dependencyCode: "SNAPSHOT_RELEASING" });
    releaseScan();
    const first = await capturing;
    await releasing;
    fake.beforeScan = undefined;
    const rebuilt = await adapter.captureSnapshot({ operationKey: "release-race", scope: SCOPE });
    expect(rebuilt.snapshotToken).toBe(first.snapshotToken);
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
    expect(fake.operations.filter((value) => value === "snapshot")).toHaveLength(0);
  });

  it("helper 拒绝响应时适配器不会回退 SDK 路径读取", async () => {
    const fake = fakeWorkspaceSandbox({});
    fake.unsafeAncestors.add("link/secret.txt");
    const adapter = await open(fake);
    await expect(adapter.inspectRegularFile(IDENTITY, "link/secret.txt")).rejects.toMatchObject({
      result: "known",
      dependencyCode: "FILESYSTEM_STAT_FAILED",
    });
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
    expect(second.snapshotToken).toBe(first.snapshotToken);
    expect(fake.operations.filter((value) => value === "snapshot")).toHaveLength(2);
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
    expect(fake.operations).toEqual([]);
  });

  it("打开适配器不发远端命令；只读快照不探测，首次写入前只探测一次", async () => {
    const fake = fakeWorkspaceSandbox({ "a.txt": "hello" });
    const adapter = await open(fake);
    expect(fake.operations).toEqual([]);
    await adapter.captureSnapshot({ operationKey: "read-only", scope: SCOPE });
    expect(fake.operations).toEqual(["snapshot"]);
    await adapter.ensureDirectory(IDENTITY, "dir");
    await adapter.removeFile(IDENTITY, "a.txt");
    expect(fake.operations).toEqual(["snapshot", "probe", "ensure_directory", "remove_file"]);
  });

  it("模板不支持 openat2 时写入在任何副作用前以已知错误拒绝", async () => {
    const fake = fakeWorkspaceSandbox({});
    fake.probeExitCode = 1;
    const adapter = await open(fake);
    await expect(
      adapter.writeFileAtomically({
        sandbox: IDENTITY,
        relativePath: "a.txt",
        operationKey: "write-unsupported",
        body: bytes("hello"),
      }),
    ).rejects.toMatchObject({ result: "known", dependencyCode: "OPENAT2_UNAVAILABLE" });
    expect(fake.temporaryFiles.size).toBe(0);
    expect(fake.operations).toEqual(["probe"]);
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

  it.runIf(process.platform === "linux")(
    "Linux 真 helper 以 openat2 拒绝祖先 symlink，并在可挂载时拒绝跨文件系统",
    async () => {
      const fake = fakeWorkspaceSandbox({});
      await open(fake);
      const root = mkdtempSync(join(tmpdir(), "cube-workspace-helper-"));
      const outside = mkdtempSync(join(tmpdir(), "cube-workspace-outside-"));
      try {
        writeFileSync(join(root, "inside.txt"), "inside");
        writeFileSync(join(outside, "secret.txt"), "secret");
        symlinkSync(outside, join(root, "escape"));
        mkdirSync(join(root, "tree", "child"), { recursive: true });
        writeFileSync(join(root, "tree", "child", "delete.txt"), "delete");
        mkdirSync(join(root, "node_modules", "generated"), { recursive: true });
        for (let index = 0; index < 20; index += 1) {
          writeFileSync(join(root, "node_modules", "generated", `${index}.js`), "dependency");
        }
        const script = fake.lastScript.replace(
          'ROOT = "/workspace"',
          `ROOT = ${JSON.stringify(root)}`,
        );
        const run = (
          operation: string,
          relativePath = "",
          additionalEnvironment: Readonly<Record<string, string>> = {},
        ) =>
          spawnSync("bash", [], {
            input: script,
            encoding: "utf8",
            env: {
              ...process.env,
              CUBE_WS_OP: operation,
              CUBE_WS_REL_B64: Buffer.from(relativePath).toString("base64"),
              ...additionalEnvironment,
            },
          });
        expect(run("probe").status).toBe(0);
        expect(run("stat", "inside.txt").status).toBe(0);
        const escaped = run("stat", "escape/secret.txt");
        expect(escaped.status).not.toBe(0);
        expect(escaped.stdout).not.toContain("secret");

        const scanned = run("snapshot", "", {
          CUBE_WS_MAX_ENTRIES: "16",
          CUBE_WS_MAX_FILE_BYTES: "1024",
          CUBE_WS_MAX_TOTAL_BYTES: "4096",
          CUBE_WS_MAX_PATH_BYTES: "256",
          CUBE_WS_MAX_OUTPUT_BYTES: "4096",
          CUBE_WS_EXCLUDED_DIRECTORY_NAMES: "node_modules",
        });
        expect(scanned.status).toBe(0);
        const scannedPaths = (JSON.parse(scanned.stdout) as Array<{ relativePathB64: string }>).map(
          (entry) => Buffer.from(entry.relativePathB64, "base64").toString("utf8"),
        );
        expect(scannedPaths).toContain("inside.txt");
        const inside = (
          JSON.parse(scanned.stdout) as Array<{ relativePathB64: string; contentB64?: string }>
        ).find(
          (entry) => Buffer.from(entry.relativePathB64, "base64").toString("utf8") === "inside.txt",
        );
        expect(Buffer.from(inside?.contentB64 ?? "", "base64").toString("utf8")).toBe("inside");
        expect(scanned.stdout).not.toContain(Buffer.from("secret").toString("base64"));
        expect(scannedPaths.some((path) => path.includes("node_modules"))).toBe(false);

        const mountpoint = join(root, "tree", "mounted");
        mkdirSync(mountpoint);
        const mounted = spawnSync("mount", ["--bind", outside, mountpoint]);
        if (mounted.status === 0) {
          try {
            expect(run("stat", "tree/mounted/secret.txt").status).not.toBe(0);
            expect(run("remove_tree", "tree").status).not.toBe(0);
            expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret");
          } finally {
            spawnSync("umount", [mountpoint]);
          }
        }
        expect(run("remove_tree", "tree").status).toBe(0);
        expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret");
        expect(readFileSync(join(root, "inside.txt"), "utf8")).toBe("inside");
      } finally {
        rmSync(root, { force: true, recursive: true });
        rmSync(outside, { force: true, recursive: true });
      }
    },
  );
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
    snapshotExitCode: 0,
    probeExitCode: 0,
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
        if (operation === "probe") {
          return state.probeExitCode === 0
            ? { stdout: "OK\n", stderr: "", exitCode: 0 }
            : { stdout: "", stderr: "", exitCode: state.probeExitCode };
        }
        if (operation === "snapshot") {
          await state.beforeScan?.();
          const excludedDirectories = new Set(
            (env.CUBE_WS_EXCLUDED_DIRECTORY_NAMES ?? "").split(",").filter(Boolean),
          );
          const entries = [...files.entries()]
            .filter(([path]) => !path.split("/").some((part) => excludedDirectories.has(part)))
            .map(([path, body]) => ({
              relativePathB64: Buffer.from(path).toString("base64"),
              type: "FILE_TYPE_FILE",
              size: body.byteLength,
              fingerprint: `${body.byteLength}:1:2:3:4:81a4`,
              contentB64: body.toString("base64"),
            }));
          if (state.snapshotExitCode !== 0) {
            return { stdout: "", stderr: "", exitCode: state.snapshotExitCode };
          }
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

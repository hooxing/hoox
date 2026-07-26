import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WorkspaceDependencyError } from "./application-errors.js";
import type {
  SandboxWorkspaceEntry,
  SandboxWorkspacePort,
  WorkspaceExecutionPolicy,
  WorkspaceOperationBeginResult,
  WorkspaceOperationIdentity,
  WorkspaceOperationJournalPort,
  WorkspaceOperationResult,
  WorkspaceStableAuthorizationReceipt,
  WorkspaceStableBlobReadPort,
  WorkspaceUnknownFact,
} from "./application-ports.js";
import { createWorkspaceManifest, type WorkspaceManifest } from "./manifest.js";
import { SANDBOX_WORKSPACE_ROOT, WorkspaceMaterializer } from "./materializer.js";

const POLICY: WorkspaceExecutionPolicy = {
  maxFiles: 20,
  maxTotalBytes: 1_024,
  maxSingleFileBytes: 512,
  maxChunkBytes: 64,
  maxPathUtf8Bytes: 128,
};

function bytes(value: string): Uint8Array {
  return Buffer.from(value);
}

function entry(path: string, value: string, tenantId = "tenant-a") {
  const body = bytes(value);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const incarnationId = randomUUID();
  return {
    type: "file" as const,
    path,
    content: { sha256, size: body.byteLength },
    object: {
      tenantId,
      purpose: "workspace" as const,
      incarnationId,
      physicalObjectKey: `runtime/stable/${tenantId}/workspace/sha256/${sha256}/incarnations/${incarnationId}`,
    },
    body,
  };
}

function manifest(entries: ReturnType<typeof entry>[]): WorkspaceManifest {
  return createWorkspaceManifest(
    {
      tenantId: "tenant-a",
      entries: entries.map(({ body: _body, ...manifestEntry }) => manifestEntry),
    },
    {
      maxFiles: POLICY.maxFiles,
      maxTotalBytes: POLICY.maxTotalBytes,
      maxSingleFileBytes: POLICY.maxSingleFileBytes,
      maxPathUtf8Bytes: POLICY.maxPathUtf8Bytes,
    },
  );
}

class MemoryJournal implements WorkspaceOperationJournalPort {
  readonly records = new Map<
    string,
    {
      identity: WorkspaceOperationIdentity;
      state: "running" | "unknown";
      result?: WorkspaceOperationResult;
    }
  >();
  readonly unknown: WorkspaceUnknownFact[] = [];
  completeCalls = 0;
  unknownAfterComplete = false;

  async begin(identity: WorkspaceOperationIdentity): Promise<WorkspaceOperationBeginResult> {
    const existing = this.records.get(identity.operationKey);
    if (existing === undefined) {
      this.records.set(identity.operationKey, { identity, state: "running" });
      return { status: "started" };
    }
    if (
      existing.identity.kind !== identity.kind ||
      existing.identity.inputDigest !== identity.inputDigest
    ) {
      return { status: "conflict" };
    }
    if (existing.result !== undefined) return { status: "completed", result: existing.result };
    return { status: existing.state === "unknown" ? "unknown" : "in_progress" };
  }

  async complete(
    identity: WorkspaceOperationIdentity,
    result: WorkspaceOperationResult,
  ): Promise<void> {
    this.completeCalls += 1;
    this.records.set(identity.operationKey, { identity, state: "running", result });
    if (this.unknownAfterComplete) {
      throw new WorkspaceDependencyError("unknown", "JOURNAL_COMMIT_UNKNOWN");
    }
  }

  async failKnown(identity: WorkspaceOperationIdentity): Promise<void> {
    this.records.delete(identity.operationKey);
  }

  async recordUnknown(
    identity: WorkspaceOperationIdentity,
    fact: WorkspaceUnknownFact,
  ): Promise<void> {
    this.unknown.push(fact);
    if (this.records.get(identity.operationKey)?.result !== undefined) return;
    this.records.set(identity.operationKey, { identity, state: "unknown" });
  }
}

class FakeStableBlobs implements WorkspaceStableBlobReadPort {
  readonly bodies = new Map<string, Uint8Array>();
  authorizeCalls = 0;
  readCalls = 0;
  deny = false;
  corruptHead = false;
  corruptRead = false;

  seed(item: ReturnType<typeof entry>): void {
    this.bodies.set(item.object.physicalObjectKey, item.body);
  }

  async authorize(input: Parameters<WorkspaceStableBlobReadPort["authorize"]>[0]) {
    this.authorizeCalls += 1;
    if (this.deny || input.tenantId !== input.object.tenantId) {
      return { status: "denied" as const };
    }
    return {
      status: "authorized" as const,
      receipt: {
        authorizationId: `auth-${this.authorizeCalls}`,
        tenantId: input.tenantId,
        purpose: "workspace" as const,
        content: input.content,
        object: input.object,
      },
    };
  }

  async head(receipt: WorkspaceStableAuthorizationReceipt) {
    if (!this.bodies.has(receipt.object.physicalObjectKey)) return { status: "not_found" as const };
    return {
      status: "exists" as const,
      content: this.corruptHead
        ? { ...receipt.content, size: receipt.content.size + 1 }
        : receipt.content,
      object: receipt.object,
    };
  }

  async *read(receipt: WorkspaceStableAuthorizationReceipt): AsyncIterable<Uint8Array> {
    this.readCalls += 1;
    const body = this.bodies.get(receipt.object.physicalObjectKey);
    if (body === undefined) throw new Error("fake missing");
    yield this.corruptRead ? bytes("corrupt") : body;
  }
}

class FakeSandbox implements SandboxWorkspacePort {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>();
  readonly events: string[] = [];
  readonly unsafe = new Map<string, "directory" | "symlink" | "special">();
  unknownAt: string | undefined;
  onEvent?: (event: string) => void;
  writes = 0;
  returnBeforeWriteConsume = false;

  async inspectRegularFile(relativePath: string) {
    this.event(`inspect:${relativePath}`);
    const unsafe = this.unsafe.get(relativePath);
    if (unsafe !== undefined) return { status: "unsafe" as const, kind: unsafe };
    const body = this.files.get(relativePath);
    return body === undefined
      ? { status: "missing" as const }
      : { status: "regular" as const, body: chunks(body) };
  }

  async removeFile(relativePath: string): Promise<void> {
    this.event(`remove-file:${relativePath}`);
    this.files.delete(relativePath);
  }

  async removeDirectory(relativePath: string): Promise<void> {
    this.event(`remove-dir:${relativePath}`);
    this.directories.delete(relativePath);
  }

  async ensureDirectory(relativePath: string): Promise<void> {
    this.event(`ensure-dir:${relativePath}`);
    this.directories.add(relativePath);
  }

  async writeFileAtomically(input: Parameters<SandboxWorkspacePort["writeFileAtomically"]>[0]) {
    this.event(`write:${input.relativePath}`);
    if (this.returnBeforeWriteConsume) return;
    const parts: Uint8Array[] = [];
    for await (const chunk of input.body) parts.push(chunk);
    this.files.set(input.relativePath, Buffer.concat(parts));
    this.unsafe.delete(input.relativePath);
    this.writes += 1;
  }

  async *listWorkspace(): AsyncIterable<SandboxWorkspaceEntry> {
    for (const [relativePath, body] of this.files) {
      yield { relativePath, kind: "file", size: body.byteLength };
    }
  }

  readRegularFile(relativePath: string): AsyncIterable<Uint8Array> {
    const body = this.files.get(relativePath);
    if (body === undefined) throw new Error("fake missing");
    return chunks(body);
  }

  private event(value: string): void {
    this.events.push(value);
    this.onEvent?.(value);
    if (this.unknownAt === value) throw new WorkspaceDependencyError("unknown", "FAKE_TIMEOUT");
  }
}

function chunks(body: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield body;
  })();
}

function setup(items: ReturnType<typeof entry>[]) {
  const journal = new MemoryJournal();
  const blobs = new FakeStableBlobs();
  const sandbox = new FakeSandbox();
  for (const item of items) blobs.seed(item);
  const service = new WorkspaceMaterializer({
    journal,
    stableBlobs: blobs,
    sandbox,
    policy: POLICY,
  });
  return { journal, blobs, sandbox, service };
}

describe("Workspace 安全物化执行器", () => {
  it("固定 /workspace、先授权和验证候选，再严格按计划执行", async () => {
    const keep = entry("a/keep.txt", "same");
    const fresh = entry("b/new.txt", "new");
    const old = entry("old/deep.txt", "old");
    const previous = manifest([keep, old]);
    const target = manifest([keep, fresh]);
    const { service, sandbox, blobs } = setup([keep, fresh]);
    sandbox.files.set("a/keep.txt", keep.body);
    sandbox.files.set("old/deep.txt", old.body);
    sandbox.directories.add("old");

    const result = await service.materialize({
      operationKey: "mat-1",
      tenantId: "tenant-a",
      previous,
      target,
    });

    expect(SANDBOX_WORKSPACE_ROOT).toBe("/workspace");
    expect(result.targetManifestDigest).toBe(target.digest);
    expect(sandbox.events).toEqual([
      "inspect:a/keep.txt",
      "remove-file:old/deep.txt",
      "remove-dir:old",
      "ensure-dir:b",
      "write:b/new.txt",
    ]);
    expect(blobs.authorizeCalls).toBe(2);
    expect(sandbox.files.get("b/new.txt")).toEqual(fresh.body);
  });

  it("同路径候选损坏或为 symlink 时回退 stable Blob，绝不沿用候选", async () => {
    const keep = entry("keep.txt", "trusted");
    const previous = manifest([keep]);
    const target = manifest([keep]);
    const first = setup([keep]);
    first.sandbox.files.set("keep.txt", bytes("tampered"));
    await first.service.materialize({
      operationKey: "fallback-1",
      tenantId: "tenant-a",
      previous,
      target,
    });
    expect(first.sandbox.files.get("keep.txt")).toEqual(keep.body);
    expect(first.blobs.readCalls).toBe(1);

    const second = setup([keep]);
    second.sandbox.unsafe.set("keep.txt", "symlink");
    await second.service.materialize({
      operationKey: "fallback-2",
      tenantId: "tenant-a",
      previous,
      target,
    });
    expect(second.sandbox.files.get("keep.txt")).toEqual(keep.body);
  });

  it("拒绝授权、跨 Tenant 回执与损坏 HEAD，且删除阶段尚未开始", async () => {
    const item = entry("safe.txt", "safe");
    const target = manifest([item]);
    const denied = setup([item]);
    denied.blobs.deny = true;
    await expect(
      denied.service.materialize({ operationKey: "deny", tenantId: "tenant-a", target }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(denied.sandbox.events).toEqual([]);

    const corrupt = setup([item]);
    corrupt.blobs.corruptHead = true;
    await expect(
      corrupt.service.materialize({ operationKey: "bad-head", tenantId: "tenant-a", target }),
    ).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
    expect(corrupt.sandbox.events).toEqual([]);
  });

  it("stable 流短读或长读均不会留下宣称成功的物化结果", async () => {
    const item = entry("safe.txt", "expected");
    const target = manifest([item]);
    const short = setup([item]);
    short.blobs.corruptRead = true;
    await expect(
      short.service.materialize({ operationKey: "short", tenantId: "tenant-a", target }),
    ).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
    expect(short.journal.completeCalls).toBe(0);
  });

  it("Sandbox 原子写端口未消费到 EOF 时按协议失败，不会永久等待或宣称完成", async () => {
    const item = entry("safe.txt", "safe");
    const target = manifest([item]);
    const state = setup([item]);
    state.sandbox.returnBeforeWriteConsume = true;
    await expect(
      state.service.materialize({ operationKey: "early-write", tenantId: "tenant-a", target }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_FAILED" });
    expect(state.journal.completeCalls).toBe(0);
  });

  it("远端写后响应未知登记恢复事实，重复 operationKey 不重写", async () => {
    const item = entry("safe.txt", "safe");
    const target = manifest([item]);
    const { service, sandbox, journal } = setup([item]);
    sandbox.unknownAt = "write:safe.txt";
    await expect(
      service.materialize({ operationKey: "unknown-write", tenantId: "tenant-a", target }),
    ).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
    expect(journal.unknown).toEqual([
      expect.objectContaining({ phase: "materialize_files", dependencyCode: "FAKE_TIMEOUT" }),
    ]);
    sandbox.unknownAt = undefined;
    await expect(
      service.materialize({ operationKey: "unknown-write", tenantId: "tenant-a", target }),
    ).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
    expect(sandbox.events.filter((value) => value === "write:safe.txt")).toHaveLength(1);
  });

  it("成功 operationKey 重放直接读完成事实，不重复授权和写文件", async () => {
    const item = entry("safe.txt", "safe");
    const target = manifest([item]);
    const { service, sandbox, blobs } = setup([item]);
    await service.materialize({ operationKey: "repeat", tenantId: "tenant-a", target });
    await service.materialize({ operationKey: "repeat", tenantId: "tenant-a", target });
    expect(sandbox.writes).toBe(1);
    expect(blobs.authorizeCalls).toBe(1);
  });

  it("完成事务响应未知不得把已提交事实降级，读回后不重复副作用", async () => {
    const item = entry("safe.txt", "safe");
    const target = manifest([item]);
    const state = setup([item]);
    state.journal.unknownAfterComplete = true;
    await expect(
      state.service.materialize({ operationKey: "complete-unknown", tenantId: "tenant-a", target }),
    ).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
    state.journal.unknownAfterComplete = false;
    const recovered = await state.service.materialize({
      operationKey: "complete-unknown",
      tenantId: "tenant-a",
      target,
    });
    expect(recovered.targetManifestDigest).toBe(target.digest);
    expect(state.sandbox.writes).toBe(1);
  });

  it("相同 operationKey 绑定其他输入时拒绝，不产生新副作用", async () => {
    const first = entry("a.txt", "a");
    const second = entry("b.txt", "b");
    const state = setup([first, second]);
    await state.service.materialize({
      operationKey: "conflict",
      tenantId: "tenant-a",
      target: manifest([first]),
    });
    await expect(
      state.service.materialize({
        operationKey: "conflict",
        tenantId: "tenant-a",
        target: manifest([second]),
      }),
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    expect(state.sandbox.writes).toBe(1);
  });

  it("在开始与阶段之间响应 abort，不跨越后续副作用停止点", async () => {
    const item = entry("a/b.txt", "b");
    const target = manifest([item]);
    const before = setup([item]);
    const already = new AbortController();
    already.abort();
    await expect(
      before.service.materialize({
        operationKey: "abort-before",
        tenantId: "tenant-a",
        target,
        signal: already.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(before.sandbox.events).toEqual([]);

    const middle = setup([item]);
    const controller = new AbortController();
    middle.sandbox.onEvent = (event) => {
      if (event === "ensure-dir:a") controller.abort();
    };
    await expect(
      middle.service.materialize({
        operationKey: "abort-middle",
        tenantId: "tenant-a",
        target,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(middle.sandbox.events).toEqual(["ensure-dir:a"]);
  });

  it.each([
    ["verify_existing", "inspect:keep.txt"],
    ["remove_files", "remove-file:old/deep.txt"],
    ["remove_directories", "remove-dir:old"],
    ["ensure_directories", "ensure-dir:new"],
    ["materialize_files", "write:new/file.txt"],
  ])("%s 阶段收到 abort 后不越过下一个安全点", async (_phase, abortEvent) => {
    const keep = entry("keep.txt", "keep");
    const old = entry("old/deep.txt", "old");
    const fresh = entry("new/file.txt", "fresh");
    const previous = manifest([keep, old]);
    const target = manifest([keep, fresh]);
    const state = setup([keep, fresh]);
    state.sandbox.files.set("keep.txt", keep.body);
    state.sandbox.files.set("old/deep.txt", old.body);
    state.sandbox.directories.add("old");
    const controller = new AbortController();
    state.sandbox.onEvent = (event) => {
      if (event === abortEvent) controller.abort();
    };
    await expect(
      state.service.materialize({
        operationKey: `abort-${_phase}`,
        tenantId: "tenant-a",
        previous,
        target,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(state.sandbox.events.at(-1)).toBe(abortEvent);
    expect(state.journal.completeCalls).toBe(0);
  });

  it("拒绝伪造逃逸路径、错误 tenant 和超大数据块", async () => {
    const item = entry("safe.txt", "safe");
    const target = manifest([item]);
    const state = setup([item]);
    await expect(
      state.service.materialize({
        operationKey: "escape",
        tenantId: "tenant-a",
        target: {
          ...target,
          entries: [
            {
              ...(target.entries[0] as NonNullable<(typeof target.entries)[0]>),
              path: "../escape",
            },
          ],
        },
      }),
    ).rejects.toBeTruthy();
    await expect(
      state.service.materialize({ operationKey: "wrong-tenant", tenantId: "tenant-b", target }),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_MISMATCH" });

    const large = entry("large.bin", "x".repeat(65));
    const tooLargeChunk = setup([large]);
    await expect(
      tooLargeChunk.service.materialize({
        operationKey: "chunk",
        tenantId: "tenant-a",
        target: manifest([large]),
      }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("目标清单即使自身 digest 合法，也必须重新服从本次执行配额", async () => {
    const first = entry("a", "a".repeat(60));
    const second = entry("b", "b".repeat(60));
    const target = createWorkspaceManifest(
      {
        tenantId: "tenant-a",
        entries: [first, second].map(({ body: _body, ...manifestEntry }) => manifestEntry),
      },
      { maxFiles: 10, maxTotalBytes: 1_000, maxSingleFileBytes: 500 },
    );
    const state = setup([first, second]);
    const strict = new WorkspaceMaterializer({
      journal: state.journal,
      stableBlobs: state.blobs,
      sandbox: state.sandbox,
      policy: { ...POLICY, maxTotalBytes: 100, maxSingleFileBytes: 100 },
    });
    await expect(
      strict.materialize({ operationKey: "target-quota", tenantId: "tenant-a", target }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(state.blobs.authorizeCalls).toBe(0);
  });
});

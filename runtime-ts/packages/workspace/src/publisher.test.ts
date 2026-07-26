import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WorkspaceDependencyError } from "./application-errors.js";
import type {
  SandboxWorkspaceEntry,
  SandboxWorkspacePort,
  WorkspaceCandidateBlob,
  WorkspaceCandidateBlobWritePort,
  WorkspaceExecutionPolicy,
  WorkspaceOperationBeginResult,
  WorkspaceOperationIdentity,
  WorkspaceOperationJournalPort,
  WorkspaceOperationResult,
  WorkspaceUnknownFact,
} from "./application-ports.js";
import type { WorkspaceManifest } from "./manifest.js";
import { WorkspacePublisher } from "./publisher.js";

const POLICY: WorkspaceExecutionPolicy = {
  maxFiles: 5,
  maxTotalBytes: 200,
  maxSingleFileBytes: 100,
  maxChunkBytes: 32,
  maxPathUtf8Bytes: 80,
};

class Journal implements WorkspaceOperationJournalPort {
  readonly rows = new Map<
    string,
    { identity: WorkspaceOperationIdentity; result?: WorkspaceOperationResult; unknown?: true }
  >();
  readonly facts: WorkspaceUnknownFact[] = [];

  async begin(identity: WorkspaceOperationIdentity): Promise<WorkspaceOperationBeginResult> {
    const row = this.rows.get(identity.operationKey);
    if (row === undefined) {
      this.rows.set(identity.operationKey, { identity });
      return { status: "started" };
    }
    if (row.identity.kind !== identity.kind || row.identity.inputDigest !== identity.inputDigest) {
      return { status: "conflict" };
    }
    if (row.result !== undefined) return { status: "completed", result: row.result };
    return { status: row.unknown ? "unknown" : "in_progress" };
  }

  async complete(identity: WorkspaceOperationIdentity, result: WorkspaceOperationResult) {
    this.rows.set(identity.operationKey, { identity, result });
  }

  async failKnown(identity: WorkspaceOperationIdentity) {
    this.rows.delete(identity.operationKey);
  }

  async recordUnknown(identity: WorkspaceOperationIdentity, fact: WorkspaceUnknownFact) {
    this.facts.push(fact);
    if (this.rows.get(identity.operationKey)?.result !== undefined) return;
    this.rows.set(identity.operationKey, { identity, unknown: true });
  }
}

class SnapshotSandbox implements SandboxWorkspacePort {
  entries: SandboxWorkspaceEntry[] = [];
  readonly bodies = new Map<string, Uint8Array>();
  reads = 0;
  listFailure?: WorkspaceDependencyError;
  onRead?: (path: string) => void;

  async *listWorkspace(): AsyncIterable<SandboxWorkspaceEntry> {
    if (this.listFailure !== undefined) throw this.listFailure;
    yield* this.entries;
  }

  readRegularFile(relativePath: string): AsyncIterable<Uint8Array> {
    this.reads += 1;
    const body = this.bodies.get(relativePath);
    if (body === undefined) throw new Error("fake missing");
    this.onRead?.(relativePath);
    return stream(body);
  }

  async inspectRegularFile(): Promise<{ status: "missing" }> {
    return { status: "missing" };
  }
  async removeFile(): Promise<void> {}
  async removeDirectory(): Promise<void> {}
  async ensureDirectory(): Promise<void> {}
  async writeFileAtomically(): Promise<void> {}
}

class BlobWriter implements WorkspaceCandidateBlobWritePort {
  readonly byOperation = new Map<string, WorkspaceCandidateBlob>();
  puts = 0;
  unknownAfterPut = false;
  corruptHead = false;
  crossTenant = false;
  onPut?: () => void;
  returnBeforeConsume = false;

  async putCandidate(input: Parameters<WorkspaceCandidateBlobWritePort["putCandidate"]>[0]) {
    const existing = this.byOperation.get(input.operationKey);
    if (existing !== undefined) return existing;
    if (this.returnBeforeConsume) {
      const sha256 = createHash("sha256").update("").digest("hex");
      const incarnationId = randomUUID();
      return {
        content: { sha256, size: 0 },
        object: {
          tenantId: input.tenantId,
          purpose: "workspace" as const,
          incarnationId,
          physicalObjectKey: `runtime/stable/${input.tenantId}/workspace/sha256/${sha256}/incarnations/${incarnationId}`,
        },
      };
    }
    const parts: Uint8Array[] = [];
    for await (const chunk of input.body) parts.push(chunk);
    const body = Buffer.concat(parts);
    const sha256 = createHash("sha256").update(body).digest("hex");
    const tenantId = this.crossTenant ? "tenant-b" : input.tenantId;
    const incarnationId = randomUUID();
    const blob: WorkspaceCandidateBlob = {
      content: { sha256, size: body.byteLength },
      object: {
        tenantId,
        purpose: "workspace",
        incarnationId,
        physicalObjectKey: `runtime/stable/${tenantId}/workspace/sha256/${sha256}/incarnations/${incarnationId}`,
      },
    };
    this.byOperation.set(input.operationKey, blob);
    this.puts += 1;
    this.onPut?.();
    if (this.unknownAfterPut) throw new WorkspaceDependencyError("unknown", "PUT_TIMEOUT");
    return blob;
  }

  async headCandidate(input: Parameters<WorkspaceCandidateBlobWritePort["headCandidate"]>[0]) {
    if (!this.corruptHead) return { status: "exists" as const, blob: input.blob };
    return {
      status: "exists" as const,
      blob: {
        ...input.blob,
        content: { ...input.blob.content, size: input.blob.content.size + 1 },
      },
    };
  }
}

function stream(body: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield body;
  })();
}

function addFile(
  sandbox: SnapshotSandbox,
  path: string,
  body: string,
  declaredSize?: number,
): void {
  const content = Buffer.from(body);
  sandbox.entries.push({
    relativePath: path,
    kind: "file",
    size: declaredSize ?? content.byteLength,
  });
  sandbox.bodies.set(path, content);
}

function setup() {
  const journal = new Journal();
  const sandbox = new SnapshotSandbox();
  const blobs = new BlobWriter();
  const publisher = new WorkspacePublisher({
    journal,
    sandbox,
    blobs,
    policy: POLICY,
    now: () => new Date("2026-07-26T10:00:00.000Z"),
  });
  return { journal, sandbox, blobs, publisher };
}

describe("Workspace 可验证发布编排", () => {
  it("流式上传普通文件，全部 HEAD 可证实后只返回候选变更", async () => {
    const state = setup();
    addFile(state.sandbox, "docs/a.txt", "alpha");
    addFile(state.sandbox, "z.txt", "z");
    state.sandbox.entries.push({ relativePath: "docs", kind: "directory" });

    const change = await state.publisher.publish({ operationKey: "pub-1", tenantId: "tenant-a" });
    expect(change.kind).toBe("validated_workspace_change");
    expect(change.verifiedAt).toBe("2026-07-26T10:00:00.000Z");
    expect(change.candidateManifest.entries.map((item) => item.path)).toEqual([
      "docs/a.txt",
      "z.txt",
    ]);
    expect(state.blobs.puts).toBe(2);
    expect(Object.keys(change)).not.toContain("revisionId");
  });

  it("相同 operationKey 完成后不二次读取或上传", async () => {
    const state = setup();
    addFile(state.sandbox, "a.txt", "a");
    const first = await state.publisher.publish({
      operationKey: "pub-repeat",
      tenantId: "tenant-a",
    });
    const second = await state.publisher.publish({
      operationKey: "pub-repeat",
      tenantId: "tenant-a",
    });
    expect(second).toEqual(first);
    expect(state.sandbox.reads).toBe(1);
    expect(state.blobs.puts).toBe(1);
  });

  it("operationKey 绑定不同 base 时冲突", async () => {
    const state = setup();
    const first = await state.publisher.publish({
      operationKey: "pub-conflict",
      tenantId: "tenant-a",
    });
    const forgedBase = { ...first.candidateManifest, digest: "0".repeat(64) } as WorkspaceManifest;
    await expect(
      state.publisher.publish({
        operationKey: "pub-conflict",
        tenantId: "tenant-a",
        base: forgedBase,
      }),
    ).rejects.toBeTruthy();
  });

  it("拒绝路径逃逸、symlink、特殊文件和重复清单路径", async () => {
    for (const unsafe of [
      { relativePath: "../escape", kind: "file" as const, size: 1 },
      { relativePath: "link", kind: "symlink" as const },
      { relativePath: "socket", kind: "special" as const },
    ]) {
      const state = setup();
      state.sandbox.entries = [unsafe];
      await expect(
        state.publisher.publish({
          operationKey: `unsafe-${unsafe.kind}-${unsafe.relativePath.length}`,
          tenantId: "tenant-a",
        }),
      ).rejects.toBeTruthy();
      expect(state.blobs.puts).toBe(0);
    }
    const duplicate = setup();
    duplicate.sandbox.entries = [
      { relativePath: "a", kind: "file", size: 1 },
      { relativePath: "a", kind: "file", size: 1 },
    ];
    duplicate.sandbox.bodies.set("a", Buffer.from("a"));
    await expect(
      duplicate.publisher.publish({ operationKey: "duplicate", tenantId: "tenant-a" }),
    ).rejects.toMatchObject({ code: "UNSAFE_SANDBOX_ENTRY" });

    const conflict = setup();
    conflict.sandbox.entries = [
      { relativePath: "a", kind: "file", size: 1 },
      { relativePath: "a/child", kind: "directory" },
    ];
    conflict.sandbox.bodies.set("a", Buffer.from("a"));
    await expect(
      conflict.publisher.publish({ operationKey: "directory-conflict", tenantId: "tenant-a" }),
    ).rejects.toMatchObject({ code: "UNSAFE_SANDBOX_ENTRY" });
  });

  it.each([
    ["短读", "abc", 4],
    ["长读", "abcd", 3],
  ])("%s 不返回候选提交事实", async (_label, body, declaredSize) => {
    const state = setup();
    addFile(state.sandbox, "a.txt", body, declaredSize);
    await expect(
      state.publisher.publish({ operationKey: `size-${declaredSize}`, tenantId: "tenant-a" }),
    ).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
    expect(state.journal.rows.has(`size-${declaredSize}`)).toBe(false);
  });

  it("拒绝跨 Tenant 候选对象和 HEAD 身份损坏", async () => {
    const cross = setup();
    addFile(cross.sandbox, "a", "a");
    cross.blobs.crossTenant = true;
    await expect(
      cross.publisher.publish({ operationKey: "cross", tenantId: "tenant-a" }),
    ).rejects.toBeTruthy();

    const head = setup();
    addFile(head.sandbox, "a", "a");
    head.blobs.corruptHead = true;
    await expect(
      head.publisher.publish({ operationKey: "head", tenantId: "tenant-a" }),
    ).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
  });

  it("写后响应未知登记稳定事实，重复调用不盲目再次上传", async () => {
    const state = setup();
    addFile(state.sandbox, "a", "a");
    state.blobs.unknownAfterPut = true;
    await expect(
      state.publisher.publish({ operationKey: "put-unknown", tenantId: "tenant-a" }),
    ).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
    expect(state.journal.facts).toEqual([
      expect.objectContaining({ phase: "upload_candidate", dependencyCode: "PUT_TIMEOUT" }),
    ]);
    state.blobs.unknownAfterPut = false;
    await expect(
      state.publisher.publish({ operationKey: "put-unknown", tenantId: "tenant-a" }),
    ).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
    expect(state.blobs.puts).toBe(1);
  });

  it("Blob 端口提前返回且未消费 EOF 时按协议失败", async () => {
    const state = setup();
    addFile(state.sandbox, "a", "a");
    state.blobs.returnBeforeConsume = true;
    await expect(
      state.publisher.publish({ operationKey: "early-put", tenantId: "tenant-a" }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_FAILED" });
    expect(state.journal.rows.has("early-put")).toBe(false);
  });

  it("列表依赖未知只记录脱敏代码，不泄漏底层消息", async () => {
    const state = setup();
    state.sandbox.listFailure = new WorkspaceDependencyError("unknown", "bad secret/path");
    await expect(
      state.publisher.publish({ operationKey: "list-unknown", tenantId: "tenant-a" }),
    ).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
    expect(state.journal.facts[0]).toMatchObject({ dependencyCode: "UNCLASSIFIED" });
    expect(JSON.stringify(state.journal.facts)).not.toContain("secret");
  });

  it("执行前 abort 不列举、不读取、不上传", async () => {
    const state = setup();
    addFile(state.sandbox, "a", "a");
    const controller = new AbortController();
    controller.abort();
    await expect(
      state.publisher.publish({
        operationKey: "abort-pub",
        tenantId: "tenant-a",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(state.sandbox.reads).toBe(0);
    expect(state.blobs.puts).toBe(0);
  });

  it("读取中及上传后安全点 abort，不进入 HEAD 或完成事实", async () => {
    const duringRead = setup();
    addFile(duringRead.sandbox, "a", "a");
    const readController = new AbortController();
    duringRead.sandbox.onRead = () => readController.abort();
    await expect(
      duringRead.publisher.publish({
        operationKey: "abort-read",
        tenantId: "tenant-a",
        signal: readController.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });

    const afterPut = setup();
    addFile(afterPut.sandbox, "a", "a");
    const putController = new AbortController();
    afterPut.blobs.onPut = () => putController.abort();
    await expect(
      afterPut.publisher.publish({
        operationKey: "abort-after-put",
        tenantId: "tenant-a",
        signal: putController.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(afterPut.blobs.puts).toBe(1);
    expect(afterPut.journal.rows.has("abort-after-put")).toBe(false);
  });

  it("文件、总量、chunk 和路径配额在核心层强制执行", async () => {
    const chunk = setup();
    addFile(chunk.sandbox, "a", "x".repeat(33));
    await expect(
      chunk.publisher.publish({ operationKey: "chunk-limit", tenantId: "tenant-a" }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });

    const count = setup();
    for (let index = 0; index < 6; index += 1) addFile(count.sandbox, `${index}`, "a");
    await expect(
      count.publisher.publish({ operationKey: "count-limit", tenantId: "tenant-a" }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
});

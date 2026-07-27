import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WorkspaceApplicationError, WorkspaceDependencyError } from "./application-errors.js";
import type {
  SandboxSessionIdentity,
  SandboxWorkspaceEntry,
  SandboxWorkspacePort,
  SandboxWorkspaceSnapshot,
  WorkspaceCandidateBlob,
  WorkspaceCandidateBlobWritePort,
  WorkspaceExecutionPolicy,
  WorkspaceKnownFailureDisposition,
  WorkspaceOperationIdentity,
  WorkspaceOperationJournalPort,
  WorkspaceOperationResult,
  WorkspaceTrustedScope,
  WorkspaceUnknownFact,
} from "./application-ports.js";
import { createWorkspaceManifest, type WorkspaceManifest } from "./manifest.js";
import { WorkspacePublisher } from "./publisher.js";

const SCOPE: WorkspaceTrustedScope = {
  tenantId: "tenant-a",
  threadId: "thread-a",
  workspaceId: "workspace-a",
};
const POLICY: WorkspaceExecutionPolicy = {
  maxEntries: 8,
  maxFiles: 5,
  maxTotalBytes: 200,
  maxSingleFileBytes: 100,
  maxChunkBytes: 32,
  maxPathUtf8Bytes: 80,
  historicalManifest: {
    maxFiles: 10,
    maxTotalBytes: 400,
    maxSingleFileBytes: 200,
    maxPathUtf8Bytes: 120,
  },
};

type State = "running" | "retryable" | "terminal" | "unknown" | "completed";
class Journal implements WorkspaceOperationJournalPort {
  readonly rows = new Map<
    string,
    { identity: WorkspaceOperationIdentity; state: State; result?: WorkspaceOperationResult }
  >();
  readonly failures: { code: string; disposition: WorkspaceKnownFailureDisposition }[] = [];
  readonly facts: WorkspaceUnknownFact[] = [];
  beginOverride: unknown | undefined;
  beginError: unknown | undefined;
  recordUnknownError: WorkspaceDependencyError | undefined;
  completeAfterStoreUnknown = false;
  completeErrorBeforeStore: unknown | undefined;

  async lookupCompleted(input: {
    operationKey: string;
    scope: WorkspaceTrustedScope;
    kind: "materialize" | "publish";
  }): Promise<unknown> {
    const row = this.rows.get(input.operationKey);
    if (
      row?.state !== "completed" ||
      row.identity.kind !== input.kind ||
      row.identity.tenantId !== input.scope.tenantId ||
      row.identity.threadId !== input.scope.threadId ||
      row.identity.workspaceId !== input.scope.workspaceId
    ) {
      return { status: "not_found" };
    }
    return { status: "completed", identity: row.identity, result: row.result };
  }

  async begin(identity: WorkspaceOperationIdentity): Promise<unknown> {
    if (this.beginError !== undefined) throw this.beginError;
    if (this.beginOverride !== undefined) return this.beginOverride;
    const row = this.rows.get(identity.operationKey);
    if (row === undefined) {
      this.rows.set(identity.operationKey, { identity, state: "running" });
      return { status: "started" };
    }
    if (row.identity.inputDigest !== identity.inputDigest) return { status: "conflict" };
    if (row.state === "retryable") {
      row.state = "running";
      return { status: "started" };
    }
    if (row.state === "completed") return { status: "completed", result: row.result };
    return { status: row.state };
  }
  async complete(identity: WorkspaceOperationIdentity, result: WorkspaceOperationResult) {
    if (this.completeErrorBeforeStore !== undefined) throw this.completeErrorBeforeStore;
    this.rows.set(identity.operationKey, { identity, state: "completed", result });
    if (this.completeAfterStoreUnknown) {
      throw new WorkspaceDependencyError("unknown", "JOURNAL_COMMIT_UNKNOWN");
    }
  }
  async failKnown(input: {
    identity: WorkspaceOperationIdentity;
    code: string;
    disposition: WorkspaceKnownFailureDisposition;
  }) {
    this.failures.push({ code: input.code, disposition: input.disposition });
    const row = this.rows.get(input.identity.operationKey);
    if (row?.state === "completed" || row?.state === "unknown") return;
    this.rows.set(input.identity.operationKey, {
      identity: input.identity,
      state: input.disposition,
    });
  }
  async recordUnknown(identity: WorkspaceOperationIdentity, fact: WorkspaceUnknownFact) {
    if (this.recordUnknownError !== undefined) throw this.recordUnknownError;
    this.facts.push(fact);
    if (this.rows.get(identity.operationKey)?.state === "completed") return;
    this.rows.set(identity.operationKey, { identity, state: "unknown" });
  }
}

interface CapturedSnapshot {
  identity: SandboxWorkspaceSnapshot;
  entries: SandboxWorkspaceEntry[];
  bodies: Map<string, Uint8Array>;
}
class SnapshotSandbox implements SandboxWorkspacePort {
  session: SandboxSessionIdentity = { sessionId: "sandbox-a", generation: 1 };
  readonly liveEntries: SandboxWorkspaceEntry[] = [];
  readonly liveBodies = new Map<string, Uint8Array>();
  readonly byOperation = new Map<string, CapturedSnapshot>();
  captureCalls = 0;
  releaseCalls = 0;
  reads = 0;
  listFailure: WorkspaceDependencyError | undefined;
  captureFailure: WorkspaceDependencyError | undefined;
  onList: (() => void) | undefined;
  onRead: (() => void) | undefined;
  listOverride: AsyncIterable<SandboxWorkspaceEntry> | undefined;
  readOverride: (() => AsyncIterable<Uint8Array>) | undefined;

  addFile(path: string, text: string, size?: number) {
    const body = Buffer.from(text);
    this.liveEntries.push({ relativePath: path, kind: "file", size: size ?? body.byteLength });
    this.liveBodies.set(path, body);
  }
  async currentSession() {
    return { ...this.session };
  }
  async captureSnapshot(input: { operationKey: string }): Promise<SandboxWorkspaceSnapshot> {
    this.captureCalls += 1;
    if (this.captureFailure !== undefined) throw this.captureFailure;
    const existing = this.byOperation.get(input.operationKey);
    if (existing !== undefined) return existing.identity;
    const identity = {
      ...this.session,
      snapshotToken: `snapshot-${input.operationKey}`,
    };
    this.byOperation.set(input.operationKey, {
      identity,
      entries: [...this.liveEntries],
      bodies: new Map([...this.liveBodies].map(([path, body]) => [path, Uint8Array.from(body)])),
    });
    return identity;
  }
  async releaseSnapshots(input: { operationKey: string }): Promise<void> {
    this.releaseCalls += 1;
    this.byOperation.delete(input.operationKey);
  }
  listWorkspace(snapshot: SandboxWorkspaceSnapshot): AsyncIterable<SandboxWorkspaceEntry> {
    if (this.listOverride !== undefined) return this.listOverride;
    const self = this;
    return (async function* () {
      if (self.listFailure !== undefined) throw self.listFailure;
      const stored = self.snapshot(snapshot);
      for (const entry of stored.entries) {
        self.onList?.();
        yield entry;
      }
    })();
  }
  readRegularFile(snapshot: SandboxWorkspaceSnapshot, path: string): AsyncIterable<Uint8Array> {
    this.reads += 1;
    this.onRead?.();
    if (this.readOverride !== undefined) return this.readOverride();
    const body = this.snapshot(snapshot).bodies.get(path);
    if (body === undefined) throw new WorkspaceDependencyError("known", "SNAPSHOT_FILE_MISSING");
    return one(body);
  }
  async inspectRegularFile(): Promise<{ status: "missing" }> {
    return { status: "missing" };
  }
  async removeFile(): Promise<void> {}
  async removeDirectory(): Promise<void> {}
  async removeUnexpectedDirectory(): Promise<void> {}
  async ensureDirectory(): Promise<void> {}
  async writeFileAtomically(): Promise<void> {}

  private snapshot(identity: SandboxWorkspaceSnapshot): CapturedSnapshot {
    const value = [...this.byOperation.values()].find(
      (entry) =>
        entry.identity.snapshotToken === identity.snapshotToken &&
        entry.identity.sessionId === identity.sessionId &&
        entry.identity.generation === identity.generation,
    );
    if (value === undefined) throw new WorkspaceDependencyError("known", "SNAPSHOT_MISMATCH");
    return value;
  }
}

class Blobs implements WorkspaceCandidateBlobWritePort {
  readonly byKey = new Map<string, WorkspaceCandidateBlob>();
  readonly keys: string[] = [];
  effects = 0;
  unknownAfterPut = false;
  knownAfterPut = false;
  afterPut: (() => void) | undefined;
  afterHead: (() => void) | undefined;
  tenantSideEffects = 0;
  putError: unknown | undefined;
  candidateOverride: WorkspaceCandidateBlob | undefined;
  headOverride: Awaited<ReturnType<WorkspaceCandidateBlobWritePort["headCandidate"]>> | undefined;

  async putCandidate(input: Parameters<WorkspaceCandidateBlobWritePort["putCandidate"]>[0]) {
    if (this.putError !== undefined) throw this.putError;
    this.tenantSideEffects += 1;
    const chunks: Uint8Array[] = [];
    for await (const chunk of input.body) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (sha256 !== input.expectedContent.sha256 || body.byteLength !== input.expectedContent.size) {
      throw new WorkspaceDependencyError("known", "EXPECTED_CONTENT_MISMATCH");
    }
    let blob = this.byKey.get(input.operationKey);
    if (blob === undefined) {
      const incarnationId = randomUUID();
      blob = {
        content: input.expectedContent,
        object: {
          tenantId: input.scope.tenantId,
          purpose: "workspace",
          incarnationId,
          physicalObjectKey: `runtime/stable/${input.scope.tenantId}/workspace/sha256/${sha256}/incarnations/${incarnationId}`,
        },
      };
      this.byKey.set(input.operationKey, blob);
      this.effects += 1;
    }
    this.keys.push(input.operationKey);
    this.afterPut?.();
    if (this.unknownAfterPut) throw new WorkspaceDependencyError("unknown", "PUT_TIMEOUT");
    if (this.knownAfterPut) throw new WorkspaceDependencyError("known", "PUT_UNAVAILABLE");
    return this.candidateOverride ?? blob;
  }
  async headCandidate(input: Parameters<WorkspaceCandidateBlobWritePort["headCandidate"]>[0]) {
    this.afterHead?.();
    if (this.headOverride !== undefined) return this.headOverride;
    return { status: "exists" as const, blob: input.blob };
  }
}

function one(body: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield body;
  })();
}

function switchingIterable<T>(
  value: T,
  switched: T,
  calls: { safe: number; switched: number },
): AsyncIterable<T> {
  const source = {} as AsyncIterable<T>;
  const switchedFactory = () => {
    calls.switched += 1;
    return oneValue(switched)[Symbol.asyncIterator]();
  };
  const safeFactory = () => {
    calls.safe += 1;
    Object.defineProperty(source, Symbol.asyncIterator, {
      configurable: true,
      value: switchedFactory,
    });
    return oneValue(value)[Symbol.asyncIterator]();
  };
  Object.defineProperty(source, Symbol.asyncIterator, {
    configurable: true,
    value: safeFactory,
  });
  return source;
}

function accessorIterable<T>(value: T, calls: { getter: number }): AsyncIterable<T> {
  return Object.defineProperty({}, Symbol.asyncIterator, {
    configurable: true,
    get: () => {
      calls.getter += 1;
      return () => oneValue(value)[Symbol.asyncIterator]();
    },
  }) as AsyncIterable<T>;
}

function nextAccessorIterable<T>(value: T, calls: { getter: number }): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () =>
      Object.defineProperty({}, "next", {
        get: () => {
          calls.getter += 1;
          return async () => ({ done: false, value });
        },
      }) as AsyncIterator<T>,
  };
}

function resultAccessorIterable<T>(value: T, calls: { getter: number }): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const result = { value } as Record<string, unknown>;
        Object.defineProperty(result, "done", {
          enumerable: true,
          get: () => {
            calls.getter += 1;
            return false;
          },
        });
        return result as unknown as IteratorResult<T>;
      },
    }),
  };
}

function oneValue<T>(value: T): AsyncIterable<T> {
  return (async function* () {
    yield value;
  })();
}

function setup(policy = POLICY) {
  const journal = new Journal();
  const sandbox = new SnapshotSandbox();
  const blobs = new Blobs();
  const publisher = new WorkspacePublisher({
    journal,
    sandbox,
    blobs,
    policy,
    now: () => new Date("2026-07-26T10:00:00.000Z"),
  });
  return { journal, sandbox, blobs, publisher };
}

function request(operationKey: string, base?: WorkspaceManifest) {
  return { operationKey, scope: SCOPE, ...(base === undefined ? {} : { base }) };
}

describe("Workspace publisher 可靠边界", () => {
  it("list 流拒绝协议 getter，捕获 data method 后条目不可切换", async () => {
    const accessor = setup();
    const entry = { relativePath: "a", kind: "directory" as const };
    const getterCalls = { getter: 0 };
    accessor.sandbox.listOverride = accessorIterable(entry, getterCalls);
    await expect(accessor.publisher.publish(request("list-accessor"))).rejects.toMatchObject({
      code: "DEPENDENCY_FAILED",
    });
    expect(getterCalls.getter).toBe(0);
    expect(accessor.blobs.tenantSideEffects).toBe(0);

    const captured = setup();
    const factoryCalls = { safe: 0, switched: 0 };
    captured.sandbox.listOverride = switchingIterable<SandboxWorkspaceEntry>(
      entry,
      { relativePath: "evil", kind: "file", size: 1 },
      factoryCalls,
    );
    await captured.publisher.publish(request("list-captured"));
    expect(factoryCalls).toEqual({ safe: 1, switched: 0 });
    expect(captured.blobs.tenantSideEffects).toBe(0);
  });

  it("list 迭代器 next 与 IteratorResult 都拒绝 accessor 且不执行 getter", async () => {
    const entry = { relativePath: "a", kind: "directory" as const };
    for (const build of [nextAccessorIterable, resultAccessorIterable]) {
      const state = setup();
      const calls = { getter: 0 };
      state.sandbox.listOverride = build(entry, calls);
      await expect(
        state.publisher.publish(request(`iterator-accessor-${build.name}`)),
      ).rejects.toMatchObject({ code: "DEPENDENCY_FAILED" });
      expect(calls.getter).toBe(0);
      expect(state.blobs.tenantSideEffects).toBe(0);
    }
  });

  it("snapshot read 流拒绝协议 getter，双遍各自捕获 method 且内容不可切换", async () => {
    const accessor = setup();
    accessor.sandbox.addFile("a", "a");
    const getterCalls = { getter: 0 };
    accessor.sandbox.readOverride = () => accessorIterable(Buffer.from("a"), getterCalls);
    await expect(accessor.publisher.publish(request("read-accessor"))).rejects.toMatchObject({
      code: "DEPENDENCY_FAILED",
    });
    expect(getterCalls.getter).toBe(0);
    expect(accessor.blobs.tenantSideEffects).toBe(0);

    const captured = setup();
    captured.sandbox.addFile("a", "a");
    const factoryCalls = { safe: 0, switched: 0 };
    captured.sandbox.readOverride = () =>
      switchingIterable(Buffer.from("a"), Buffer.from("evil"), factoryCalls);
    await captured.publisher.publish(request("read-captured"));
    expect(factoryCalls).toEqual({ safe: 2, switched: 0 });
    expect(captured.blobs.effects).toBe(1);
  });

  it("先取得不可变 snapshot 身份再 begin，双遍流式验真后只返回候选", async () => {
    const state = setup();
    state.sandbox.addFile("a", "alpha");
    const change = await state.publisher.publish(request("publish"));
    const row = state.journal.rows.get("publish");
    expect(row?.identity).toMatchObject({
      tenantId: SCOPE.tenantId,
      threadId: SCOPE.threadId,
      workspaceId: SCOPE.workspaceId,
      sandbox: state.sandbox.session,
      snapshotToken: "snapshot-publish",
    });
    expect(change).toMatchObject({ ...SCOPE, sandboxSnapshot: expect.any(Object) });
    expect(state.sandbox.reads).toBe(2);
    expect(Object.keys(change)).not.toContain("revisionId");
    expect(state.sandbox.releaseCalls).toBe(1);
  });

  it("capture 或后续读取失败也在 finally 释放 operation 快照", async () => {
    const capture = setup();
    capture.sandbox.captureFailure = new WorkspaceDependencyError("known", "CAPTURE_FAILED");
    await expect(capture.publisher.publish(request("capture-release"))).rejects.toMatchObject({
      code: "DEPENDENCY_FAILED",
    });
    expect(capture.sandbox.releaseCalls).toBe(1);

    const listed = setup();
    listed.sandbox.listFailure = new WorkspaceDependencyError("known", "LIST_FAILED");
    await expect(listed.publisher.publish(request("list-release"))).rejects.toMatchObject({
      code: "DEPENDENCY_FAILED",
    });
    expect(listed.sandbox.releaseCalls).toBe(1);
  });

  it("完成后 Workspace 改变，同 operationKey 从 Journal 返回原结果且不重新 capture", async () => {
    const state = setup();
    state.sandbox.addFile("a", "original");
    const completed = await state.publisher.publish(request("completed-stable"));
    state.sandbox.liveEntries.length = 0;
    state.sandbox.liveBodies.clear();
    state.sandbox.addFile("changed", "new-content");

    const repeated = await state.publisher.publish(request("completed-stable"));
    expect(repeated).toEqual(completed);
    expect(state.sandbox.captureCalls).toBe(1);
    expect(state.sandbox.releaseCalls).toBe(1);
    expect(repeated.candidateManifest.entries.map((entry) => entry.path)).toEqual(["a"]);
  });

  it("非法 tenant/scope 在 snapshot 与任何 Blob 副作用前拒绝", async () => {
    const state = setup();
    state.sandbox.addFile("a", "a");
    await expect(
      state.publisher.publish({
        operationKey: "bad-scope",
        scope: { ...SCOPE, tenantId: "../bad" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(state.sandbox.captureCalls).toBe(0);
    expect(state.blobs.tenantSideEffects).toBe(0);
  });

  it("abort/部分上传后以同 snapshot 和子key恢复，不双写 candidate", async () => {
    const state = setup();
    state.sandbox.addFile("a", "a");
    const controller = new AbortController();
    state.blobs.afterPut = () => controller.abort();
    await expect(
      state.publisher.publish({ ...request("resume"), signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    state.blobs.afterPut = undefined;
    await state.publisher.publish(request("resume"));
    expect(state.sandbox.captureCalls).toBe(2);
    expect(state.blobs.effects).toBe(1);
    expect(new Set(state.blobs.keys).size).toBe(1);
  });

  it.each(["before", "list", "hash", "head"])("%s 阶段 abort 不宣称候选完成", async (stage) => {
    const state = setup();
    state.sandbox.addFile("a", "a");
    const controller = new AbortController();
    if (stage === "before") controller.abort();
    if (stage === "list") state.sandbox.onList = () => controller.abort();
    if (stage === "hash") state.sandbox.onRead = () => controller.abort();
    if (stage === "head") state.blobs.afterHead = () => controller.abort();
    await expect(
      state.publisher.publish({
        ...request(`abort-${stage}`),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(state.journal.rows.get(`abort-${stage}`)?.state).toBe("retryable");
  });

  it("同 operationKey 不能在 Sandbox generation/snapshot 变化后重绑", async () => {
    const state = setup();
    state.sandbox.addFile("a", "a");
    state.blobs.knownAfterPut = true;
    await expect(state.publisher.publish(request("cross-sandbox"))).rejects.toBeTruthy();
    state.blobs.knownAfterPut = false;
    state.sandbox.byOperation.delete("cross-sandbox");
    state.sandbox.session = { sessionId: "sandbox-b", generation: 2 };
    await expect(state.publisher.publish(request("cross-sandbox"))).rejects.toMatchObject({
      code: "OPERATION_CONFLICT",
    });
  });

  it("known failure 保留父identity：同快照可恢复，不同base永久冲突且单次CAS", async () => {
    const state = setup();
    state.sandbox.addFile("a", "a");
    state.blobs.knownAfterPut = true;
    await expect(state.publisher.publish(request("known"))).rejects.toMatchObject({
      code: "DEPENDENCY_FAILED",
    });
    expect(state.journal.failures).toEqual([
      { code: "DEPENDENCY_FAILED", disposition: "retryable" },
    ]);
    const otherBase = createWorkspaceManifest(
      { tenantId: SCOPE.tenantId, entries: [] },
      POLICY.historicalManifest,
    );
    await expect(state.publisher.publish(request("known", otherBase))).rejects.toMatchObject({
      code: "OPERATION_CONFLICT",
    });
    state.blobs.knownAfterPut = false;
    await state.publisher.publish(request("known"));
    expect(state.blobs.effects).toBe(1);
  });

  it("上传响应未知登记一次，重入不发第二次副作用", async () => {
    const state = setup();
    state.sandbox.addFile("a", "a");
    state.blobs.unknownAfterPut = true;
    await expect(state.publisher.publish(request("unknown"))).rejects.toMatchObject({
      code: "RESULT_UNKNOWN",
    });
    expect(state.journal.facts).toHaveLength(1);
    state.blobs.unknownAfterPut = false;
    await expect(state.publisher.publish(request("unknown"))).rejects.toMatchObject({
      code: "RESULT_UNKNOWN",
    });
    expect(state.blobs.effects).toBe(1);
    expect(state.journal.failures).toHaveLength(0);
  });

  it("completed 是 unknown 边界：拒绝 Proxy/getter/额外字段", async () => {
    for (const malicious of [
      new Proxy({ status: "completed", result: {} }, {}),
      Object.defineProperty({ status: "completed" }, "result", {
        enumerable: true,
        get: () => ({}),
      }),
      { status: "completed", result: {}, extra: true },
    ]) {
      const state = setup();
      state.journal.beginOverride = malicious;
      await expect(state.publisher.publish(request(`mal-${Math.random()}`))).rejects.toMatchObject({
        code: "DEPENDENCY_FAILED",
      });
    }
  });

  it("list 条目 getter 试图从目录切换成文件时立即拒绝，不 PUT 且不绕过条目配额", async () => {
    const state = setup({ ...POLICY, maxEntries: 1, maxFiles: 1 });
    let getterCalls = 0;
    const switching = {
      relativePath: "switch",
      size: POLICY.maxSingleFileBytes + 1,
    } as Record<string, unknown>;
    Object.defineProperty(switching, "kind", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return getterCalls === 1 ? "directory" : "file";
      },
    });
    state.sandbox.liveEntries.push(switching as unknown as SandboxWorkspaceEntry);
    await expect(state.publisher.publish(request("list-getter"))).rejects.toMatchObject({
      code: "DEPENDENCY_FAILED",
    });
    expect(getterCalls).toBe(0);
    expect(state.blobs.tenantSideEffects).toBe(0);
    expect(state.journal.rows.get("list-getter")?.state).toBe("retryable");
  });

  it("candidate 与 HEAD 返回值拒绝 getter/额外字段，后续不使用切换后的对象", async () => {
    const candidate = setup();
    candidate.sandbox.addFile("a", "a");
    const body = Buffer.from("a");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const incarnationId = randomUUID();
    const switching = { content: { sha256, size: 1 } } as Record<string, unknown>;
    Object.defineProperty(switching, "object", {
      enumerable: true,
      get: () => ({
        tenantId: SCOPE.tenantId,
        purpose: "workspace",
        incarnationId,
        physicalObjectKey: `runtime/stable/${SCOPE.tenantId}/workspace/sha256/${sha256}/incarnations/${incarnationId}`,
      }),
    });
    candidate.blobs.candidateOverride = switching as unknown as WorkspaceCandidateBlob;
    await expect(candidate.publisher.publish(request("candidate-getter"))).rejects.toMatchObject({
      code: "DEPENDENCY_FAILED",
    });

    const head = setup();
    head.sandbox.addFile("a", "a");
    head.blobs.headOverride = {
      status: "exists",
      blob: {
        content: { sha256, size: 1 },
        object: {
          tenantId: SCOPE.tenantId,
          purpose: "workspace",
          incarnationId,
          physicalObjectKey: `runtime/stable/${SCOPE.tenantId}/workspace/sha256/${sha256}/incarnations/${incarnationId}`,
        },
      },
      providerPath: "/private/object",
    } as unknown as Awaited<ReturnType<WorkspaceCandidateBlobWritePort["headCandidate"]>>;
    await expect(head.publisher.publish(request("head-extra"))).rejects.toMatchObject({
      code: "DEPENDENCY_FAILED",
    });
  });

  it("适配器伪造公开 WorkspaceApplicationError 仍统一脱敏且无 cause", async () => {
    const state = setup();
    state.sandbox.addFile("a", "a");
    state.blobs.putError = new WorkspaceApplicationError(
      "ACCESS_DENIED",
      "secret provider /private/object/path",
    );
    await expect(state.publisher.publish(request("forged-provider-error"))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof WorkspaceApplicationError &&
        error.code === "DEPENDENCY_FAILED" &&
        !error.message.includes("secret") &&
        !error.message.includes("path") &&
        !("cause" in error),
    );
  });

  it("complete 已提交但响应 UNKNOWN 时 completed 不降级，重入不重复上传", async () => {
    const state = setup();
    state.sandbox.addFile("a", "a");
    state.journal.completeAfterStoreUnknown = true;
    await expect(state.publisher.publish(request("complete-unknown"))).rejects.toMatchObject({
      code: "RESULT_UNKNOWN",
    });
    expect(state.journal.rows.get("complete-unknown")?.state).toBe("completed");
    state.journal.completeAfterStoreUnknown = false;
    await state.publisher.publish(request("complete-unknown"));
    expect(state.blobs.effects).toBe(1);
  });

  it("journal begin/complete 自身异常不泄漏 provider secret/path", async () => {
    const begin = setup();
    begin.journal.beginError = new WorkspaceDependencyError("known", "secret/provider/path");
    await expect(begin.publisher.publish(request("begin-secret"))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof WorkspaceApplicationError &&
        error.code === "DEPENDENCY_FAILED" &&
        !error.message.includes("secret") &&
        !error.message.includes("path"),
    );

    const complete = setup();
    complete.sandbox.addFile("a", "a");
    complete.journal.completeErrorBeforeStore = new WorkspaceDependencyError(
      "known",
      "secret/provider/path",
    );
    await expect(complete.publisher.publish(request("complete-secret"))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof WorkspaceApplicationError &&
        error.code === "DEPENDENCY_FAILED" &&
        !error.message.includes("secret") &&
        !error.message.includes("path"),
    );
  });

  it("completed 完整重验 scope/snapshot/base/candidate digest/identity/verifiedAt 与当前配额", async () => {
    const state = setup();
    state.sandbox.addFile("a", "a");
    await state.publisher.publish(request("complete"));
    const row = state.journal.rows.get("complete");
    if (row?.result?.kind !== "published") throw new Error("fake result missing");
    row.result = {
      ...row.result,
      change: { ...row.result.change, verifiedAt: "not-a-time" },
    };
    await expect(state.publisher.publish(request("complete"))).rejects.toMatchObject({
      code: "OPERATION_CONFLICT",
    });

    const oversized = setup({ ...POLICY, maxTotalBytes: 1, maxSingleFileBytes: 1 });
    oversized.sandbox.addFile("a", "a");
    const candidate = await oversized.publisher.publish(request("quota-complete"));
    const quotaRow = oversized.journal.rows.get("quota-complete");
    if (quotaRow?.result?.kind !== "published") throw new Error("fake result missing");
    const largeBody = Buffer.from("xx");
    const sha256 = createHash("sha256").update(largeBody).digest("hex");
    const incarnationId = randomUUID();
    const largeManifest = createWorkspaceManifest(
      {
        tenantId: SCOPE.tenantId,
        entries: [
          {
            type: "file",
            path: "x",
            content: { sha256, size: 2 },
            object: {
              tenantId: SCOPE.tenantId,
              purpose: "workspace",
              incarnationId,
              physicalObjectKey: `runtime/stable/${SCOPE.tenantId}/workspace/sha256/${sha256}/incarnations/${incarnationId}`,
            },
          },
        ],
      },
      { maxFiles: 2, maxTotalBytes: 10 },
    );
    quotaRow.result = {
      ...quotaRow.result,
      change: { ...candidate, candidateManifest: largeManifest },
    };
    await expect(oversized.publisher.publish(request("quota-complete"))).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
  });

  it("base 使用明确历史策略有界解析，在 snapshot/Blob 前拒绝超限", async () => {
    const body = Buffer.from("xx");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const incarnationId = randomUUID();
    const base = createWorkspaceManifest(
      {
        tenantId: SCOPE.tenantId,
        entries: [
          {
            type: "file",
            path: "x",
            content: { sha256, size: 2 },
            object: {
              tenantId: SCOPE.tenantId,
              purpose: "workspace",
              incarnationId,
              physicalObjectKey: `runtime/stable/${SCOPE.tenantId}/workspace/sha256/${sha256}/incarnations/${incarnationId}`,
            },
          },
        ],
      },
      { maxFiles: 2, maxTotalBytes: 10 },
    );
    const state = setup({
      ...POLICY,
      historicalManifest: { maxFiles: 1, maxTotalBytes: 1, maxSingleFileBytes: 1 },
    });
    await expect(state.publisher.publish(request("base-limit", base))).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
    expect(state.sandbox.captureCalls).toBe(0);
  });

  it("maxEntries 与 maxFiles 分离：目录计 entry 不计 file，分别失败", async () => {
    const entries = setup({ ...POLICY, maxEntries: 2, maxFiles: 1 });
    entries.sandbox.liveEntries.push(
      { relativePath: "a", kind: "directory" },
      { relativePath: "b", kind: "directory" },
      { relativePath: "c", kind: "directory" },
    );
    await expect(entries.publisher.publish(request("entry-limit"))).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });

    const files = setup({ ...POLICY, maxEntries: 4, maxFiles: 1 });
    files.sandbox.addFile("a", "a");
    files.sandbox.addFile("b", "b");
    await expect(files.publisher.publish(request("file-limit"))).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
  });

  it("子key绑定父digest、snapshot、路径和内容；内容变化产生新key", async () => {
    const first = setup();
    first.sandbox.addFile("a", "a");
    await first.publisher.publish(request("child-a"));
    const second = setup();
    second.sandbox.addFile("a", "b");
    await second.publisher.publish(request("child-a"));
    expect(first.blobs.keys[0]).not.toBe(second.blobs.keys[0]);
  });

  it("recordUnknown journal 故障统一脱敏且不追加第二类 known CAS", async () => {
    const state = setup();
    state.sandbox.addFile("a", "a");
    state.blobs.unknownAfterPut = true;
    state.journal.recordUnknownError = new WorkspaceDependencyError("known", "secret/path");
    await expect(state.publisher.publish(request("journal-unknown-fail"))).rejects.toMatchObject({
      code: "DEPENDENCY_FAILED",
      message: expect.not.stringContaining("secret"),
    });
    expect(state.journal.failures).toHaveLength(0);
  });
});

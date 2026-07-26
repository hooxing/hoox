import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WorkspaceApplicationError, WorkspaceDependencyError } from "./application-errors.js";
import type {
  SandboxSessionIdentity,
  SandboxWorkspaceEntry,
  SandboxWorkspacePort,
  SandboxWorkspaceSnapshot,
  WorkspaceExecutionPolicy,
  WorkspaceKnownFailureDisposition,
  WorkspaceOperationIdentity,
  WorkspaceOperationJournalPort,
  WorkspaceOperationResult,
  WorkspaceStableAuthorizationReceipt,
  WorkspaceStableBlobReadPort,
  WorkspaceTrustedScope,
  WorkspaceUnknownFact,
} from "./application-ports.js";
import { createWorkspaceManifest, type WorkspaceManifest } from "./manifest.js";
import { WorkspaceMaterializer } from "./materializer.js";

const SCOPE: WorkspaceTrustedScope = {
  tenantId: "tenant-a",
  threadId: "thread-a",
  workspaceId: "workspace-a",
};
const POLICY: WorkspaceExecutionPolicy = {
  maxEntries: 20,
  maxFiles: 20,
  maxTotalBytes: 1_024,
  maxSingleFileBytes: 512,
  maxChunkBytes: 64,
  maxPathUtf8Bytes: 128,
  historicalManifest: {
    maxFiles: 40,
    maxTotalBytes: 2_048,
    maxSingleFileBytes: 1_024,
    maxPathUtf8Bytes: 256,
  },
};

function item(path: string, text: string, incarnationId = randomUUID()) {
  const body = Buffer.from(text);
  const sha256 = createHash("sha256").update(body).digest("hex");
  return {
    body,
    entry: {
      type: "file" as const,
      path,
      content: { sha256, size: body.byteLength },
      object: {
        tenantId: SCOPE.tenantId,
        purpose: "workspace" as const,
        incarnationId,
        physicalObjectKey: `runtime/stable/${SCOPE.tenantId}/workspace/sha256/${sha256}/incarnations/${incarnationId}`,
      },
    },
  };
}

function manifest(items: ReturnType<typeof item>[], policy = POLICY): WorkspaceManifest {
  return createWorkspaceManifest(
    { tenantId: SCOPE.tenantId, entries: items.map((value) => value.entry) },
    {
      maxFiles: policy.historicalManifest.maxFiles,
      maxTotalBytes: policy.historicalManifest.maxTotalBytes,
      ...(policy.historicalManifest.maxSingleFileBytes === undefined
        ? {}
        : { maxSingleFileBytes: policy.historicalManifest.maxSingleFileBytes }),
      ...(policy.historicalManifest.maxPathUtf8Bytes === undefined
        ? {}
        : { maxPathUtf8Bytes: policy.historicalManifest.maxPathUtf8Bytes }),
    },
  );
}

type JournalState = "running" | "retryable" | "terminal" | "unknown" | "completed";
class Journal implements WorkspaceOperationJournalPort {
  readonly rows = new Map<
    string,
    { identity: WorkspaceOperationIdentity; state: JournalState; result?: WorkspaceOperationResult }
  >();
  readonly failures: { code: string; disposition: WorkspaceKnownFailureDisposition }[] = [];
  readonly unknownFacts: WorkspaceUnknownFact[] = [];
  beginOverride: unknown | undefined;
  beginError: unknown | undefined;
  failKnownError: WorkspaceDependencyError | undefined;
  completeAfterStoreUnknown = false;

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
    if (this.failKnownError !== undefined) throw this.failKnownError;
    this.failures.push({ code: input.code, disposition: input.disposition });
    const row = this.rows.get(input.identity.operationKey);
    if (row?.state === "completed" || row?.state === "unknown") return;
    this.rows.set(input.identity.operationKey, {
      identity: input.identity,
      state: input.disposition,
    });
  }

  async recordUnknown(identity: WorkspaceOperationIdentity, fact: WorkspaceUnknownFact) {
    this.unknownFacts.push(fact);
    if (this.rows.get(identity.operationKey)?.state === "completed") return;
    this.rows.set(identity.operationKey, { identity, state: "unknown" });
  }
}

class StableBlobs implements WorkspaceStableBlobReadPort {
  readonly bodies = new Map<string, Uint8Array>();
  deny = false;
  corruptRead = false;
  authorizeCalls = 0;
  authorizationOverride: Awaited<ReturnType<WorkspaceStableBlobReadPort["authorize"]>> | undefined;
  headOverride: Awaited<ReturnType<WorkspaceStableBlobReadPort["head"]>> | undefined;
  readOverride: AsyncIterable<Uint8Array> | undefined;

  seed(value: ReturnType<typeof item>) {
    this.bodies.set(value.entry.object.physicalObjectKey, value.body);
  }

  async authorize(input: Parameters<WorkspaceStableBlobReadPort["authorize"]>[0]) {
    this.authorizeCalls += 1;
    if (this.authorizationOverride !== undefined) return this.authorizationOverride;
    if (this.deny || input.scope.tenantId !== input.object.tenantId) {
      return { status: "denied" as const };
    }
    return {
      status: "authorized" as const,
      receipt: {
        authorizationId: `auth-${this.authorizeCalls}`,
        tenantId: input.scope.tenantId,
        purpose: "workspace" as const,
        content: input.content,
        object: input.object,
      },
    };
  }

  async head(receipt: WorkspaceStableAuthorizationReceipt) {
    if (this.headOverride !== undefined) return this.headOverride;
    return this.bodies.has(receipt.object.physicalObjectKey)
      ? { status: "exists" as const, content: receipt.content, object: receipt.object }
      : { status: "not_found" as const };
  }

  read(receipt: WorkspaceStableAuthorizationReceipt): AsyncIterable<Uint8Array> {
    if (this.readOverride !== undefined) return this.readOverride;
    const body = this.bodies.get(receipt.object.physicalObjectKey);
    if (body === undefined) throw new Error("fake missing");
    return one(this.corruptRead ? Buffer.from("corrupt") : body);
  }
}

class Sandbox implements SandboxWorkspacePort {
  session: SandboxSessionIdentity = { sessionId: "sandbox-a", generation: 1 };
  readonly files = new Map<string, Uint8Array>();
  readonly unsafe = new Map<string, "directory" | "symlink" | "special">();
  readonly events: string[] = [];
  readonly childKeys: string[] = [];
  readonly completedChildKeys = new Set<string>();
  writeEffects = 0;
  unknownEvent: string | undefined;
  knownEvent: string | undefined;
  afterWrite: (() => void) | undefined;
  onEvent: ((event: string) => void) | undefined;
  inspectOverride: Awaited<ReturnType<SandboxWorkspacePort["inspectRegularFile"]>> | undefined;
  inspectError: unknown | undefined;

  async currentSession() {
    return { ...this.session };
  }
  async captureSnapshot(): Promise<SandboxWorkspaceSnapshot> {
    return { ...this.session, snapshotToken: "snapshot-a" };
  }
  async inspectRegularFile(sandbox: SandboxSessionIdentity, path: string) {
    this.assertSession(sandbox);
    this.event(`inspect:${path}`);
    if (this.inspectError !== undefined) throw this.inspectError;
    if (this.inspectOverride !== undefined) return this.inspectOverride;
    const kind = this.unsafe.get(path);
    if (kind !== undefined) return { status: "unsafe" as const, kind };
    const body = this.files.get(path);
    return body === undefined
      ? { status: "missing" as const }
      : { status: "regular" as const, body: one(body) };
  }
  async removeFile(sandbox: SandboxSessionIdentity, path: string) {
    this.assertSession(sandbox);
    this.event(`remove-file:${path}`);
    this.files.delete(path);
    this.unsafe.delete(path);
  }
  async removeDirectory(sandbox: SandboxSessionIdentity, path: string) {
    this.assertSession(sandbox);
    this.event(`remove-dir:${path}`);
  }
  async removeUnexpectedDirectory(sandbox: SandboxSessionIdentity, path: string) {
    this.assertSession(sandbox);
    this.event(`remove-drift-dir:${path}`);
    this.unsafe.delete(path);
  }
  async ensureDirectory(sandbox: SandboxSessionIdentity, path: string) {
    this.assertSession(sandbox);
    this.event(`ensure-dir:${path}`);
  }
  async writeFileAtomically(input: Parameters<SandboxWorkspacePort["writeFileAtomically"]>[0]) {
    this.assertSession(input.sandbox);
    this.event(`write:${input.relativePath}`);
    this.childKeys.push(input.operationKey);
    const chunks: Uint8Array[] = [];
    for await (const chunk of input.body) chunks.push(chunk);
    if (!this.completedChildKeys.has(input.operationKey)) {
      this.files.set(input.relativePath, Buffer.concat(chunks));
      this.completedChildKeys.add(input.operationKey);
      this.writeEffects += 1;
    }
    this.afterWrite?.();
  }
  async *listWorkspace(): AsyncIterable<SandboxWorkspaceEntry> {}
  readRegularFile(): AsyncIterable<Uint8Array> {
    return one(Buffer.alloc(0));
  }

  private assertSession(value: SandboxSessionIdentity) {
    if (
      value.sessionId !== this.session.sessionId ||
      value.generation !== this.session.generation
    ) {
      throw new WorkspaceDependencyError("known", "SANDBOX_GENERATION_MISMATCH");
    }
  }
  private event(value: string) {
    this.events.push(value);
    this.onEvent?.(value);
    if (this.unknownEvent === value) throw new WorkspaceDependencyError("unknown", "FAKE_TIMEOUT");
    if (this.knownEvent === value) throw new WorkspaceDependencyError("known", "FAKE_UNAVAILABLE");
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

function oneValue<T>(value: T): AsyncIterable<T> {
  return (async function* () {
    yield value;
  })();
}

function setup(values: ReturnType<typeof item>[]) {
  const journal = new Journal();
  const blobs = new StableBlobs();
  const sandbox = new Sandbox();
  for (const value of values) blobs.seed(value);
  const service = new WorkspaceMaterializer({
    journal,
    stableBlobs: blobs,
    sandbox,
    policy: POLICY,
  });
  return { journal, blobs, sandbox, service };
}

function request(operationKey: string, target: WorkspaceManifest, previous?: WorkspaceManifest) {
  return { operationKey, scope: SCOPE, target, ...(previous === undefined ? {} : { previous }) };
}

describe("Workspace materializer 可靠边界", () => {
  it("stable read 流拒绝协议 getter，捕获 data method 后不受 provider 切换影响", async () => {
    const value = item("file", "body");
    const accessor = setup([value]);
    const getterCalls = { getter: 0 };
    accessor.blobs.readOverride = accessorIterable(value.body, getterCalls);
    await expect(
      accessor.service.materialize(request("stable-accessor", manifest([value]))),
    ).rejects.toMatchObject({ code: "DEPENDENCY_FAILED" });
    expect(getterCalls.getter).toBe(0);
    expect(accessor.sandbox.writeEffects).toBe(0);

    const captured = setup([value]);
    const factoryCalls = { safe: 0, switched: 0 };
    captured.blobs.readOverride = switchingIterable(value.body, Buffer.from("evil"), factoryCalls);
    await captured.service.materialize(request("stable-captured", manifest([value])));
    expect(factoryCalls).toEqual({ safe: 1, switched: 0 });
    expect(captured.sandbox.files.get("file")).toEqual(value.body);
  });

  it("inspect body 流拒绝协议 getter，捕获 data method 后不受 provider 切换影响", async () => {
    const value = item("file", "body");
    const accessor = setup([value]);
    const getterCalls = { getter: 0 };
    accessor.sandbox.inspectOverride = {
      status: "regular",
      body: accessorIterable(value.body, getterCalls),
    };
    await expect(
      accessor.service.materialize(
        request("inspect-body-accessor", manifest([value]), manifest([value])),
      ),
    ).rejects.toMatchObject({ code: "DEPENDENCY_FAILED" });
    expect(getterCalls.getter).toBe(0);

    const captured = setup([value]);
    const factoryCalls = { safe: 0, switched: 0 };
    captured.sandbox.inspectOverride = {
      status: "regular",
      body: switchingIterable(value.body, Buffer.from("evil"), factoryCalls),
    };
    await captured.service.materialize(
      request("inspect-body-captured", manifest([value]), manifest([value])),
    );
    expect(factoryCalls).toEqual({ safe: 1, switched: 0 });
    expect(captured.sandbox.writeEffects).toBe(0);
  });

  it("授权先于删除并严格执行计划阶段，结果绑定 scope 与 sandbox generation", async () => {
    const keep = item("a/keep", "same");
    const old = item("old/deep", "old");
    const fresh = item("new/file", "fresh");
    const state = setup([keep, fresh]);
    state.sandbox.files.set("a/keep", keep.body);
    state.sandbox.files.set("old/deep", old.body);
    const result = await state.service.materialize(
      request("mat-phase", manifest([keep, fresh]), manifest([keep, old])),
    );
    expect(state.sandbox.events).toEqual([
      "inspect:a/keep",
      "inspect:old/deep",
      "remove-file:old/deep",
      "remove-dir:old",
      "ensure-dir:new",
      "write:new/file",
    ]);
    expect(state.blobs.authorizeCalls).toBe(2);
    expect(result).toMatchObject({ scope: SCOPE, sandbox: state.sandbox.session });
  });

  it("同路径目录类型漂移在 remove_files 阶段安全递归删除，再 stable fallback 原子 rename", async () => {
    const keep = item("keep", "trusted");
    const state = setup([keep]);
    state.sandbox.unsafe.set("keep", "directory");
    await state.service.materialize(request("drift", manifest([keep]), manifest([keep])));
    expect(state.sandbox.events).toEqual(["inspect:keep", "remove-drift-dir:keep", "write:keep"]);
    expect(state.sandbox.files.get("keep")).toEqual(keep.body);
  });

  it("内容变化的计划删除路径若漂移成目录，也在删除阶段识别并安全清除", async () => {
    const old = item("file", "old");
    const fresh = item("file", "fresh");
    const state = setup([fresh]);
    state.sandbox.unsafe.set("file", "directory");
    await state.service.materialize(request("changed-drift", manifest([fresh]), manifest([old])));
    expect(state.sandbox.events).toEqual(["inspect:file", "remove-drift-dir:file", "write:file"]);
    expect(state.sandbox.files.get("file")).toEqual(fresh.body);
  });

  it("损坏候选回退 stable；拒绝授权时任何 Sandbox 删除均未开始", async () => {
    const keep = item("keep", "trusted");
    const damaged = setup([keep]);
    damaged.sandbox.files.set("keep", Buffer.from("tampered"));
    await damaged.service.materialize(request("fallback", manifest([keep]), manifest([keep])));
    expect(damaged.sandbox.files.get("keep")).toEqual(keep.body);

    const denied = setup([keep]);
    denied.blobs.deny = true;
    await expect(
      denied.service.materialize(request("denied", manifest([keep]))),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(denied.sandbox.events).toEqual([]);
  });

  it("远端写结果未知只记录一次 UNKNOWN，重入不盲目重写", async () => {
    const value = item("file", "body");
    const state = setup([value]);
    state.sandbox.unknownEvent = "write:file";
    await expect(
      state.service.materialize(request("unknown", manifest([value]))),
    ).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
    expect(state.journal.unknownFacts).toHaveLength(1);
    state.sandbox.unknownEvent = undefined;
    await expect(
      state.service.materialize(request("unknown", manifest([value]))),
    ).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
    expect(state.sandbox.events.filter((event) => event === "write:file")).toHaveLength(1);
    expect(state.journal.failures).toHaveLength(0);
  });

  it("known failure 保留 identity：同 digest 可恢复，不同 digest 永久 conflict且只做一次CAS", async () => {
    const first = item("a", "a");
    const second = item("b", "b");
    const state = setup([first, second]);
    state.sandbox.knownEvent = "write:a";
    await expect(
      state.service.materialize(request("known", manifest([first]))),
    ).rejects.toMatchObject({ code: "DEPENDENCY_FAILED" });
    expect(state.journal.failures).toEqual([
      { code: "DEPENDENCY_FAILED", disposition: "retryable" },
    ]);
    await expect(
      state.service.materialize(request("known", manifest([second]))),
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    state.sandbox.knownEvent = undefined;
    await state.service.materialize(request("known", manifest([first])));
    expect(state.sandbox.writeEffects).toBe(1);
  });

  it("abort 在原子写已完成后以相同父digest恢复，子key幂等且不双写", async () => {
    const value = item("file", "body");
    const state = setup([value]);
    const controller = new AbortController();
    state.sandbox.afterWrite = () => controller.abort();
    await expect(
      state.service.materialize({
        ...request("abort-resume", manifest([value])),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    state.sandbox.afterWrite = undefined;
    await state.service.materialize(request("abort-resume", manifest([value])));
    expect(state.sandbox.writeEffects).toBe(1);
    expect(new Set(state.sandbox.childKeys).size).toBe(1);
  });

  it.each([
    ["verify_existing", "inspect:keep"],
    ["remove_files", "remove-file:old/deep"],
    ["remove_directories", "remove-dir:old"],
    ["ensure_directories", "ensure-dir:new"],
    ["materialize_files", "write:new/file"],
  ])("%s 阶段 abort 不越过后续安全点", async (phase, abortEvent) => {
    const keep = item("keep", "keep");
    const old = item("old/deep", "old");
    const fresh = item("new/file", "fresh");
    const state = setup([keep, fresh]);
    state.sandbox.files.set("keep", keep.body);
    state.sandbox.files.set("old/deep", old.body);
    const controller = new AbortController();
    state.sandbox.onEvent = (event) => {
      if (event === abortEvent) controller.abort();
    };
    await expect(
      state.service.materialize({
        ...request(`abort-${phase}`, manifest([keep, fresh]), manifest([keep, old])),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(state.sandbox.events.at(-1)).toBe(abortEvent);
    expect(state.journal.failures).toEqual([{ code: "CANCELLED", disposition: "retryable" }]);
  });

  it("Sandbox generation 变化后旧 operation 不得重绑到新 Sandbox", async () => {
    const value = item("file", "body");
    const state = setup([value]);
    state.sandbox.knownEvent = "write:file";
    await expect(
      state.service.materialize(request("cross-sandbox", manifest([value]))),
    ).rejects.toBeTruthy();
    state.sandbox.knownEvent = undefined;
    state.sandbox.session = { sessionId: "sandbox-b", generation: 2 };
    await expect(
      state.service.materialize(request("cross-sandbox", manifest([value]))),
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  });

  it("子operation key绑定父digest、路径、内容和完整object identity", async () => {
    const incarnationA = item("file", "same");
    const incarnationB = item("file", "same");
    const first = setup([incarnationA]);
    const second = setup([incarnationB]);
    await first.service.materialize(request("child-a", manifest([incarnationA])));
    await second.service.materialize(request("child-b", manifest([incarnationB])));
    expect(first.sandbox.childKeys[0]).not.toBe(second.sandbox.childKeys[0]);
  });

  it("completed journal 是 unknown 边界：拒绝 Proxy、getter、额外字段和身份漂移", async () => {
    const value = item("file", "body");
    for (const malicious of [
      new Proxy({ status: "completed", result: {} }, {}),
      Object.defineProperty({ status: "completed" }, "result", {
        enumerable: true,
        get: () => ({}),
      }),
      { status: "completed", result: {}, extra: true },
    ]) {
      const state = setup([value]);
      state.journal.beginOverride = malicious;
      await expect(
        state.service.materialize(request(`mal-${Math.random()}`, manifest([value]))),
      ).rejects.toMatchObject({ code: "DEPENDENCY_FAILED" });
    }

    const state = setup([value]);
    await state.service.materialize(request("complete", manifest([value])));
    const row = state.journal.rows.get("complete");
    if (row?.result?.kind !== "materialized") throw new Error("fake completed missing");
    row.result = { ...row.result, sandbox: { sessionId: "other", generation: 1 } };
    await expect(
      state.service.materialize(request("complete", manifest([value]))),
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  });

  it("inspect、授权回执与 HEAD 都立即快照精确字段，getter/额外字段不产生删除或写入", async () => {
    const value = item("file", "body");
    let getterCalls = 0;
    const inspect = setup([value]);
    inspect.sandbox.inspectOverride = Object.defineProperty({}, "status", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return getterCalls === 1 ? "directory" : "regular";
      },
    }) as Awaited<ReturnType<SandboxWorkspacePort["inspectRegularFile"]>>;
    await expect(
      inspect.service.materialize(request("inspect-getter", manifest([value]), manifest([value]))),
    ).rejects.toMatchObject({ code: "DEPENDENCY_FAILED" });
    expect(getterCalls).toBe(0);
    expect(inspect.sandbox.writeEffects).toBe(0);
    expect(inspect.sandbox.events.some((event) => event.startsWith("remove"))).toBe(false);

    const authorization = setup([value]);
    const receipt = {
      authorizationId: "auth-x",
      tenantId: SCOPE.tenantId,
      purpose: "workspace" as const,
      content: value.entry.content,
    };
    Object.defineProperty(receipt, "object", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return value.entry.object;
      },
    });
    authorization.blobs.authorizationOverride = {
      status: "authorized",
      receipt: receipt as WorkspaceStableAuthorizationReceipt,
    };
    await expect(
      authorization.service.materialize(request("receipt-getter", manifest([value]))),
    ).rejects.toMatchObject({ code: "DEPENDENCY_FAILED" });
    expect(authorization.sandbox.events).toEqual([]);

    const head = setup([value]);
    head.blobs.headOverride = {
      status: "exists",
      content: value.entry.content,
      object: value.entry.object,
      extra: "provider-path",
    } as Awaited<ReturnType<WorkspaceStableBlobReadPort["head"]>>;
    await expect(
      head.service.materialize(request("head-extra", manifest([value]))),
    ).rejects.toMatchObject({ code: "DEPENDENCY_FAILED" });
    expect(head.sandbox.events).toEqual([]);
  });

  it("适配器伪造公开 WorkspaceApplicationError 仍按不可信依赖脱敏，无 cause/secret/path", async () => {
    const value = item("file", "body");
    const state = setup([value]);
    state.sandbox.inspectError = new WorkspaceApplicationError(
      "ACCESS_DENIED",
      "secret provider /var/private/path",
    );
    await expect(
      state.service.materialize(request("forged-error", manifest([value]), manifest([value]))),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof WorkspaceApplicationError &&
        error.code === "DEPENDENCY_FAILED" &&
        !error.message.includes("secret") &&
        !error.message.includes("path") &&
        !("cause" in error)
      );
    });
  });

  it("complete 已提交但响应 UNKNOWN 时不降级 completed，重入读回且不重复 Sandbox 写", async () => {
    const value = item("file", "body");
    const state = setup([value]);
    state.journal.completeAfterStoreUnknown = true;
    await expect(
      state.service.materialize(request("complete-unknown", manifest([value]))),
    ).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
    expect(state.journal.rows.get("complete-unknown")?.state).toBe("completed");
    state.journal.completeAfterStoreUnknown = false;
    await state.service.materialize(request("complete-unknown", manifest([value])));
    expect(state.sandbox.writeEffects).toBe(1);
  });

  it("journal begin 异常统一脱敏，不泄漏 provider secret/path", async () => {
    const value = item("file", "body");
    const state = setup([value]);
    state.journal.beginError = new WorkspaceDependencyError("known", "secret/provider/path");
    await expect(
      state.service.materialize(request("begin-error", manifest([value]))),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof WorkspaceApplicationError &&
        error.code === "DEPENDENCY_FAILED" &&
        !error.message.includes("secret") &&
        !error.message.includes("path")
      );
    });
  });

  it("previous 使用独立有界历史策略解析，超限在 journal 与 Blob 前拒绝", async () => {
    const huge = item("huge", "x".repeat(65));
    const target = manifest([]);
    const previous = createWorkspaceManifest(
      { tenantId: SCOPE.tenantId, entries: [huge.entry] },
      { maxFiles: 2, maxTotalBytes: 100, maxSingleFileBytes: 100 },
    );
    const state = setup([]);
    const strictPolicy = {
      ...POLICY,
      historicalManifest: { maxFiles: 2, maxTotalBytes: 64, maxSingleFileBytes: 64 },
    };
    const service = new WorkspaceMaterializer({
      journal: state.journal,
      stableBlobs: state.blobs,
      sandbox: state.sandbox,
      policy: strictPolicy,
    });
    await expect(
      service.materialize(request("history-limit", target, previous)),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(state.journal.rows.size).toBe(0);
    expect(state.blobs.authorizeCalls).toBe(0);
  });

  it("journal failKnown 异常统一脱敏且不重复CAS", async () => {
    const value = item("file", "body");
    const state = setup([value]);
    state.sandbox.knownEvent = "write:file";
    state.journal.failKnownError = new WorkspaceDependencyError("known", "contains_secret_path");
    await expect(
      state.service.materialize(request("journal-fail", manifest([value]))),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_FAILED",
      message: expect.not.stringContaining("secret"),
    });
    expect(state.journal.failures).toHaveLength(0);
  });
});

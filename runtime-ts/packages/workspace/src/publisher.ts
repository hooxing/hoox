import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  WorkspaceCoreApplicationError as WorkspaceApplicationError,
  WorkspaceDependencyError,
} from "./application-errors.js";
import type {
  SandboxWorkspaceEntry,
  SandboxWorkspacePort,
  SandboxWorkspaceSnapshot,
  ValidatedWorkspaceChange,
  WorkspaceCandidateBlob,
  WorkspaceCandidateBlobWritePort,
  WorkspaceCandidateIdentity,
  WorkspaceExecutionPolicy,
  WorkspaceOperationIdentity,
  WorkspaceOperationJournalPort,
  WorkspaceTrustedScope,
} from "./application-ports.js";
import {
  beginOperation,
  digestStream,
  exactKeys,
  isWorkspaceJournalError,
  mapDependencyFailure,
  parseContentIdentity,
  parseExternalAsyncIterable,
  parseExternalStream,
  parseSandboxSession,
  parseSandboxSnapshot,
  parseStableObjectIdentity,
  plainDataRecord,
  recordKnownFailure,
  stopPoint,
  validateOperationKey,
  validatePolicy,
  validateTrustedScope,
  verifyingStream,
} from "./application-support.js";
import {
  createWorkspaceManifest,
  parseWorkspaceManifest,
  type WorkspaceContentIdentity,
  type WorkspaceManifest,
  type WorkspaceManifestPolicy,
} from "./manifest.js";
import { workspaceRelativePath } from "./path.js";

const OPERATION_DIGEST_VERSION = "workspace-operation-v2";
const CANDIDATE_UPLOAD_CONCURRENCY = 4;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface WorkspacePublisherOptions {
  readonly journal: WorkspaceOperationJournalPort;
  readonly sandbox: SandboxWorkspacePort;
  readonly blobs: WorkspaceCandidateBlobWritePort;
  readonly policy: WorkspaceExecutionPolicy;
  readonly now?: () => Date;
}

export interface PublishWorkspaceInput {
  readonly operationKey: string;
  readonly scope: WorkspaceTrustedScope;
  readonly base?: WorkspaceManifest;
  readonly candidate?: WorkspaceCandidateIdentity;
  readonly signal?: AbortSignal;
}

export class WorkspacePublisher {
  private readonly policy: WorkspaceExecutionPolicy;
  private readonly manifestPolicy: WorkspaceManifestPolicy;
  private readonly now: () => Date;

  constructor(private readonly options: WorkspacePublisherOptions) {
    this.policy = validatePolicy(options.policy);
    this.manifestPolicy = currentManifestPolicy(this.policy);
    this.now = options.now ?? (() => new Date());
  }

  async publish(input: PublishWorkspaceInput): Promise<ValidatedWorkspaceChange> {
    const operationKey = validateOperationKey(input.operationKey);
    // 可信 scope 在 capture snapshot 和任何 Blob 调用前失败关闭。
    const scope = validateTrustedScope(input.scope);
    const base =
      input.base === undefined
        ? undefined
        : parseWorkspaceManifest(input.base, scope.tenantId, this.policy.historicalManifest);
    const completed = await this.lookupCompleted(operationKey, scope, base, input.candidate);
    if (completed !== undefined) return completed;
    const sandbox = await this.currentSandbox();
    try {
      const snapshot = await this.captureSnapshot(operationKey, scope);
      if (snapshot.sessionId !== sandbox.sessionId || snapshot.generation !== sandbox.generation) {
        throw new WorkspaceApplicationError("INVALID_INPUT", "Sandbox snapshot 身份发生漂移");
      }
      const identity = publishIdentity({
        operationKey,
        scope,
        snapshot,
        ...(base === undefined ? {} : { base }),
        ...(input.candidate === undefined ? {} : { candidate: input.candidate }),
      });
      const begun = await beginOperation(this.options.journal, identity);
      if (begun.status === "completed") {
        return parsePublishedResult(begun.result, identity, base, this.manifestPolicy);
      }

      let phase = "list_workspace";
      try {
        stopPoint(input.signal);
        const entries = await this.collectEntries(identity, snapshot, input.signal);
        const manifestEntries: unknown[] = [];
        const baseByPath = new Map(base?.entries.map((entry) => [entry.path, entry]) ?? []);
        const uploads: {
          readonly index: number;
          readonly relativePath: string;
          readonly content: WorkspaceContentIdentity;
        }[] = [];
        let totalBytes = 0;

        for (const entry of entries) {
          if (entry.kind !== "file") continue;
          const relativePath = workspaceRelativePath(entry.relativePath);
          const declaredSize = requireDeclaredSize(entry, this.policy);
          if (totalBytes > this.policy.maxTotalBytes - declaredSize) {
            throw new WorkspaceApplicationError("LIMIT_EXCEEDED", "Workspace 总字节数超过配额");
          }
          totalBytes += declaredSize;

          phase = "hash_snapshot_file";
          stopPoint(input.signal);
          const content = await digestStream({
            source: parseExternalStream(
              this.options.sandbox.readRegularFile(
                snapshot,
                relativePath,
                signalControl(input.signal),
              ),
              "Sandbox 快照文件流",
            ),
            policy: this.policy,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
          if (content.size !== declaredSize) {
            throw new WorkspaceApplicationError("INTEGRITY_MISMATCH", "Sandbox 快照文件长度不匹配");
          }

          const previous = baseByPath.get(relativePath);
          if (
            previous !== undefined &&
            previous.content.sha256 === content.sha256 &&
            previous.content.size === content.size
          ) {
            // unchanged 必须复用 base 的精确 incarnation；不能仅因内容相同再创建 Blob 引用。
            manifestEntries.push(previous);
            continue;
          }
          uploads.push({ index: manifestEntries.length, relativePath, content });
          manifestEntries.push(undefined);
        }

        phase = "upload_candidate";
        // 不同内容的候选并发上传以摊薄每个文件约一次往返的协议开销；内容相同的文件共享同一
        // content-addressed lifecycle，同组内保持串行，避免并发创建同一 lifecycle。
        const groups = new Map<string, (typeof uploads)[number][]>();
        for (const upload of uploads) {
          const key = `${upload.content.sha256}:${upload.content.size}`;
          groups.set(key, [...(groups.get(key) ?? []), upload]);
        }
        await runBounded([...groups.values()], CANDIDATE_UPLOAD_CONCURRENCY, async (group) => {
          for (const upload of group) {
            manifestEntries[upload.index] = await this.uploadCandidate(
              identity,
              scope,
              snapshot,
              upload.relativePath,
              upload.content,
              input,
            );
          }
        });

        stopPoint(input.signal);
        phase = "build_candidate";
        const candidateManifest = createWorkspaceManifest(
          { tenantId: scope.tenantId, entries: manifestEntries },
          this.manifestPolicy,
        );
        const change: ValidatedWorkspaceChange = Object.freeze({
          kind: "validated_workspace_change",
          operationKey,
          ...scope,
          sandboxSnapshot: snapshot,
          ...(base === undefined ? {} : { baseManifestDigest: base.digest }),
          candidateManifest,
          verifiedAt: this.now().toISOString(),
        });
        stopPoint(input.signal);
        phase = "complete";
        await this.callDependency(identity, phase, () =>
          this.options.journal.complete(identity, {
            kind: "published",
            operationKey,
            change,
          }),
        );
        return change;
      } catch (error) {
        const mapped =
          error instanceof WorkspaceApplicationError
            ? error
            : new WorkspaceApplicationError("DEPENDENCY_FAILED", "Workspace 发布失败");
        if (mapped.code !== "RESULT_UNKNOWN" && !isWorkspaceJournalError(mapped)) {
          await recordKnownFailure(this.options.journal, identity, phase, mapped);
        }
        throw mapped;
      }
    } finally {
      await this.options.sandbox.releaseSnapshots({ sandbox, operationKey });
    }
  }

  private async currentSandbox() {
    try {
      return parseSandboxSession(await this.options.sandbox.currentSession());
    } catch (error) {
      if (error instanceof WorkspaceApplicationError) throw error;
      throw new WorkspaceApplicationError(
        error instanceof WorkspaceDependencyError && error.result === "unknown"
          ? "RESULT_UNKNOWN"
          : "DEPENDENCY_FAILED",
        "读取 Sandbox 身份失败",
      );
    }
  }

  private async lookupCompleted(
    operationKey: string,
    scope: WorkspaceTrustedScope,
    base: WorkspaceManifest | undefined,
    candidate: WorkspaceCandidateIdentity | undefined,
  ): Promise<ValidatedWorkspaceChange | undefined> {
    let raw: unknown;
    try {
      raw = await this.options.journal.lookupCompleted({
        operationKey,
        scope,
        kind: "publish",
      });
    } catch {
      throw new WorkspaceApplicationError("DEPENDENCY_FAILED", "查询 Workspace 完成事实失败");
    }
    const lookup = plainDataRecord(raw, "WorkspaceCompletedLookup");
    if (lookup.status === "not_found") {
      exactKeys(lookup, ["status"], "WorkspaceCompletedLookup");
      return undefined;
    }
    exactKeys(lookup, ["status", "identity", "result"], "WorkspaceCompletedLookup");
    if (lookup.status !== "completed") {
      throw new WorkspaceApplicationError("DEPENDENCY_FAILED", "Workspace 完成事实状态非法");
    }
    const identity = parseStoredPublishIdentity(
      lookup.identity,
      operationKey,
      scope,
      base,
      candidate,
    );
    return parsePublishedResult(lookup.result, identity, base, this.manifestPolicy);
  }

  private async captureSnapshot(
    operationKey: string,
    scope: WorkspaceTrustedScope,
  ): Promise<SandboxWorkspaceSnapshot> {
    try {
      return parseSandboxSnapshot(
        await this.options.sandbox.captureSnapshot({ operationKey, scope }),
      );
    } catch (error) {
      if (error instanceof WorkspaceApplicationError) throw error;
      throw new WorkspaceApplicationError(
        error instanceof WorkspaceDependencyError && error.result === "unknown"
          ? "RESULT_UNKNOWN"
          : "DEPENDENCY_FAILED",
        "取得 Sandbox Workspace 快照失败",
      );
    }
  }

  private async collectEntries(
    identity: WorkspaceOperationIdentity,
    snapshot: SandboxWorkspaceSnapshot,
    signal: AbortSignal | undefined,
  ): Promise<readonly SandboxWorkspaceEntry[]> {
    try {
      const result: SandboxWorkspaceEntry[] = [];
      const paths = new Set<string>();
      let fileCount = 0;
      const listed = parseExternalAsyncIterable<unknown>(
        this.options.sandbox.listWorkspace(snapshot, signalControl(signal)),
        "Sandbox Workspace 清单流",
      );
      for await (const raw of listed) {
        stopPoint(signal);
        if (result.length >= this.policy.maxEntries) {
          throw new WorkspaceApplicationError("LIMIT_EXCEEDED", "Workspace 条目数量超过配额");
        }
        const entry = parseSandboxEntry(raw);
        const relativePath = workspaceRelativePath(entry.relativePath);
        if (Buffer.byteLength(relativePath, "utf8") > this.policy.maxPathUtf8Bytes) {
          throw new WorkspaceApplicationError("LIMIT_EXCEEDED", "Workspace 路径超过配额");
        }
        if (paths.has(relativePath)) {
          throw new WorkspaceApplicationError("UNSAFE_SANDBOX_ENTRY", "Sandbox 清单包含重复路径");
        }
        paths.add(relativePath);
        if (entry.kind === "symlink" || entry.kind === "special") {
          throw new WorkspaceApplicationError(
            "UNSAFE_SANDBOX_ENTRY",
            "Sandbox Workspace 包含不允许的文件类型",
          );
        }
        if (entry.kind === "file") {
          fileCount += 1;
          if (fileCount > this.policy.maxFiles) {
            throw new WorkspaceApplicationError("LIMIT_EXCEEDED", "Workspace 文件数量超过配额");
          }
        }
        result.push(
          Object.freeze({
            relativePath,
            kind: entry.kind,
            ...(entry.size === undefined ? {} : { size: entry.size }),
          }),
        );
      }
      assertDirectoryFileShape(result);
      return Object.freeze(result);
    } catch (error) {
      return mapDependencyFailure(error, {
        journal: this.options.journal,
        identity,
        phase: "list_workspace",
        now: this.now,
      });
    }
  }

  private async uploadCandidate(
    identity: WorkspaceOperationIdentity,
    scope: WorkspaceTrustedScope,
    snapshot: SandboxWorkspaceSnapshot,
    relativePath: string,
    content: WorkspaceContentIdentity,
    input: PublishWorkspaceInput,
  ): Promise<unknown> {
    stopPoint(input.signal);
    const verified = verifyingStream({
      source: parseExternalStream(
        this.options.sandbox.readRegularFile(snapshot, relativePath, signalControl(input.signal)),
        "Sandbox 快照文件流",
      ),
      policy: this.policy,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      expected: content,
    });
    const blob = parseCandidateBlob(
      await this.callDependency(identity, "upload_candidate", () =>
        this.options.blobs.putCandidate({
          scope,
          purpose: "workspace",
          operationKey: candidateOperationKey(identity, relativePath, content),
          relativePath,
          expectedContent: content,
          ...(input.candidate === undefined ? {} : { candidate: input.candidate }),
          body: verified.body,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
      ),
    );
    if (verified.status() === "pending") {
      throw new WorkspaceApplicationError(
        "DEPENDENCY_FAILED",
        "候选 Blob 端口未消费完整文件流",
        "candidate_stream_pending",
      );
    }
    await verified.result;
    if (!sameCandidateContent(blob, content)) {
      throw new WorkspaceApplicationError("INTEGRITY_MISMATCH", "上传结果与快照内容身份不一致");
    }

    createWorkspaceManifest(
      { tenantId: scope.tenantId, entries: [manifestEntry(relativePath, blob)] },
      this.manifestPolicy,
    );
    stopPoint(input.signal);
    const head = parseCandidateHeadResult(
      await this.callDependency(identity, "verify_candidate", () =>
        this.options.blobs.headCandidate({ scope, blob }),
      ),
    );
    if (head.status !== "exists" || !sameCandidate(head.blob, blob)) {
      throw new WorkspaceApplicationError("INTEGRITY_MISMATCH", "候选 Blob HEAD 校验失败");
    }
    return manifestEntry(relativePath, blob);
  }

  private async callDependency<T>(
    identity: WorkspaceOperationIdentity,
    phase: string,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      return mapDependencyFailure(error, {
        journal: this.options.journal,
        identity,
        phase,
        now: this.now,
      });
    }
  }
}

function publishIdentity(input: {
  readonly operationKey: string;
  readonly scope: WorkspaceTrustedScope;
  readonly snapshot: SandboxWorkspaceSnapshot;
  readonly base?: WorkspaceManifest;
  readonly candidate?: WorkspaceCandidateIdentity;
}): WorkspaceOperationIdentity {
  const payload = [
    OPERATION_DIGEST_VERSION,
    "publish",
    input.scope.tenantId,
    input.scope.threadId,
    input.scope.workspaceId,
    input.snapshot.sessionId,
    String(input.snapshot.generation),
    input.snapshot.snapshotToken,
    input.base?.digest ?? "",
    input.candidate?.operationDigest ?? "",
  ].join("\0");
  return Object.freeze({
    schemaVersion: 1,
    digestAlgorithm: OPERATION_DIGEST_VERSION,
    operationKey: input.operationKey,
    kind: "publish",
    inputDigest: createHash("sha256").update(payload).digest("hex"),
    ...input.scope,
    sandbox: Object.freeze({
      sessionId: input.snapshot.sessionId,
      generation: input.snapshot.generation,
    }),
    snapshotToken: input.snapshot.snapshotToken,
  });
}

function parseStoredPublishIdentity(
  value: unknown,
  operationKey: string,
  scope: WorkspaceTrustedScope,
  base: WorkspaceManifest | undefined,
  candidate: WorkspaceCandidateIdentity | undefined,
): WorkspaceOperationIdentity {
  const stored = plainDataRecord(value, "WorkspaceOperationIdentity");
  exactKeys(
    stored,
    [
      "schemaVersion",
      "digestAlgorithm",
      "operationKey",
      "kind",
      "inputDigest",
      "tenantId",
      "threadId",
      "workspaceId",
      "sandbox",
      "snapshotToken",
    ],
    "WorkspaceOperationIdentity",
  );
  if (
    stored.schemaVersion !== 1 ||
    stored.digestAlgorithm !== OPERATION_DIGEST_VERSION ||
    stored.operationKey !== operationKey ||
    stored.kind !== "publish" ||
    stored.tenantId !== scope.tenantId ||
    stored.threadId !== scope.threadId ||
    stored.workspaceId !== scope.workspaceId
  ) {
    throw new WorkspaceApplicationError("OPERATION_CONFLICT", "已完成发布身份与请求不一致");
  }
  const sandbox = parseSandboxSession(stored.sandbox);
  const snapshot = parseSandboxSnapshot({
    ...sandbox,
    snapshotToken: stored.snapshotToken,
  });
  const expected = publishIdentity({
    operationKey,
    scope,
    snapshot,
    ...(base === undefined ? {} : { base }),
    ...(candidate === undefined ? {} : { candidate }),
  });
  if (stored.inputDigest !== expected.inputDigest) {
    throw new WorkspaceApplicationError("OPERATION_CONFLICT", "已完成发布输入摘要与请求不一致");
  }
  return expected;
}

function parsePublishedResult(
  value: unknown,
  identity: WorkspaceOperationIdentity,
  base: WorkspaceManifest | undefined,
  policy: WorkspaceManifestPolicy,
): ValidatedWorkspaceChange {
  const result = plainDataRecord(value, "PublishedWorkspaceResult");
  exactKeys(result, ["kind", "operationKey", "change"], "PublishedWorkspaceResult");
  if (result.kind !== "published" || result.operationKey !== identity.operationKey) {
    throw new WorkspaceApplicationError("OPERATION_CONFLICT", "已完成发布结果与 operation 不一致");
  }
  const change = plainDataRecord(result.change, "ValidatedWorkspaceChange");
  const expectedKeys = [
    "kind",
    "operationKey",
    "tenantId",
    "threadId",
    "workspaceId",
    "sandboxSnapshot",
    "candidateManifest",
    "verifiedAt",
    ...(base === undefined ? [] : ["baseManifestDigest"]),
  ];
  exactKeys(change, expectedKeys, "ValidatedWorkspaceChange");
  const scope = validateTrustedScope({
    tenantId: change.tenantId,
    threadId: change.threadId,
    workspaceId: change.workspaceId,
  } as WorkspaceTrustedScope);
  const snapshot = parseSandboxSnapshot(change.sandboxSnapshot);
  if (
    change.kind !== "validated_workspace_change" ||
    change.operationKey !== identity.operationKey ||
    !sameScope(scope, identity) ||
    !sameSnapshot(snapshot, identity) ||
    change.baseManifestDigest !== base?.digest ||
    typeof change.verifiedAt !== "string" ||
    !canonicalIsoTimestamp(change.verifiedAt)
  ) {
    throw new WorkspaceApplicationError("OPERATION_CONFLICT", "已完成发布候选身份不一致");
  }
  if (
    base !== undefined &&
    (typeof change.baseManifestDigest !== "string" ||
      !SHA256_PATTERN.test(change.baseManifestDigest))
  ) {
    throw new WorkspaceApplicationError("OPERATION_CONFLICT", "baseManifestDigest 格式无效");
  }
  const candidateManifest = parseWorkspaceManifest(
    change.candidateManifest,
    scope.tenantId,
    policy,
  );
  return Object.freeze({
    kind: "validated_workspace_change",
    operationKey: identity.operationKey,
    ...scope,
    sandboxSnapshot: snapshot,
    ...(base === undefined ? {} : { baseManifestDigest: base.digest }),
    candidateManifest,
    verifiedAt: change.verifiedAt,
  });
}

function requireDeclaredSize(
  entry: SandboxWorkspaceEntry,
  policy: WorkspaceExecutionPolicy,
): number {
  if (
    entry.size === undefined ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    entry.size > policy.maxSingleFileBytes
  ) {
    throw new WorkspaceApplicationError("LIMIT_EXCEEDED", "Sandbox 文件大小声明无效或超过配额");
  }
  return entry.size;
}

function candidateOperationKey(
  identity: WorkspaceOperationIdentity,
  path: string,
  content: { readonly sha256: string; readonly size: number },
): string {
  const payload = [
    "workspace-candidate-child-v1",
    identity.inputDigest,
    path,
    content.sha256,
    String(content.size),
  ].join("\0");
  return `workspace-candidate:${createHash("sha256").update(payload).digest("hex")}`;
}

function assertDirectoryFileShape(entries: readonly SandboxWorkspaceEntry[]): void {
  const files = new Set(
    entries.filter((entry) => entry.kind === "file").map((entry) => entry.relativePath),
  );
  for (const directory of entries.filter((entry) => entry.kind === "directory")) {
    const segments = directory.relativePath.split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      if (files.has(segments.slice(0, index).join("/"))) {
        throw new WorkspaceApplicationError(
          "UNSAFE_SANDBOX_ENTRY",
          "Sandbox 清单包含目录与文件冲突",
        );
      }
    }
  }
}

function currentManifestPolicy(policy: WorkspaceExecutionPolicy): WorkspaceManifestPolicy {
  return {
    maxFiles: policy.maxFiles,
    maxTotalBytes: policy.maxTotalBytes,
    maxSingleFileBytes: policy.maxSingleFileBytes,
    maxPathUtf8Bytes: policy.maxPathUtf8Bytes,
  };
}

function manifestEntry(path: string, blob: WorkspaceCandidateBlob) {
  return { type: "file" as const, path, content: blob.content, object: blob.object };
}

function sameCandidateContent(
  blob: WorkspaceCandidateBlob,
  content: { readonly sha256: string; readonly size: number },
): boolean {
  return blob.content.sha256 === content.sha256 && blob.content.size === content.size;
}

function sameCandidate(left: WorkspaceCandidateBlob, right: WorkspaceCandidateBlob): boolean {
  return (
    sameCandidateContent(left, right.content) &&
    left.object.tenantId === right.object.tenantId &&
    left.object.purpose === right.object.purpose &&
    left.object.incarnationId === right.object.incarnationId &&
    left.object.physicalObjectKey === right.object.physicalObjectKey
  );
}

function sameScope(left: WorkspaceTrustedScope, right: WorkspaceTrustedScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.threadId === right.threadId &&
    left.workspaceId === right.workspaceId
  );
}

function sameSnapshot(
  snapshot: SandboxWorkspaceSnapshot,
  identity: WorkspaceOperationIdentity,
): boolean {
  return (
    snapshot.sessionId === identity.sandbox.sessionId &&
    snapshot.generation === identity.sandbox.generation &&
    snapshot.snapshotToken === identity.snapshotToken
  );
}

function canonicalIsoTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function signalControl(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function parseSandboxEntry(value: unknown): SandboxWorkspaceEntry {
  const input = plainDataRecord(value, "Sandbox Workspace 条目");
  if (input.kind === "file") {
    exactKeys(input, ["relativePath", "kind", "size"], "Sandbox Workspace 条目");
    if (
      typeof input.relativePath !== "string" ||
      !Number.isSafeInteger(input.size) ||
      (input.size as number) < 0
    ) {
      throw new WorkspaceApplicationError("DEPENDENCY_FAILED", "Sandbox 文件条目字段无效");
    }
    return Object.freeze({
      relativePath: input.relativePath,
      kind: "file",
      size: input.size as number,
    });
  }
  if (input.kind === "directory" || input.kind === "symlink" || input.kind === "special") {
    exactKeys(input, ["relativePath", "kind"], "Sandbox Workspace 条目");
    if (typeof input.relativePath !== "string") {
      throw new WorkspaceApplicationError("DEPENDENCY_FAILED", "Sandbox 条目路径字段无效");
    }
    return Object.freeze({ relativePath: input.relativePath, kind: input.kind });
  }
  throw new WorkspaceApplicationError("DEPENDENCY_FAILED", "Sandbox 条目类型无效");
}

function parseCandidateBlob(value: unknown): WorkspaceCandidateBlob {
  const input = plainDataRecord(value, "Workspace candidate Blob");
  const keys = Object.keys(input).sort();
  if (
    (keys.length !== 2 || keys[0] !== "content" || keys[1] !== "object") &&
    (keys.length !== 3 ||
      keys[0] !== "content" ||
      keys[1] !== "object" ||
      keys[2] !== "referenceId")
  ) {
    throw new WorkspaceApplicationError("DEPENDENCY_FAILED", "Workspace candidate Blob 字段无效");
  }
  const referenceId = input.referenceId;
  if (
    referenceId !== undefined &&
    (typeof referenceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(referenceId))
  ) {
    throw new WorkspaceApplicationError(
      "DEPENDENCY_FAILED",
      "Workspace candidate Blob 引用身份无效",
    );
  }
  return Object.freeze({
    content: parseContentIdentity(input.content),
    object: parseStableObjectIdentity(input.object),
    ...(referenceId === undefined ? {} : { referenceId }),
  });
}

type ParsedCandidateHeadResult =
  | { readonly status: "not_found" }
  | { readonly status: "exists"; readonly blob: WorkspaceCandidateBlob };

function parseCandidateHeadResult(value: unknown): ParsedCandidateHeadResult {
  const input = plainDataRecord(value, "Workspace candidate HEAD 结果");
  if (input.status === "not_found") {
    exactKeys(input, ["status"], "Workspace candidate HEAD 结果");
    return Object.freeze({ status: "not_found" });
  }
  if (input.status !== "exists") {
    throw new WorkspaceApplicationError("DEPENDENCY_FAILED", "Workspace candidate HEAD 状态无效");
  }
  exactKeys(input, ["status", "blob"], "Workspace candidate HEAD 结果");
  return Object.freeze({ status: "exists", blob: parseCandidateBlob(input.blob) });
}

/**
 * 以有界并发执行任务。首个失败后不再启动新任务，但会等待已启动的任务结束再抛出首个错误，
 * 避免调用方返回后仍有上传在后台改写候选事实。
 */
async function runBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { readonly error: unknown } | undefined;
  const worker = async () => {
    while (failure === undefined && next < items.length) {
      const item = items[next] as T;
      next += 1;
      try {
        await task(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== undefined) throw failure.error;
}

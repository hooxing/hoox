import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { WorkspaceApplicationError, WorkspaceDependencyError } from "./application-errors.js";
import type {
  SandboxWorkspaceEntry,
  SandboxWorkspacePort,
  SandboxWorkspaceSnapshot,
  ValidatedWorkspaceChange,
  WorkspaceCandidateBlob,
  WorkspaceCandidateBlobWritePort,
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
  parseSandboxSnapshot,
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
  type WorkspaceManifest,
  type WorkspaceManifestPolicy,
} from "./manifest.js";
import { workspaceRelativePath } from "./path.js";

const OPERATION_DIGEST_VERSION = "workspace-operation-v2";
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
    const snapshot = await this.captureSnapshot(operationKey, scope);
    const identity = publishIdentity({
      operationKey,
      scope,
      snapshot,
      ...(base === undefined ? {} : { base }),
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
          source: this.options.sandbox.readRegularFile(
            snapshot,
            relativePath,
            signalControl(input.signal),
          ),
          policy: this.policy,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        if (content.size !== declaredSize) {
          throw new WorkspaceApplicationError("INTEGRITY_MISMATCH", "Sandbox 快照文件长度不匹配");
        }

        phase = "upload_candidate";
        stopPoint(input.signal);
        const verified = verifyingStream({
          source: this.options.sandbox.readRegularFile(
            snapshot,
            relativePath,
            signalControl(input.signal),
          ),
          policy: this.policy,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          expected: content,
        });
        const blob = await this.callDependency(identity, phase, () =>
          this.options.blobs.putCandidate({
            scope,
            purpose: "workspace",
            operationKey: candidateOperationKey(identity, relativePath, content),
            relativePath,
            expectedContent: content,
            body: verified.body,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          }),
        );
        if (verified.status() === "pending") {
          throw new WorkspaceApplicationError(
            "DEPENDENCY_FAILED",
            "候选 Blob 端口未消费完整文件流",
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
        phase = "verify_candidate";
        const head = await this.callDependency(identity, phase, () =>
          this.options.blobs.headCandidate({ scope, blob }),
        );
        if (head.status !== "exists" || !sameCandidate(head.blob, blob)) {
          throw new WorkspaceApplicationError("INTEGRITY_MISMATCH", "候选 Blob HEAD 校验失败");
        }
        manifestEntries.push(manifestEntry(relativePath, blob));
      }

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
      for await (const raw of this.options.sandbox.listWorkspace(snapshot, signalControl(signal))) {
        stopPoint(signal);
        if (result.length >= this.policy.maxEntries) {
          throw new WorkspaceApplicationError("LIMIT_EXCEEDED", "Workspace 条目数量超过配额");
        }
        const relativePath = workspaceRelativePath(raw.relativePath);
        if (Buffer.byteLength(relativePath, "utf8") > this.policy.maxPathUtf8Bytes) {
          throw new WorkspaceApplicationError("LIMIT_EXCEEDED", "Workspace 路径超过配额");
        }
        if (paths.has(relativePath)) {
          throw new WorkspaceApplicationError("UNSAFE_SANDBOX_ENTRY", "Sandbox 清单包含重复路径");
        }
        paths.add(relativePath);
        if (raw.kind === "symlink" || raw.kind === "special") {
          throw new WorkspaceApplicationError(
            "UNSAFE_SANDBOX_ENTRY",
            "Sandbox Workspace 包含不允许的文件类型",
          );
        }
        if (raw.kind === "file") {
          fileCount += 1;
          if (fileCount > this.policy.maxFiles) {
            throw new WorkspaceApplicationError("LIMIT_EXCEEDED", "Workspace 文件数量超过配额");
          }
        }
        result.push(Object.freeze({ ...raw, relativePath }));
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

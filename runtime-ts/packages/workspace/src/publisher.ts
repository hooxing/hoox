import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { WorkspaceApplicationError } from "./application-errors.js";
import type {
  SandboxWorkspaceEntry,
  SandboxWorkspacePort,
  ValidatedWorkspaceChange,
  WorkspaceCandidateBlob,
  WorkspaceCandidateBlobWritePort,
  WorkspaceExecutionPolicy,
  WorkspaceOperationIdentity,
  WorkspaceOperationJournalPort,
} from "./application-ports.js";
import {
  beginOperation,
  mapDependencyFailure,
  stopPoint,
  validateOperationKey,
  validatePolicy,
  verifyingStream,
} from "./application-support.js";
import {
  assertWorkspaceManifestIntegrity,
  createWorkspaceManifest,
  type WorkspaceManifest,
  type WorkspaceManifestPolicy,
} from "./manifest.js";
import { workspaceRelativePath } from "./path.js";

export interface WorkspacePublisherOptions {
  readonly journal: WorkspaceOperationJournalPort;
  readonly sandbox: SandboxWorkspacePort;
  readonly blobs: WorkspaceCandidateBlobWritePort;
  readonly policy: WorkspaceExecutionPolicy;
  readonly now?: () => Date;
}

export interface PublishWorkspaceInput {
  readonly operationKey: string;
  readonly tenantId: string;
  readonly base?: WorkspaceManifest;
  readonly signal?: AbortSignal;
}

/**
 * 从 Sandbox 快照生成“待提交候选”。本类不持有 Workspace Lease，也没有推进 PG Revision/head 的能力。
 */
export class WorkspacePublisher {
  private readonly policy: WorkspaceExecutionPolicy;
  private readonly manifestPolicy: WorkspaceManifestPolicy;
  private readonly now: () => Date;

  constructor(private readonly options: WorkspacePublisherOptions) {
    this.policy = validatePolicy(options.policy);
    this.manifestPolicy = Object.freeze({
      maxFiles: this.policy.maxFiles,
      maxTotalBytes: this.policy.maxTotalBytes,
      maxSingleFileBytes: this.policy.maxSingleFileBytes,
      maxPathUtf8Bytes: this.policy.maxPathUtf8Bytes,
    });
    this.now = options.now ?? (() => new Date());
  }

  async publish(input: PublishWorkspaceInput): Promise<ValidatedWorkspaceChange> {
    const operationKey = validateOperationKey(input.operationKey);
    const base =
      input.base === undefined ? undefined : assertWorkspaceManifestIntegrity(input.base);
    if (base !== undefined && base.tenantId !== input.tenantId) {
      throw new WorkspaceApplicationError("ACCESS_DENIED", "基础 Workspace 不属于可信 Tenant");
    }
    const identity: WorkspaceOperationIdentity = Object.freeze({
      operationKey,
      kind: "publish",
      inputDigest: createHash("sha256")
        .update(`${input.tenantId}\0${base?.digest ?? "empty"}`)
        .digest("hex"),
    });
    const begun = await beginOperation(this.options.journal, identity);
    if (begun.status === "completed") {
      if (
        begun.result.kind !== "published" ||
        begun.result.change.tenantId !== input.tenantId ||
        begun.result.change.baseManifestDigest !== base?.digest
      ) {
        throw new WorkspaceApplicationError("OPERATION_CONFLICT", "已完成结果与当前发布输入不一致");
      }
      return begun.result.change;
    }

    let phase = "list_workspace";
    try {
      stopPoint(input.signal);
      const entries = await this.collectEntries(identity, input.signal);
      const manifestEntries: unknown[] = [];
      let totalBytes = 0;

      for (const entry of entries) {
        if (entry.kind !== "file") continue;
        phase = "upload_candidate";
        stopPoint(input.signal);
        const declaredSize = requireDeclaredSize(entry, this.policy);
        if (totalBytes > this.policy.maxTotalBytes - declaredSize) {
          throw new WorkspaceApplicationError("LIMIT_EXCEEDED", "Workspace 总字节数超过配额");
        }
        totalBytes += declaredSize;
        const relativePath = workspaceRelativePath(entry.relativePath);
        const verified = verifyingStream({
          source: this.options.sandbox.readRegularFile(relativePath, signalControl(input.signal)),
          policy: this.policy,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        const blob = await this.callDependency(identity, phase, () =>
          this.options.blobs.putCandidate({
            tenantId: input.tenantId,
            purpose: "workspace",
            operationKey: candidateOperationKey(operationKey, relativePath),
            relativePath,
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
        const actual = await verified.result;
        if (actual.size !== declaredSize || !sameCandidateContent(blob, actual)) {
          throw new WorkspaceApplicationError(
            "INTEGRITY_MISMATCH",
            "Sandbox 文件读取长度或上传结果与声明不一致",
          );
        }

        // 在 HEAD 前先用 manifest schema 验证 tenant、purpose、incarnation 与物理键的完整绑定。
        createWorkspaceManifest(
          {
            tenantId: input.tenantId,
            entries: [manifestEntry(relativePath, blob)],
          },
          this.manifestPolicy,
        );
        stopPoint(input.signal);
        phase = "verify_candidate";
        const head = await this.callDependency(identity, phase, () =>
          this.options.blobs.headCandidate({ tenantId: input.tenantId, blob }),
        );
        if (head.status !== "exists" || !sameCandidate(head.blob, blob)) {
          throw new WorkspaceApplicationError("INTEGRITY_MISMATCH", "候选 Blob HEAD 校验失败");
        }
        manifestEntries.push(manifestEntry(relativePath, blob));
      }

      stopPoint(input.signal);
      phase = "build_candidate";
      const candidateManifest = createWorkspaceManifest(
        { tenantId: input.tenantId, entries: manifestEntries },
        this.manifestPolicy,
      );
      const change: ValidatedWorkspaceChange = Object.freeze({
        kind: "validated_workspace_change",
        operationKey,
        tenantId: input.tenantId,
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
      if (error instanceof WorkspaceApplicationError) {
        if (error.code !== "RESULT_UNKNOWN") {
          await this.options.journal.failKnown(identity, phase, error.code);
        }
        throw error;
      }
      return this.callDependency(identity, phase, async () => {
        throw error;
      });
    }
  }

  private async collectEntries(
    identity: WorkspaceOperationIdentity,
    signal: AbortSignal | undefined,
  ): Promise<readonly SandboxWorkspaceEntry[]> {
    try {
      const result: SandboxWorkspaceEntry[] = [];
      const paths = new Set<string>();
      for await (const raw of this.options.sandbox.listWorkspace(signalControl(signal))) {
        stopPoint(signal);
        if (result.length >= this.policy.maxFiles) {
          throw new WorkspaceApplicationError("LIMIT_EXCEEDED", "Workspace 文件数量超过配额");
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

function signalControl(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
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

function candidateOperationKey(operationKey: string, path: string): string {
  return `workspace-candidate:${createHash("sha256")
    .update(`${operationKey}\0${path}`)
    .digest("hex")}`;
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

function manifestEntry(path: string, blob: WorkspaceCandidateBlob) {
  return {
    type: "file" as const,
    path,
    content: blob.content,
    object: blob.object,
  };
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

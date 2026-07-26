import { createHash } from "node:crypto";
import { WorkspaceApplicationError } from "./application-errors.js";
import type {
  SandboxWorkspacePort,
  WorkspaceExecutionPolicy,
  WorkspaceOperationIdentity,
  WorkspaceOperationJournalPort,
  WorkspaceStableAuthorizationReceipt,
  WorkspaceStableBlobReadPort,
} from "./application-ports.js";
import {
  beginOperation,
  digestStream,
  mapDependencyFailure,
  stopPoint,
  validateOperationKey,
  validatePolicy,
  verifyingStream,
} from "./application-support.js";
import {
  assertWorkspaceManifestIntegrity,
  parseWorkspaceManifest,
  type WorkspaceFileEntry,
  type WorkspaceManifest,
} from "./manifest.js";
import { planWorkspaceMaterialization } from "./materialization-plan.js";
import { workspaceRelativePath } from "./path.js";

export const SANDBOX_WORKSPACE_ROOT = "/workspace" as const;

export interface WorkspaceMaterializerOptions {
  readonly journal: WorkspaceOperationJournalPort;
  readonly stableBlobs: WorkspaceStableBlobReadPort;
  readonly sandbox: SandboxWorkspacePort;
  readonly policy: WorkspaceExecutionPolicy;
  readonly now?: () => Date;
}

export interface MaterializeWorkspaceInput {
  readonly operationKey: string;
  readonly tenantId: string;
  readonly target: WorkspaceManifest;
  readonly previous?: WorkspaceManifest;
  readonly signal?: AbortSignal;
}

export interface MaterializedWorkspace {
  readonly kind: "materialized";
  readonly operationKey: string;
  readonly targetManifestDigest: string;
}

/**
 * 应用核心只向 Sandbox 窄端口传相对路径。固定根目录、授权预检和 plan 顺序均不能由调用者覆盖。
 */
export class WorkspaceMaterializer {
  private readonly policy: WorkspaceExecutionPolicy;
  private readonly now: () => Date;

  constructor(private readonly options: WorkspaceMaterializerOptions) {
    this.policy = validatePolicy(options.policy);
    this.now = options.now ?? (() => new Date());
  }

  async materialize(input: MaterializeWorkspaceInput): Promise<MaterializedWorkspace> {
    const operationKey = validateOperationKey(input.operationKey);
    const target = parseWorkspaceManifest(input.target, input.tenantId, {
      maxFiles: this.policy.maxFiles,
      maxTotalBytes: this.policy.maxTotalBytes,
      maxSingleFileBytes: this.policy.maxSingleFileBytes,
      maxPathUtf8Bytes: this.policy.maxPathUtf8Bytes,
    });
    const previous =
      input.previous === undefined ? undefined : assertWorkspaceManifestIntegrity(input.previous);
    if (target.tenantId !== input.tenantId) {
      throw new WorkspaceApplicationError("ACCESS_DENIED", "Workspace 不属于可信 Tenant");
    }
    const plan = planWorkspaceMaterialization({
      root: SANDBOX_WORKSPACE_ROOT,
      target,
      ...(previous === undefined ? {} : { previous }),
    });
    const identity: WorkspaceOperationIdentity = Object.freeze({
      operationKey,
      kind: "materialize",
      inputDigest: createHash("sha256")
        .update(`${target.tenantId}\0${previous?.digest ?? ""}\0${target.digest}`)
        .digest("hex"),
    });
    const begun = await beginOperation(this.options.journal, identity);
    if (begun.status === "completed") {
      if (
        begun.result.kind !== "materialized" ||
        begun.result.targetManifestDigest !== target.digest
      ) {
        throw new WorkspaceApplicationError("OPERATION_CONFLICT", "已完成结果与当前物化输入不一致");
      }
      return Object.freeze({ ...begun.result });
    }

    let phase = "preflight";
    try {
      stopPoint(input.signal);
      const receipts = await this.authorizeAll(target, identity, input.signal);
      const validExisting = new Set<string>();
      const filesByPath = new Map(target.entries.map((entry) => [entry.path, entry]));

      for (const plannedPhase of plan.phases) {
        phase = plannedPhase.kind;
        stopPoint(input.signal);
        if (plannedPhase.kind === "verify_existing") {
          for (const candidate of plannedPhase.candidates) {
            stopPoint(input.signal);
            const entry = filesByPath.get(candidate.relativePath);
            if (entry === undefined || receipts.get(candidate.relativePath) === undefined) {
              throw new WorkspaceApplicationError("INVALID_INPUT", "物化计划与目标清单不一致");
            }
            const inspected = await this.callDependency(identity, phase, () =>
              this.options.sandbox.inspectRegularFile(
                workspaceRelativePath(candidate.relativePath),
                signalControl(input.signal),
              ),
            );
            if (inspected.status !== "regular") continue;
            try {
              const actual = await digestStream({
                source: inspected.body,
                policy: this.policy,
                ...(input.signal === undefined ? {} : { signal: input.signal }),
                expected: entry.content,
              });
              if (actual.sha256 === entry.content.sha256 && actual.size === entry.content.size) {
                validExisting.add(entry.path);
              }
            } catch (error) {
              if (
                error instanceof WorkspaceApplicationError &&
                (error.code === "INTEGRITY_MISMATCH" || error.code === "LIMIT_EXCEEDED")
              ) {
                // 现有副本只是候选，损坏或过大时安全回退到已授权 stable Blob。
                continue;
              }
              throw error;
            }
          }
        } else if (plannedPhase.kind === "remove_files") {
          for (const item of plannedPhase.paths) {
            stopPoint(input.signal);
            await this.callDependency(identity, phase, () =>
              this.options.sandbox.removeFile(
                workspaceRelativePath(item.relativePath),
                signalControl(input.signal),
              ),
            );
          }
        } else if (plannedPhase.kind === "remove_directories") {
          for (const item of plannedPhase.paths) {
            stopPoint(input.signal);
            await this.callDependency(identity, phase, () =>
              this.options.sandbox.removeDirectory(
                workspaceRelativePath(item.relativePath),
                signalControl(input.signal),
              ),
            );
          }
        } else if (plannedPhase.kind === "ensure_directories") {
          for (const item of plannedPhase.paths) {
            stopPoint(input.signal);
            await this.callDependency(identity, phase, () =>
              this.options.sandbox.ensureDirectory(
                workspaceRelativePath(item.relativePath),
                signalControl(input.signal),
              ),
            );
          }
        } else {
          for (const file of plannedPhase.files) {
            stopPoint(input.signal);
            if (validExisting.has(file.relativePath)) continue;
            const receipt = receipts.get(file.relativePath);
            if (receipt === undefined) {
              throw new WorkspaceApplicationError("ACCESS_DENIED", "Workspace Blob 未获得授权");
            }
            const verified = verifyingStream({
              source: this.options.stableBlobs.read(receipt, signalControl(input.signal)),
              policy: this.policy,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
              expected: file.content,
            });
            await this.callDependency(identity, phase, () =>
              this.options.sandbox.writeFileAtomically({
                relativePath: workspaceRelativePath(file.relativePath),
                operationKey: childOperationKey(operationKey, file.relativePath),
                body: verified.body,
                ...(input.signal === undefined ? {} : { signal: input.signal }),
              }),
            );
            if (verified.status() === "pending") {
              throw new WorkspaceApplicationError(
                "DEPENDENCY_FAILED",
                "Sandbox 原子写端口未消费完整文件流",
              );
            }
            await verified.result;
          }
        }
      }

      const result = Object.freeze({
        kind: "materialized" as const,
        operationKey,
        targetManifestDigest: target.digest,
      });
      phase = "complete";
      await this.callDependency(identity, phase, () =>
        this.options.journal.complete(identity, result),
      );
      return result;
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

  private async authorizeAll(
    target: WorkspaceManifest,
    identity: WorkspaceOperationIdentity,
    signal: AbortSignal | undefined,
  ): Promise<Map<string, WorkspaceStableAuthorizationReceipt>> {
    const result = new Map<string, WorkspaceStableAuthorizationReceipt>();
    for (const entry of target.entries) {
      stopPoint(signal);
      const authorization = await this.callDependency(identity, "authorize_stable", () =>
        this.options.stableBlobs.authorize({
          tenantId: target.tenantId,
          purpose: "workspace_materialization",
          content: entry.content,
          object: entry.object,
        }),
      );
      if (authorization.status !== "authorized") {
        throw new WorkspaceApplicationError("ACCESS_DENIED", "Workspace Blob 不可用于当前 Tenant");
      }
      this.assertReceipt(entry, target.tenantId, authorization.receipt);
      const head = await this.callDependency(identity, "head_stable", () =>
        this.options.stableBlobs.head(authorization.receipt),
      );
      if (head.status !== "exists") {
        throw new WorkspaceApplicationError("INTEGRITY_MISMATCH", "Workspace Blob 不存在");
      }
      if (!sameContent(head.content, entry.content) || !sameObject(head.object, entry.object)) {
        throw new WorkspaceApplicationError("INTEGRITY_MISMATCH", "Workspace Blob HEAD 身份不匹配");
      }
      result.set(entry.path, authorization.receipt);
    }
    return result;
  }

  private assertReceipt(
    entry: WorkspaceFileEntry,
    tenantId: string,
    receipt: WorkspaceStableAuthorizationReceipt,
  ): void {
    if (
      receipt.tenantId !== tenantId ||
      receipt.purpose !== "workspace" ||
      !sameContent(receipt.content, entry.content) ||
      !sameObject(receipt.object, entry.object)
    ) {
      throw new WorkspaceApplicationError("ACCESS_DENIED", "Workspace Blob 授权回执身份不匹配");
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

function sameContent(
  left: { readonly sha256: string; readonly size: number },
  right: { readonly sha256: string; readonly size: number },
): boolean {
  return left.sha256 === right.sha256 && left.size === right.size;
}

function childOperationKey(operationKey: string, relativePath: string): string {
  return `workspace-write:${createHash("sha256")
    .update(`${operationKey}\0${relativePath}`)
    .digest("hex")}`;
}

function sameObject(
  left: WorkspaceFileEntry["object"],
  right: WorkspaceFileEntry["object"],
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.purpose === right.purpose &&
    left.incarnationId === right.incarnationId &&
    left.physicalObjectKey === right.physicalObjectKey
  );
}

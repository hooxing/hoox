import { createHash } from "node:crypto";
import {
  WorkspaceCoreApplicationError as WorkspaceApplicationError,
  WorkspaceDependencyError,
} from "./application-errors.js";
import type {
  SandboxSessionIdentity,
  SandboxWorkspacePort,
  WorkspaceExecutionPolicy,
  WorkspaceOperationIdentity,
  WorkspaceOperationJournalPort,
  WorkspaceStableAuthorizationReceipt,
  WorkspaceStableBlobReadPort,
  WorkspaceTrustedScope,
} from "./application-ports.js";
import {
  beginOperation,
  digestStream,
  exactKeys,
  isWorkspaceJournalError,
  mapDependencyFailure,
  parseContentIdentity,
  parseExternalStream,
  parseSandboxSession,
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
  parseWorkspaceManifest,
  type WorkspaceContentIdentity,
  type WorkspaceFileEntry,
  type WorkspaceManifest,
  type WorkspaceStableObjectIdentity,
} from "./manifest.js";
import { planWorkspaceMaterialization } from "./materialization-plan.js";
import { workspaceRelativePath } from "./path.js";

export const SANDBOX_WORKSPACE_ROOT = "/workspace" as const;
const OPERATION_DIGEST_VERSION = "workspace-operation-v2";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface WorkspaceMaterializerOptions {
  readonly journal: WorkspaceOperationJournalPort;
  readonly stableBlobs: WorkspaceStableBlobReadPort;
  readonly sandbox: SandboxWorkspacePort;
  readonly policy: WorkspaceExecutionPolicy;
  readonly now?: () => Date;
}

export interface MaterializeWorkspaceInput {
  readonly operationKey: string;
  readonly scope: WorkspaceTrustedScope;
  readonly target: WorkspaceManifest;
  /** 非空 manifest 必须绑定其已提交 Revision，供 stable 授权逐 path 续验。 */
  readonly targetRevisionId?: string;
  readonly previous?: WorkspaceManifest;
  readonly signal?: AbortSignal;
}

export interface MaterializedWorkspace {
  readonly kind: "materialized";
  readonly operationKey: string;
  readonly scope: WorkspaceTrustedScope;
  readonly sandbox: SandboxSessionIdentity;
  readonly targetManifestDigest: string;
}

export class WorkspaceMaterializer {
  private readonly policy: WorkspaceExecutionPolicy;
  private readonly now: () => Date;

  constructor(private readonly options: WorkspaceMaterializerOptions) {
    this.policy = validatePolicy(options.policy);
    this.now = options.now ?? (() => new Date());
  }

  async materialize(input: MaterializeWorkspaceInput): Promise<MaterializedWorkspace> {
    const operationKey = validateOperationKey(input.operationKey);
    const scope = validateTrustedScope(input.scope);
    const target = parseWorkspaceManifest(
      input.target,
      scope.tenantId,
      currentManifestPolicy(this.policy),
    );
    if (
      target.entries.length > 0 &&
      (input.targetRevisionId === undefined || !validRevisionId(input.targetRevisionId))
    ) {
      throw new WorkspaceApplicationError("INVALID_INPUT", "非空 Workspace 缺少 Revision 身份");
    }
    const previous =
      input.previous === undefined
        ? undefined
        : parseWorkspaceManifest(input.previous, scope.tenantId, this.policy.historicalManifest);
    const sandbox = await this.currentSandbox();
    try {
      const identity = materializeIdentity({
        operationKey,
        scope,
        sandbox,
        target,
        ...(previous === undefined ? {} : { previous }),
      });
      const begun = await beginOperation(this.options.journal, identity);
      if (begun.status === "completed") {
        return parseMaterializedResult(begun.result, identity, target, this.policy);
      }

      let phase = "preflight";
      try {
        stopPoint(input.signal);
        const plan = planWorkspaceMaterialization({
          root: SANDBOX_WORKSPACE_ROOT,
          target,
          ...(previous === undefined ? {} : { previous }),
        });
        const receipts = await this.authorizeAll(
          scope,
          target,
          input.targetRevisionId,
          identity,
          input.signal,
        );
        const validExisting = new Set<string>();
        const driftDirectories = new Set<string>();
        const driftNonDirectories = new Set<string>();
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
              const relativePath = workspaceRelativePath(candidate.relativePath);
              const inspected = parseInspectionResult(
                await this.callDependency(identity, phase, () =>
                  this.options.sandbox.inspectRegularFile(
                    sandbox,
                    relativePath,
                    signalControl(input.signal),
                  ),
                ),
              );
              if (inspected.status === "unsafe") {
                (inspected.kind === "directory" ? driftDirectories : driftNonDirectories).add(
                  relativePath,
                );
                continue;
              }
              if (inspected.status !== "regular") continue;
              try {
                await digestStream({
                  source: inspected.body,
                  policy: this.policy,
                  ...(input.signal === undefined ? {} : { signal: input.signal }),
                  expected: entry.content,
                });
                validExisting.add(entry.path);
              } catch (error) {
                if (
                  error instanceof WorkspaceApplicationError &&
                  (error.code === "INTEGRITY_MISMATCH" || error.code === "LIMIT_EXCEEDED")
                ) {
                  continue;
                }
                throw error;
              }
            }
          } else if (plannedPhase.kind === "remove_files") {
            for (const item of plannedPhase.paths) {
              stopPoint(input.signal);
              const relativePath = workspaceRelativePath(item.relativePath);
              const actual = parseInspectionResult(
                await this.callDependency(identity, phase, () =>
                  this.options.sandbox.inspectRegularFile(
                    sandbox,
                    relativePath,
                    signalControl(input.signal),
                  ),
                ),
              );
              stopPoint(input.signal);
              await this.callDependency(identity, phase, () =>
                actual.status === "unsafe" && actual.kind === "directory"
                  ? this.options.sandbox.removeUnexpectedDirectory(
                      sandbox,
                      relativePath,
                      signalControl(input.signal),
                    )
                  : this.options.sandbox.removeFile(
                      sandbox,
                      relativePath,
                      signalControl(input.signal),
                    ),
              );
            }
            for (const relativePath of [...driftNonDirectories].sort()) {
              stopPoint(input.signal);
              await this.callDependency(identity, phase, () =>
                this.options.sandbox.removeFile(sandbox, relativePath, signalControl(input.signal)),
              );
            }
            for (const relativePath of [...driftDirectories].sort()) {
              stopPoint(input.signal);
              await this.callDependency(identity, phase, () =>
                this.options.sandbox.removeUnexpectedDirectory(
                  sandbox,
                  relativePath,
                  signalControl(input.signal),
                ),
              );
            }
          } else if (plannedPhase.kind === "remove_directories") {
            for (const item of plannedPhase.paths) {
              stopPoint(input.signal);
              await this.callDependency(identity, phase, () =>
                this.options.sandbox.removeDirectory(
                  sandbox,
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
                  sandbox,
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
                source: parseExternalStream(
                  this.options.stableBlobs.read(receipt, signalControl(input.signal)),
                  "Workspace stable Blob 流",
                ),
                policy: this.policy,
                ...(input.signal === undefined ? {} : { signal: input.signal }),
                expected: file.content,
              });
              await this.callDependency(identity, phase, () =>
                this.options.sandbox.writeFileAtomically({
                  sandbox,
                  relativePath: workspaceRelativePath(file.relativePath),
                  operationKey: materializeChildKey(identity, file),
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

        stopPoint(input.signal);
        const result: MaterializedWorkspace = Object.freeze({
          kind: "materialized",
          operationKey,
          scope,
          sandbox,
          targetManifestDigest: target.digest,
        });
        phase = "complete";
        await this.callDependency(identity, phase, () =>
          this.options.journal.complete(identity, result),
        );
        return result;
      } catch (error) {
        const mapped =
          error instanceof WorkspaceApplicationError
            ? error
            : new WorkspaceApplicationError("DEPENDENCY_FAILED", "Workspace 物化失败");
        if (mapped.code !== "RESULT_UNKNOWN" && !isWorkspaceJournalError(mapped)) {
          await recordKnownFailure(this.options.journal, identity, phase, mapped);
        }
        throw mapped;
      }
    } finally {
      await this.options.sandbox.releaseSnapshots({ sandbox, operationKey });
    }
  }

  private async currentSandbox(): Promise<SandboxSessionIdentity> {
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

  private async authorizeAll(
    scope: WorkspaceTrustedScope,
    target: WorkspaceManifest,
    revisionId: string | undefined,
    identity: WorkspaceOperationIdentity,
    signal: AbortSignal | undefined,
  ): Promise<Map<string, WorkspaceStableAuthorizationReceipt>> {
    const result = new Map<string, WorkspaceStableAuthorizationReceipt>();
    for (const entry of target.entries) {
      if (revisionId === undefined) {
        throw new WorkspaceApplicationError("INVALID_INPUT", "Workspace Revision 身份缺失");
      }
      stopPoint(signal);
      const authorization = parseAuthorizationResult(
        await this.callDependency(identity, "authorize_stable", () =>
          this.options.stableBlobs.authorize({
            scope,
            purpose: "workspace_materialization",
            revisionId,
            relativePath: entry.path,
            content: entry.content,
            object: entry.object,
          }),
        ),
      );
      if (authorization.status !== "authorized") {
        throw new WorkspaceApplicationError("ACCESS_DENIED", "Workspace Blob 不可用于当前 Tenant");
      }
      assertReceipt(entry, scope, revisionId, authorization.receipt);
      const head = parseStableHeadResult(
        await this.callDependency(identity, "head_stable", () =>
          this.options.stableBlobs.head(authorization.receipt),
        ),
      );
      if (
        head.status !== "exists" ||
        !sameContent(head.content, entry.content) ||
        !sameObject(head.object, entry.object)
      ) {
        throw new WorkspaceApplicationError("INTEGRITY_MISMATCH", "Workspace Blob HEAD 身份不匹配");
      }
      result.set(entry.path, authorization.receipt);
    }
    return result;
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

function materializeIdentity(input: {
  readonly operationKey: string;
  readonly scope: WorkspaceTrustedScope;
  readonly sandbox: SandboxSessionIdentity;
  readonly target: WorkspaceManifest;
  readonly previous?: WorkspaceManifest;
}): WorkspaceOperationIdentity {
  const payload = [
    OPERATION_DIGEST_VERSION,
    "materialize",
    input.scope.tenantId,
    input.scope.threadId,
    input.scope.workspaceId,
    input.sandbox.sessionId,
    String(input.sandbox.generation),
    input.previous?.digest ?? "",
    input.target.digest,
  ].join("\0");
  return Object.freeze({
    schemaVersion: 1,
    digestAlgorithm: OPERATION_DIGEST_VERSION,
    operationKey: input.operationKey,
    kind: "materialize",
    inputDigest: createHash("sha256").update(payload).digest("hex"),
    ...input.scope,
    sandbox: input.sandbox,
  });
}

function parseMaterializedResult(
  value: unknown,
  identity: WorkspaceOperationIdentity,
  target: WorkspaceManifest,
  policy: WorkspaceExecutionPolicy,
): MaterializedWorkspace {
  const input = plainDataRecord(value, "MaterializedWorkspace");
  exactKeys(
    input,
    ["kind", "operationKey", "scope", "sandbox", "targetManifestDigest"],
    "MaterializedWorkspace",
  );
  const scope = validateTrustedScope(input.scope as WorkspaceTrustedScope);
  const sandbox = parseSandboxSession(input.sandbox);
  if (
    input.kind !== "materialized" ||
    input.operationKey !== identity.operationKey ||
    !sameScope(scope, identity) ||
    !sameSession(sandbox, identity.sandbox) ||
    typeof input.targetManifestDigest !== "string" ||
    !SHA256_PATTERN.test(input.targetManifestDigest) ||
    input.targetManifestDigest !== target.digest
  ) {
    throw new WorkspaceApplicationError("OPERATION_CONFLICT", "已完成物化结果与当前输入不一致");
  }
  // 当前配额已在调用本解析器之前重新解析 target；显式引用避免 completed 绕过策略语义。
  void policy;
  return Object.freeze({
    kind: "materialized",
    operationKey: identity.operationKey,
    scope,
    sandbox,
    targetManifestDigest: input.targetManifestDigest,
  });
}

function materializeChildKey(
  identity: WorkspaceOperationIdentity,
  file: {
    readonly relativePath: string;
    readonly content: WorkspaceFileEntry["content"];
    readonly object: WorkspaceFileEntry["object"];
  },
): string {
  const payload = [
    "workspace-materialize-child-v1",
    identity.inputDigest,
    file.relativePath,
    file.content.sha256,
    String(file.content.size),
    file.object.tenantId,
    file.object.purpose,
    file.object.incarnationId,
    file.object.physicalObjectKey,
  ].join("\0");
  return `workspace-write:${createHash("sha256").update(payload).digest("hex")}`;
}

function currentManifestPolicy(policy: WorkspaceExecutionPolicy) {
  return {
    maxFiles: policy.maxFiles,
    maxTotalBytes: policy.maxTotalBytes,
    maxSingleFileBytes: policy.maxSingleFileBytes,
    maxPathUtf8Bytes: policy.maxPathUtf8Bytes,
  };
}

function assertReceipt(
  entry: WorkspaceFileEntry,
  scope: WorkspaceTrustedScope,
  revisionId: string,
  receipt: WorkspaceStableAuthorizationReceipt,
): void {
  if (
    receipt.tenantId !== scope.tenantId ||
    receipt.threadId !== scope.threadId ||
    receipt.workspaceId !== scope.workspaceId ||
    receipt.revisionId !== revisionId ||
    receipt.relativePath !== entry.path ||
    receipt.purpose !== "workspace" ||
    !sameContent(receipt.content, entry.content) ||
    !sameObject(receipt.object, entry.object)
  ) {
    throw new WorkspaceApplicationError("ACCESS_DENIED", "Workspace Blob 授权回执身份不匹配");
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

function sameScope(left: WorkspaceTrustedScope, right: WorkspaceTrustedScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.threadId === right.threadId &&
    left.workspaceId === right.workspaceId
  );
}

function sameSession(left: SandboxSessionIdentity, right: SandboxSessionIdentity): boolean {
  return left.sessionId === right.sessionId && left.generation === right.generation;
}

type ParsedInspectionResult =
  | { readonly status: "missing" }
  | { readonly status: "regular"; readonly body: AsyncIterable<Uint8Array> }
  | { readonly status: "unsafe"; readonly kind: "directory" | "symlink" | "special" };

function parseInspectionResult(value: unknown): ParsedInspectionResult {
  const input = plainDataRecord(value, "Sandbox inspect 结果");
  if (input.status === "missing") {
    exactKeys(input, ["status"], "Sandbox inspect 结果");
    return Object.freeze({ status: "missing" });
  }
  if (input.status === "regular") {
    exactKeys(input, ["status", "body"], "Sandbox inspect 结果");
    return Object.freeze({
      status: "regular",
      body: parseExternalStream(input.body, "Sandbox 普通文件流"),
    });
  }
  if (input.status === "unsafe") {
    exactKeys(input, ["status", "kind"], "Sandbox inspect 结果");
    if (!(["directory", "symlink", "special"] as const).includes(input.kind as never)) {
      throw new WorkspaceApplicationError("DEPENDENCY_FAILED", "Sandbox inspect 类型无效");
    }
    return Object.freeze({
      status: "unsafe",
      kind: input.kind as "directory" | "symlink" | "special",
    });
  }
  throw new WorkspaceApplicationError("DEPENDENCY_FAILED", "Sandbox inspect 状态无效");
}

type ParsedAuthorizationResult =
  | { readonly status: "authorized"; readonly receipt: WorkspaceStableAuthorizationReceipt }
  | { readonly status: "denied" | "not_found" };

function parseAuthorizationResult(value: unknown): ParsedAuthorizationResult {
  const input = plainDataRecord(value, "Workspace Blob 授权结果");
  if (input.status === "denied" || input.status === "not_found") {
    exactKeys(input, ["status"], "Workspace Blob 授权结果");
    return Object.freeze({ status: input.status });
  }
  if (input.status !== "authorized") {
    throw new WorkspaceApplicationError("DEPENDENCY_FAILED", "Workspace Blob 授权状态无效");
  }
  exactKeys(input, ["status", "receipt"], "Workspace Blob 授权结果");
  const receipt = plainDataRecord(input.receipt, "Workspace Blob 授权回执");
  exactKeys(
    receipt,
    [
      "authorizationId",
      "tenantId",
      "threadId",
      "workspaceId",
      "revisionId",
      "relativePath",
      "purpose",
      "content",
      "object",
    ],
    "Workspace Blob 授权回执",
  );
  if (
    typeof receipt.authorizationId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(receipt.authorizationId) ||
    typeof receipt.tenantId !== "string" ||
    typeof receipt.threadId !== "string" ||
    typeof receipt.workspaceId !== "string" ||
    !validRevisionId(receipt.revisionId) ||
    typeof receipt.relativePath !== "string" ||
    receipt.purpose !== "workspace"
  ) {
    throw new WorkspaceApplicationError("DEPENDENCY_FAILED", "Workspace Blob 授权回执字段无效");
  }
  return Object.freeze({
    status: "authorized",
    receipt: Object.freeze({
      authorizationId: receipt.authorizationId,
      tenantId: receipt.tenantId,
      threadId: receipt.threadId,
      workspaceId: receipt.workspaceId,
      revisionId: receipt.revisionId,
      relativePath: workspaceRelativePath(receipt.relativePath),
      purpose: "workspace",
      content: parseContentIdentity(receipt.content),
      object: parseStableObjectIdentity(receipt.object),
    }),
  });
}

function validRevisionId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes("\0")
  );
}

type ParsedStableHeadResult =
  | { readonly status: "not_found" }
  | {
      readonly status: "exists";
      readonly content: WorkspaceContentIdentity;
      readonly object: WorkspaceStableObjectIdentity;
    };

function parseStableHeadResult(value: unknown): ParsedStableHeadResult {
  const input = plainDataRecord(value, "Workspace Blob HEAD 结果");
  if (input.status === "not_found") {
    exactKeys(input, ["status"], "Workspace Blob HEAD 结果");
    return Object.freeze({ status: "not_found" });
  }
  if (input.status !== "exists") {
    throw new WorkspaceApplicationError("DEPENDENCY_FAILED", "Workspace Blob HEAD 状态无效");
  }
  exactKeys(input, ["status", "content", "object"], "Workspace Blob HEAD 结果");
  return Object.freeze({
    status: "exists",
    content: parseContentIdentity(input.content),
    object: parseStableObjectIdentity(input.object),
  });
}

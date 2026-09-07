import type {
  ArtifactExecutionAuthorization,
  ArtifactExecutionAuthorizationVerifierPort,
} from "@hoox/artifact";
import {
  SimpleDeliveryCleanupResultUnknownError,
  SimpleDeliveryCommitResultUnknownError,
} from "@hoox/artifact";
import {
  measureExecutionPhase,
  type ExecutionPhaseTimingObserver,
  type ArtifactId,
  type ResourceVersionId,
  type Sha256Digest,
} from "@hoox/domain";
import { type DeliverFileToolArguments, DeliverFileToolArgumentsSchema } from "@hoox/pi-adapter";
import type { ExecutionScope, ExternalEffectCall, SandboxSessionRef } from "@hoox/run-contracts";
import { digestCanonical } from "@hoox/run-contracts/mutation-protocol";
import { workspaceRelativePath } from "@hoox/workspace";
import { Value } from "typebox/value";

export interface DeliverFileSessionBinding {
  readonly scope: ExecutionScope;
  readonly attemptId: string;
  readonly sandbox: SandboxSessionRef;
}

export interface DeliverFileEffectAuthorizer {
  authorizeToolEffect(call: ExternalEffectCall): Promise<ArtifactExecutionAuthorization>;
}

export type DeliverFileReadResult =
  | { readonly outcome: "found"; readonly relativePath: string; readonly body: Uint8Array }
  | { readonly outcome: "not_found" | "not_regular" | "unavailable" };

/** 该端口必须从绑定到当前 Run 的 CubeSandbox 读取文件，不能读取 Worker 宿主路径。 */
export interface DeliverFileSourcePort {
  read(input: {
    readonly binding: DeliverFileSessionBinding;
    readonly absolutePath: string;
    readonly signal?: AbortSignal;
  }): Promise<DeliverFileReadResult>;
}

export interface DeliveredFilePublication {
  readonly artifactId: ArtifactId;
  readonly resourceVersionId: ResourceVersionId;
  readonly name: string;
  readonly size: number;
  readonly sha256: Sha256Digest;
  readonly mediaType: string;
}

export interface DeliverFilePublicationPort {
  publish(input: {
    readonly authorization: ArtifactExecutionAuthorization;
    readonly idempotencyKey: string;
    readonly toolArgsDigest: Sha256Digest;
    readonly sourcePath: string;
    readonly name: string;
    readonly body: Uint8Array;
    readonly phaseTiming?: ExecutionPhaseTimingObserver;
  }): Promise<DeliveredFilePublication>;
}

export type DeliverFileSuccess = Readonly<{
  status: "published";
  artifact_id: ArtifactId;
  resource_version_id: ResourceVersionId;
  name: string;
  size: number;
  sha256: Sha256Digest;
  media_type: string;
  download_ready: true;
}>;

export type DeliverFileErrorCode =
  | "INVALID_ARGUMENT"
  | "FILE_NOT_FOUND"
  | "NOT_REGULAR_FILE"
  | "NOT_AUTHORIZED"
  | "PUBLICATION_FAILED"
  | "PUBLICATION_RESULT_UNKNOWN"
  | "CLEANUP_RESULT_UNKNOWN"
  | "SERVICE_UNAVAILABLE";

export class DeliverFileError extends Error {
  constructor(
    readonly code: DeliverFileErrorCode,
    message: string,
    readonly correctable: boolean,
    readonly fatal = false,
  ) {
    super(message);
    this.name = "DeliverFileError";
  }
}

export interface DeliverFileFailureProjection {
  readonly status: "failed";
  readonly code: DeliverFileErrorCode;
  readonly message: string;
  readonly correctable: boolean;
  /** true 时 Tool 层必须先持久化 failed tool_result，再拒绝本轮模型 continuation。 */
  readonly fatal: boolean;
}

export interface DeliverFileToolRouterPort {
  deliverFile(input: {
    readonly callId: string;
    readonly arguments: unknown;
    readonly signal?: AbortSignal;
  }): Promise<DeliverFileSuccess>;
  projectError(error: unknown): Readonly<DeliverFileFailureProjection>;
}

export interface DeliverFileToolRouterFactoryPort {
  create(input: {
    readonly binding: DeliverFileSessionBinding;
    readonly authorizer: DeliverFileEffectAuthorizer;
    readonly phaseTiming?: ExecutionPhaseTimingObserver;
  }): DeliverFileToolRouterPort;
}

export class DeliverFileToolRouterFactory implements DeliverFileToolRouterFactoryPort {
  constructor(
    private readonly dependencies: {
      readonly source: DeliverFileSourcePort;
      readonly publications: DeliverFilePublicationPort;
      readonly authorizationVerifier: ArtifactExecutionAuthorizationVerifierPort;
    },
  ) {}

  create(input: {
    readonly binding: DeliverFileSessionBinding;
    readonly authorizer: DeliverFileEffectAuthorizer;
    readonly phaseTiming?: ExecutionPhaseTimingObserver;
  }): DeliverFileToolRouterPort {
    return new DeliverFileToolRouter({ ...this.dependencies, ...input });
  }
}

class DeliverFileToolRouter implements DeliverFileToolRouterPort {
  readonly #consumedPermitIds = new Set<string>();

  constructor(
    private readonly options: {
      readonly binding: DeliverFileSessionBinding;
      readonly authorizer: DeliverFileEffectAuthorizer;
      readonly phaseTiming?: ExecutionPhaseTimingObserver;
      readonly source: DeliverFileSourcePort;
      readonly publications: DeliverFilePublicationPort;
      readonly authorizationVerifier: ArtifactExecutionAuthorizationVerifierPort;
    },
  ) {}

  async deliverFile(input: {
    readonly callId: string;
    readonly arguments: unknown;
    readonly signal?: AbortSignal;
  }): Promise<DeliverFileSuccess> {
    const args = decodeArguments(input.arguments);
    const argsDigest = digestCanonical(args);
    // durable tool_call 与一次性许可必须先形成；之后的路径/name 业务校验即使失败也能配对 tool_result。
    const authorization = await this.#authorize(input.callId, argsDigest, input.signal);
    const relativePath = absoluteWorkspacePath(args.path);
    const name = normalizeName(args.name ?? basename(relativePath));
    let source: DeliverFileReadResult;
    try {
      source = await measureExecutionPhase(
        this.options.phaseTiming,
        "file_read",
        () =>
          this.options.source.read({
            binding: this.options.binding,
            absolutePath: args.path,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          }),
        { toolCallId: input.callId, toolName: "deliver_file" },
      );
    } catch {
      throw unavailable();
    }
    if (source.outcome === "not_found") {
      throw new DeliverFileError("FILE_NOT_FOUND", `Sandbox 文件不存在：${args.path}`, true);
    }
    if (source.outcome === "not_regular") {
      throw new DeliverFileError(
        "NOT_REGULAR_FILE",
        `Sandbox 路径不是普通文件：${args.path}`,
        true,
      );
    }
    if (source.outcome !== "found" || source.relativePath !== relativePath) throw unavailable();
    if (input.signal?.aborted) throw notAuthorized();
    try {
      const published = await this.options.publications.publish({
        authorization,
        idempotencyKey: input.callId,
        toolArgsDigest: argsDigest,
        sourcePath: source.relativePath,
        name,
        body: source.body,
        ...(this.options.phaseTiming === undefined
          ? {}
          : { phaseTiming: this.options.phaseTiming }),
      });
      return Object.freeze({
        status: "published",
        artifact_id: published.artifactId,
        resource_version_id: published.resourceVersionId,
        name: published.name,
        size: published.size,
        sha256: published.sha256,
        media_type: published.mediaType,
        download_ready: true,
      });
    } catch (error) {
      if (error instanceof DeliverFileError) throw error;
      if (error instanceof SimpleDeliveryCommitResultUnknownError) {
        throw new DeliverFileError(
          "PUBLICATION_RESULT_UNKNOWN",
          "文件发布结果未知，需要恢复后确认",
          false,
          true,
        );
      }
      if (error instanceof SimpleDeliveryCleanupResultUnknownError) {
        throw new DeliverFileError(
          "CLEANUP_RESULT_UNKNOWN",
          "文件发布清理结果未知，需要恢复后确认",
          false,
          true,
        );
      }
      throw new DeliverFileError("PUBLICATION_FAILED", "文件未能保存为可下载交付物", true);
    }
  }

  projectError(error: unknown) {
    const safe = error instanceof DeliverFileError ? error : unavailable();
    return Object.freeze({
      status: "failed" as const,
      code: safe.code,
      message: safe.message,
      correctable: safe.correctable,
      fatal: safe.fatal,
    });
  }

  async #authorize(callId: string, argsDigest: Sha256Digest, signal?: AbortSignal) {
    if (!validCallId(callId) || signal?.aborted) throw notAuthorized();
    let authorization: ArtifactExecutionAuthorization;
    try {
      authorization = await this.options.authorizer.authorizeToolEffect({
        callId,
        toolName: "deliver_file",
        argsDigest,
      });
      this.options.authorizationVerifier.assert(authorization, {
        toolName: "deliver_file",
        argsDigest,
        attemptId: this.options.binding.attemptId,
        scope: this.options.binding.scope,
      });
    } catch {
      throw notAuthorized();
    }
    if (
      authorization.callId !== callId ||
      this.#consumedPermitIds.has(authorization.permitId) ||
      signal?.aborted
    ) {
      throw notAuthorized();
    }
    this.#consumedPermitIds.add(authorization.permitId);
    return authorization;
  }
}

function decodeArguments(value: unknown): DeliverFileToolArguments {
  if (!Value.Check(DeliverFileToolArgumentsSchema, value)) throw invalidArgument();
  return Object.freeze({ ...(value as DeliverFileToolArguments) });
}

function absoluteWorkspacePath(value: string): string {
  if (!value.startsWith("/workspace/") || value.includes("\\") || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw invalidArgument();
  }
  try {
    return workspaceRelativePath(value.slice("/workspace/".length));
  } catch {
    throw invalidArgument();
  }
}

function basename(relativePath: string): string {
  const name = relativePath.split("/").at(-1);
  if (name === undefined) throw invalidArgument();
  return name;
}

function normalizeName(value: string): string {
  if (
    value.trim() !== value ||
    value.normalize("NFC") !== value ||
    /[\p{Cc}\p{Cf}]/u.test(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    Buffer.byteLength(value, "utf8") > 255
  ) {
    throw invalidArgument();
  }
  return value;
}

function validCallId(value: string): boolean {
  return value.length >= 1 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9_./:-]*$/u.test(value);
}

function invalidArgument(): DeliverFileError {
  return new DeliverFileError("INVALID_ARGUMENT", "path 必须是 /workspace 下的文件绝对路径", true);
}

function notAuthorized(): DeliverFileError {
  return new DeliverFileError("NOT_AUTHORIZED", "当前工具调用没有有效授权", false);
}

function unavailable(): DeliverFileError {
  return new DeliverFileError("SERVICE_UNAVAILABLE", "文件交付服务暂时不可用", false);
}

import type {
  ArtifactExecutionAuthorization,
  ArtifactExecutionAuthorizationVerifierPort,
} from "@cube-runtime/artifact";
import type { ArtifactId, ResourceVersionId, Sha256Digest } from "@cube-runtime/domain";
import {
  type DeliverFileToolArguments,
  DeliverFileToolArgumentsSchema,
} from "@cube-runtime/pi-adapter";
import type {
  ExecutionScope,
  ExternalEffectCall,
  SandboxSessionRef,
} from "@cube-runtime/run-contracts";
import { digestCanonical } from "@cube-runtime/run-contracts/mutation-protocol";
import { workspaceRelativePath } from "@cube-runtime/workspace";
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
  | "SERVICE_UNAVAILABLE";

export class DeliverFileError extends Error {
  constructor(
    readonly code: DeliverFileErrorCode,
    message: string,
    readonly correctable: boolean,
  ) {
    super(message);
    this.name = "DeliverFileError";
  }
}

export interface DeliverFileToolRouterPort {
  deliverFile(input: {
    readonly callId: string;
    readonly arguments: unknown;
    readonly signal?: AbortSignal;
  }): Promise<DeliverFileSuccess>;
  projectError(error: unknown): Readonly<{
    status: "failed";
    code: DeliverFileErrorCode;
    message: string;
    correctable: boolean;
  }>;
}

export interface DeliverFileToolRouterFactoryPort {
  create(input: {
    readonly binding: DeliverFileSessionBinding;
    readonly authorizer: DeliverFileEffectAuthorizer;
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
    const relativePath = absoluteWorkspacePath(args.path);
    const name = normalizeName(args.name ?? basename(relativePath));
    const argsDigest = digestCanonical(args);
    const authorization = await this.#authorize(input.callId, argsDigest, input.signal);
    let source: DeliverFileReadResult;
    try {
      source = await this.options.source.read({
        binding: this.options.binding,
        absolutePath: args.path,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
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
    value.includes("\\")
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

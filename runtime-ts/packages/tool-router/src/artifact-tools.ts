import {
  ArtifactDeliveryError,
  ArtifactExecutionAuthorization,
  type ArtifactPublicationSnapshot,
  type DeliverableDeclaration,
  type MonotonicClockPort,
  type PublishArtifactCommand,
  systemMonotonicClock,
} from "@cube-runtime/artifact";
import {
  artifactId,
  type ArtifactId,
  resourceVersionId,
  type ResourceVersionId,
} from "@cube-runtime/domain";
import type {
  ConsumedExternalEffectAuthorization,
  ExecutionScope,
  ExternalEffectCall,
  TrustedToolExecutionContext,
} from "@cube-runtime/run-contracts";
import { digestCanonical } from "@cube-runtime/run-contracts/mutation-protocol";
import { workspaceRelativePath } from "@cube-runtime/workspace";
import { Value } from "typebox/value";
import {
  DeclareDeliverablesToolArgumentsSchema,
  type PublishArtifactToolArguments,
  PublishArtifactToolArgumentsSchema,
} from "@cube-runtime/pi-adapter";
import type { Static, TSchema } from "typebox";

export const ARTIFACT_TOOL_NAMES = ["declare_deliverables", "publish_artifact"] as const;
export type ArtifactToolName = (typeof ARTIFACT_TOOL_NAMES)[number];

export type TrustedArtifactExecutionContext = TrustedToolExecutionContext;

export interface ArtifactToolEffectAuthorizer {
  authorizeToolEffect(call: ExternalEffectCall): Promise<ConsumedExternalEffectAuthorization>;
}

export type ArtifactPublicationSource =
  | {
      readonly kind: "workspace_file";
      readonly relativePath: string;
      readonly resourceName: string;
    }
  | { readonly kind: "resource_version"; readonly resourceVersionId: ResourceVersionId };

/**
 * 此端口只返回固定 ResourceVersion ID；真实实现必须在可信 scope 和 Writer Lease 下完成提升或解析。
 * 它不得把对象键、签名 URL 或存储响应带回 Tool Router。
 */
export interface ArtifactPublicationResourcePort {
  prepareImmutableVersion(input: {
    readonly authorization: ArtifactExecutionAuthorization;
    readonly source: ArtifactPublicationSource;
  }): Promise<
    | { readonly outcome: "ready"; readonly resourceVersionId: ResourceVersionId }
    | { readonly outcome: "not_found" | "not_authorized" | "unavailable" }
  >;
}

export interface ArtifactToolServicePort {
  declareDeliverables(input: {
    readonly authorization: ArtifactExecutionAuthorization;
    readonly idempotencyKey: string;
    readonly declarations: readonly DeliverableDeclaration[];
  }): Promise<void>;
  publishArtifact(command: PublishArtifactCommand): Promise<ArtifactPublicationSnapshot>;
}

export type ArtifactToolSuccess =
  | {
      readonly ok: true;
      readonly code: "DELIVERABLES_DECLARED";
      readonly requiredCount: number;
      readonly optionalCount: number;
    }
  | {
      readonly ok: true;
      readonly code: "ARTIFACT_PUBLISHED";
      readonly artifactId: ArtifactId;
      readonly resourceVersionId: ResourceVersionId;
      readonly name: string;
      readonly purpose: "deliverable" | "diagnostic" | "trace";
      readonly deliverableKey?: string;
    };

export type ArtifactToolErrorCode =
  | "ARTIFACT_TOOL_INVALID_ARGUMENT"
  | "ARTIFACT_TOOL_NOT_AUTHORIZED"
  | "ARTIFACT_SOURCE_NOT_FOUND"
  | "ARTIFACT_PUBLICATION_FAILED"
  | "ARTIFACT_NOT_READY"
  | "ARTIFACT_TOOL_UNAVAILABLE";

export class ArtifactToolError extends Error {
  constructor(
    readonly code: ArtifactToolErrorCode,
    message: string,
    readonly correctable: boolean,
  ) {
    super(message);
    this.name = "ArtifactToolError";
  }
}

export interface ArtifactToolErrorProjection {
  readonly ok: false;
  readonly code: ArtifactToolErrorCode;
  readonly message: string;
  readonly correctable: boolean;
}

export interface ArtifactToolRouterOptions {
  readonly context: TrustedArtifactExecutionContext;
  readonly authorizer: ArtifactToolEffectAuthorizer;
  readonly resources: ArtifactPublicationResourcePort;
  readonly artifacts: ArtifactToolServicePort;
  readonly monotonicClock?: MonotonicClockPort;
}

export interface ArtifactToolRouterPort {
  declareDeliverables(input: {
    readonly callId: string;
    readonly arguments: unknown;
    readonly signal?: AbortSignal;
  }): Promise<ArtifactToolSuccess>;
  publishArtifact(input: {
    readonly callId: string;
    readonly arguments: unknown;
    readonly signal?: AbortSignal;
  }): Promise<ArtifactToolSuccess>;
  projectError(error: unknown): ArtifactToolErrorProjection;
}

export interface ArtifactToolRouterFactoryPort {
  create(input: {
    readonly context: TrustedArtifactExecutionContext;
    readonly authorizer: ArtifactToolEffectAuthorizer;
  }): ArtifactToolRouterPort;
}

/** 生产装配必须显式提供 ArtifactService 与真实 ResourceVersion 准备端口，不存在内置回退。 */
export class ArtifactToolRouterFactory implements ArtifactToolRouterFactoryPort {
  constructor(
    private readonly dependencies: {
      readonly resources: ArtifactPublicationResourcePort;
      readonly artifacts: ArtifactToolServicePort;
      readonly monotonicClock?: MonotonicClockPort;
    },
  ) {
    if (!dependencies?.resources || !dependencies.artifacts) {
      throw new ArtifactToolError(
        "ARTIFACT_TOOL_UNAVAILABLE",
        "Artifact 工具尚未完成生产装配",
        false,
      );
    }
  }

  create(input: {
    readonly context: TrustedArtifactExecutionContext;
    readonly authorizer: ArtifactToolEffectAuthorizer;
  }): ArtifactToolRouterPort {
    return new ArtifactToolRouter({
      ...this.dependencies,
      context: input.context,
      authorizer: input.authorizer,
    });
  }
}

/** 每个 Pi Session 创建独立 Router；permitId 的进程内一次性集合不会跨 Run 混用。 */
export class ArtifactToolRouter {
  readonly #context: TrustedArtifactExecutionContext;
  readonly #authorizer: ArtifactToolEffectAuthorizer;
  readonly #resources: ArtifactPublicationResourcePort;
  readonly #artifacts: ArtifactToolServicePort;
  readonly #clock: MonotonicClockPort;
  readonly #consumedPermitIds = new Set<string>();

  constructor(options: ArtifactToolRouterOptions) {
    if (
      !options?.context ||
      !options.authorizer ||
      !options.resources ||
      !options.artifacts ||
      typeof options.authorizer.authorizeToolEffect !== "function" ||
      typeof options.resources.prepareImmutableVersion !== "function" ||
      typeof options.artifacts.declareDeliverables !== "function" ||
      typeof options.artifacts.publishArtifact !== "function"
    ) {
      throw new ArtifactToolError(
        "ARTIFACT_TOOL_UNAVAILABLE",
        "Artifact 工具尚未完成生产装配",
        false,
      );
    }
    this.#context = freezeTrustedContext(options.context);
    this.#authorizer = options.authorizer;
    this.#resources = options.resources;
    this.#artifacts = options.artifacts;
    this.#clock = options.monotonicClock ?? systemMonotonicClock;
  }

  async declareDeliverables(input: {
    readonly callId: string;
    readonly arguments: unknown;
    readonly signal?: AbortSignal;
  }): Promise<ArtifactToolSuccess> {
    const args = decodeArguments(DeclareDeliverablesToolArgumentsSchema, input.arguments);
    validateDeclarations(args.declarations);
    const authorization = await this.#authorize(
      input.callId,
      "declare_deliverables",
      args,
      input.signal,
    );
    try {
      await this.#artifacts.declareDeliverables({
        authorization,
        idempotencyKey: args.idempotencyKey,
        declarations: args.declarations,
      });
      return Object.freeze({
        ok: true,
        code: "DELIVERABLES_DECLARED",
        requiredCount: args.declarations.filter((item) => item.requirement === "required").length,
        optionalCount: args.declarations.filter((item) => item.requirement === "optional").length,
      });
    } catch (error) {
      throw mapArtifactError(error);
    }
  }

  async publishArtifact(input: {
    readonly callId: string;
    readonly arguments: unknown;
    readonly signal?: AbortSignal;
  }): Promise<ArtifactToolSuccess> {
    const args = decodeArguments(PublishArtifactToolArgumentsSchema, input.arguments);
    validatePublishArguments(args);
    const source = normalizeSource(args.source);
    const argsDigest = digestCanonical(args);
    const authorization = await this.#authorize(
      input.callId,
      "publish_artifact",
      args,
      input.signal,
    );
    let prepared: Awaited<ReturnType<ArtifactPublicationResourcePort["prepareImmutableVersion"]>>;
    try {
      // DB permit 已消费且同步重验后，下一条异步语句才进入实际 ResourceVersion 准备端口。
      prepared = await this.#resources.prepareImmutableVersion({ authorization, source });
    } catch {
      throw unavailable();
    }
    if (prepared.outcome === "not_found") {
      throw new ArtifactToolError("ARTIFACT_SOURCE_NOT_FOUND", "发布来源不存在", true);
    }
    if (prepared.outcome === "not_authorized") throw notAuthorized();
    if (prepared.outcome !== "ready") throw unavailable();
    if (input.signal?.aborted) throw notAuthorized();

    try {
      const published = await this.#artifacts.publishArtifact({
        authorization,
        toolArgsDigest: argsDigest,
        idempotencyKey: args.idempotencyKey,
        artifactId: artifactId(args.artifactId),
        resourceVersionId: prepared.resourceVersionId,
        ...(args.replacesArtifactId === undefined
          ? {}
          : { replacesArtifactId: artifactId(args.replacesArtifactId) }),
        name: args.name,
        purpose: args.purpose,
        ...(args.deliverableKey === undefined ? {} : { deliverableKey: args.deliverableKey }),
      });
      return Object.freeze({
        ok: true,
        code: "ARTIFACT_PUBLISHED",
        artifactId: published.artifactId,
        resourceVersionId: published.resourceVersionId,
        name: published.name,
        purpose: published.purpose,
        ...(published.deliverableKey === undefined
          ? {}
          : { deliverableKey: published.deliverableKey }),
      });
    } catch (error) {
      throw mapArtifactError(error);
    }
  }

  projectError(error: unknown): ArtifactToolErrorProjection {
    return artifactToolErrorProjection(error);
  }

  async #authorize(
    callId: string,
    toolName: ArtifactToolName,
    args: unknown,
    signal: AbortSignal | undefined,
  ): Promise<ArtifactExecutionAuthorization> {
    if (!validOpaqueId(callId) || signal?.aborted) throw notAuthorized();
    const argsDigest = digestCanonical(args);
    let consumed: ConsumedExternalEffectAuthorization;
    try {
      consumed = await this.#authorizer.authorizeToolEffect({
        callId,
        toolName,
        argsDigest,
      });
    } catch {
      throw notAuthorized();
    }
    if (
      !matchesTrustedContext(consumed, this.#context) ||
      consumed.permit.callId !== callId ||
      consumed.permit.toolName !== toolName ||
      consumed.permit.argsDigest !== argsDigest ||
      signal?.aborted
    ) {
      throw notAuthorized();
    }
    if (this.#consumedPermitIds.has(consumed.permit.permitId)) throw notAuthorized();
    this.#consumedPermitIds.add(consumed.permit.permitId);
    try {
      return ArtifactExecutionAuthorization.fromConsumed(consumed, this.#clock);
    } catch {
      throw notAuthorized();
    }
  }
}

export function artifactToolErrorProjection(error: unknown): ArtifactToolErrorProjection {
  const safe = error instanceof ArtifactToolError ? error : unavailable();
  return Object.freeze({
    ok: false,
    code: safe.code,
    message: safe.message,
    correctable: safe.correctable,
  });
}

function decodeArguments<T extends TSchema>(schema: T, value: unknown): Static<T> {
  try {
    assertPlainJson(value, new Set(), 0);
    if (!Value.Check(schema, value)) throw invalidArguments();
    return Object.freeze(structuredClone(value)) as Static<T>;
  } catch (error) {
    if (error instanceof ArtifactToolError) throw error;
    throw invalidArguments();
  }
}

function assertPlainJson(value: unknown, seen: Set<object>, depth: number): void {
  if (depth > 12) throw invalidArguments();
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidArguments();
    return;
  }
  if (typeof value !== "object" || seen.has(value)) throw invalidArguments();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    throw invalidArguments();
  }
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) throw invalidArguments();
    assertPlainJson(descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
}

function normalizeSource(
  source: PublishArtifactToolArguments["source"],
): ArtifactPublicationSource {
  if (source.kind === "resource_version") {
    return Object.freeze({
      kind: "resource_version",
      resourceVersionId: resourceVersionId(source.resourceVersionId),
    });
  }
  let path: string;
  try {
    path = workspaceRelativePath(source.relativePath);
  } catch {
    throw invalidArguments();
  }
  if (new TextEncoder().encode(path).byteLength > 1024) throw invalidArguments();
  return Object.freeze({
    kind: "workspace_file",
    relativePath: path,
    resourceName: source.resourceName,
  });
}

function validateDeclarations(declarations: readonly DeliverableDeclaration[]): void {
  const keys = new Set<string>();
  for (const declaration of declarations) {
    validateVisibleName(declaration.name);
    if (keys.has(declaration.key)) throw invalidArguments();
    keys.add(declaration.key);
  }
}

function validatePublishArguments(args: PublishArtifactToolArguments): void {
  validateVisibleName(args.name);
  if (args.source.kind === "workspace_file") validateVisibleName(args.source.resourceName);
  if (
    (args.purpose === "deliverable" && args.deliverableKey === undefined) ||
    (args.purpose !== "deliverable" && args.deliverableKey !== undefined)
  ) {
    throw invalidArguments();
  }
}

function validateVisibleName(value: string): void {
  if (
    value.trim() !== value ||
    value.normalize("NFC") !== value ||
    /[\p{Cc}\p{Cf}]/u.test(value) ||
    hasUnpairedSurrogate(value)
  ) {
    throw invalidArguments();
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function matchesTrustedContext(
  consumed: ConsumedExternalEffectAuthorization,
  trusted: TrustedArtifactExecutionContext,
): boolean {
  const permit = consumed.permit;
  return (
    permit.effect === "tool_execution" &&
    sameScope(permit.scope, trusted.scope) &&
    permit.runClaimToken === trusted.runClaimToken &&
    permit.runClaimEpoch === trusted.runClaimEpoch &&
    permit.workspaceRootRunId === trusted.workspaceRootRunId &&
    permit.workspaceLeaseEpoch === trusted.workspaceLeaseEpoch
  );
}

function freezeTrustedContext(
  context: TrustedArtifactExecutionContext,
): TrustedArtifactExecutionContext {
  if (
    !validOpaqueId(context.runClaimToken) ||
    !Number.isSafeInteger(context.runClaimEpoch) ||
    context.runClaimEpoch < 0 ||
    !Number.isSafeInteger(context.workspaceLeaseEpoch) ||
    context.workspaceLeaseEpoch < 0 ||
    context.workspaceRootRunId !== context.scope.rootRunId
  ) {
    throw notAuthorized();
  }
  return Object.freeze({ ...context, scope: Object.freeze({ ...context.scope }) });
}

function sameScope(left: ExecutionScope, right: ExecutionScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.threadId === right.threadId &&
    left.runId === right.runId &&
    left.rootRunId === right.rootRunId &&
    left.workspaceId === right.workspaceId &&
    left.baseRevisionId === right.baseRevisionId
  );
}

function validOpaqueId(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function mapArtifactError(error: unknown): ArtifactToolError {
  if (!(error instanceof ArtifactDeliveryError)) return unavailable();
  switch (error.code) {
    case "ARTIFACT_INVALID_ARGUMENT":
      return invalidArguments();
    case "ARTIFACT_NOT_AUTHORIZED":
    case "ARTIFACT_NOT_FOUND":
      return notAuthorized();
    case "ARTIFACT_IDEMPOTENCY_CONFLICT":
      return new ArtifactToolError(
        "ARTIFACT_PUBLICATION_FAILED",
        "Artifact 幂等键或替换链冲突，请使用新的 Artifact 与版本修正",
        true,
      );
    case "ARTIFACT_PUBLICATION_FAILED":
      return new ArtifactToolError(
        "ARTIFACT_PUBLICATION_FAILED",
        "Artifact 发布失败，请修正文件后创建新版本和新 Artifact",
        true,
      );
    case "ARTIFACT_NOT_READY":
      return new ArtifactToolError(
        "ARTIFACT_NOT_READY",
        "必需交付物尚未全部发布，请补齐或修正后再完成",
        true,
      );
    default:
      return unavailable();
  }
}

function invalidArguments(): ArtifactToolError {
  return new ArtifactToolError("ARTIFACT_TOOL_INVALID_ARGUMENT", "Artifact 工具参数无效", true);
}

function notAuthorized(): ArtifactToolError {
  return new ArtifactToolError(
    "ARTIFACT_TOOL_NOT_AUTHORIZED",
    "Artifact 工具授权无效或已过期",
    false,
  );
}

function unavailable(): ArtifactToolError {
  return new ArtifactToolError("ARTIFACT_TOOL_UNAVAILABLE", "Artifact 工具暂时不可用", true);
}

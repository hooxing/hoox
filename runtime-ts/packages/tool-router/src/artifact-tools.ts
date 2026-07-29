import {
  ArtifactDeliveryError,
  type AcceptWorkspaceArtifactIntentCommand,
  type ArtifactExecutionAuthorization,
  type ArtifactExecutionAuthorizationVerifierPort,
  type ArtifactPublicationSnapshot,
  type DeliverableDeclaration,
  type PublishArtifactCommand,
} from "@cube-runtime/artifact";
import {
  type ArtifactId,
  artifactId,
  type ResourceVersionId,
  resourceVersionId,
} from "@cube-runtime/domain";
import {
  DeclareDeliverablesToolArgumentsSchema,
  type PublishArtifactToolArguments,
  PublishArtifactToolArgumentsSchema,
} from "@cube-runtime/pi-adapter";
import type { ExecutionScope, ExternalEffectCall } from "@cube-runtime/run-contracts";
import { digestCanonical } from "@cube-runtime/run-contracts/mutation-protocol";
import { workspaceRelativePath } from "@cube-runtime/workspace";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export const ARTIFACT_TOOL_NAMES = ["declare_deliverables", "publish_artifact"] as const;
export type ArtifactToolName = (typeof ARTIFACT_TOOL_NAMES)[number];

export interface TrustedArtifactSessionBinding {
  readonly scope: ExecutionScope;
  readonly attemptId: string;
}

export interface ArtifactToolEffectAuthorizer {
  authorizeToolEffect(call: ExternalEffectCall): Promise<ArtifactExecutionAuthorization>;
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
  acceptWorkspaceArtifactIntent(command: AcceptWorkspaceArtifactIntentCommand): Promise<{
    readonly artifactId: ArtifactId;
    readonly resourceVersionId: ResourceVersionId;
    readonly sourceRelativePath: string;
    readonly status: "accepted" | "settled";
  }>;
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
    }
  | {
      readonly ok: true;
      readonly code: "ARTIFACT_ACCEPTED";
      readonly artifactId: ArtifactId;
      readonly sourceRelativePath: string;
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
  readonly binding: TrustedArtifactSessionBinding;
  readonly authorizer: ArtifactToolEffectAuthorizer;
  readonly authorizationVerifier: ArtifactExecutionAuthorizationVerifierPort;
  readonly resources: ArtifactPublicationResourcePort;
  readonly artifacts: ArtifactToolServicePort;
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
    readonly binding: TrustedArtifactSessionBinding;
    readonly authorizer: ArtifactToolEffectAuthorizer;
  }): ArtifactToolRouterPort;
}

/** 生产装配必须显式提供 ArtifactService 与真实 ResourceVersion 准备端口，不存在内置回退。 */
export class ArtifactToolRouterFactory implements ArtifactToolRouterFactoryPort {
  constructor(
    private readonly dependencies: {
      readonly resources: ArtifactPublicationResourcePort;
      readonly artifacts: ArtifactToolServicePort;
      readonly authorizationVerifier: ArtifactExecutionAuthorizationVerifierPort;
    },
  ) {
    if (
      !dependencies?.resources ||
      !dependencies.artifacts ||
      !dependencies.authorizationVerifier
    ) {
      throw new ArtifactToolError(
        "ARTIFACT_TOOL_UNAVAILABLE",
        "Artifact 工具尚未完成生产装配",
        false,
      );
    }
  }

  create(input: {
    readonly binding: TrustedArtifactSessionBinding;
    readonly authorizer: ArtifactToolEffectAuthorizer;
  }): ArtifactToolRouterPort {
    return new ArtifactToolRouter({
      ...this.dependencies,
      binding: input.binding,
      authorizer: input.authorizer,
    });
  }
}

/** 每个 Pi Session 创建独立 Router；permitId 的进程内一次性集合不会跨 Run 混用。 */
export class ArtifactToolRouter {
  readonly #binding: TrustedArtifactSessionBinding;
  readonly #authorizer: ArtifactToolEffectAuthorizer;
  readonly #authorizationVerifier: ArtifactExecutionAuthorizationVerifierPort;
  readonly #resources: ArtifactPublicationResourcePort;
  readonly #artifacts: ArtifactToolServicePort;
  readonly #consumedPermitIds = new Set<string>();

  constructor(options: ArtifactToolRouterOptions) {
    if (
      !options?.binding ||
      !options.authorizer ||
      !options.authorizationVerifier ||
      !options.resources ||
      !options.artifacts ||
      typeof options.authorizer.authorizeToolEffect !== "function" ||
      typeof options.resources.prepareImmutableVersion !== "function" ||
      typeof options.artifacts.declareDeliverables !== "function" ||
      typeof options.artifacts.publishArtifact !== "function" ||
      typeof options.artifacts.acceptWorkspaceArtifactIntent !== "function"
    ) {
      throw new ArtifactToolError(
        "ARTIFACT_TOOL_UNAVAILABLE",
        "Artifact 工具尚未完成生产装配",
        false,
      );
    }
    this.#binding = freezeTrustedBinding(options.binding);
    this.#authorizer = options.authorizer;
    this.#authorizationVerifier = options.authorizationVerifier;
    this.#resources = options.resources;
    this.#artifacts = options.artifacts;
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
    if (source.kind === "workspace_file") {
      if (input.signal?.aborted) throw notAuthorized();
      try {
        const accepted = await this.#artifacts.acceptWorkspaceArtifactIntent({
          authorization,
          toolArgsDigest: argsDigest,
          idempotencyKey: args.idempotencyKey,
          requestedArtifactId: artifactId(args.artifactId),
          ...(args.replacesArtifactId === undefined
            ? {}
            : { replacesArtifactId: artifactId(args.replacesArtifactId) }),
          name: args.name,
          purpose: args.purpose,
          ...(args.deliverableKey === undefined ? {} : { deliverableKey: args.deliverableKey }),
          sourceRelativePath: source.relativePath,
          resourceName: source.resourceName,
        });
        return Object.freeze({
          ok: true,
          code: "ARTIFACT_ACCEPTED",
          artifactId: accepted.artifactId,
          sourceRelativePath: accepted.sourceRelativePath,
        });
      } catch (error) {
        throw mapArtifactError(error);
      }
    }
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
    let authorization: ArtifactExecutionAuthorization;
    try {
      authorization = await this.#authorizer.authorizeToolEffect({
        callId,
        toolName,
        argsDigest,
      });
    } catch {
      throw notAuthorized();
    }
    if (
      authorization.callId !== callId ||
      authorization.toolName !== toolName ||
      authorization.argsDigest !== argsDigest ||
      signal?.aborted
    ) {
      throw notAuthorized();
    }
    if (this.#consumedPermitIds.has(authorization.permitId)) throw notAuthorized();
    try {
      this.#authorizationVerifier.assert(authorization, {
        toolName,
        argsDigest,
        attemptId: this.#binding.attemptId,
        scope: this.#binding.scope,
      });
      this.#consumedPermitIds.add(authorization.permitId);
      return authorization;
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
    const budget: JsonScanBudget = { nodes: 0, objectKeys: 0, utf8Bytes: 0 };
    assertPlainJson(value, new Set(), 0, budget);
    const encoded = JSON.stringify(value);
    if (
      typeof encoded !== "string" ||
      new TextEncoder().encode(encoded).byteLength > MAX_ARGUMENT_UTF8_BYTES
    ) {
      throw invalidArguments();
    }
    if (!Value.Check(schema, value)) throw invalidArguments();
    return Object.freeze(structuredClone(value)) as Static<T>;
  } catch (error) {
    if (error instanceof ArtifactToolError) throw error;
    throw invalidArguments();
  }
}

interface JsonScanBudget {
  nodes: number;
  objectKeys: number;
  utf8Bytes: number;
}

const MAX_ARGUMENT_NODES = 2_048;
const MAX_ARGUMENT_OBJECT_KEYS = 1_024;
const MAX_ARGUMENT_ARRAY_LENGTH = 256;
const MAX_ARGUMENT_UTF8_BYTES = 64 * 1_024;

function assertPlainJson(
  value: unknown,
  seen: Set<object>,
  depth: number,
  budget: JsonScanBudget,
): void {
  if (depth > 12) throw invalidArguments();
  budget.nodes += 1;
  if (budget.nodes > MAX_ARGUMENT_NODES) throw invalidArguments();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    budget.utf8Bytes += new TextEncoder().encode(value).byteLength;
    if (budget.utf8Bytes > MAX_ARGUMENT_UTF8_BYTES) throw invalidArguments();
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidArguments();
    budget.utf8Bytes += String(value).length;
    return;
  }
  if (typeof value !== "object" || seen.has(value)) throw invalidArguments();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    throw invalidArguments();
  }
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARGUMENT_ARRAY_LENGTH) throw invalidArguments();
    budget.objectKeys += value.length;
    if (budget.objectKeys > MAX_ARGUMENT_OBJECT_KEYS) throw invalidArguments();
    if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
      throw invalidArguments();
    }
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index);
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || descriptor.get || descriptor.set) throw invalidArguments();
      assertPlainJson(descriptor.value, seen, depth + 1, budget);
    }
  } else {
    for (const key of ownKeys) {
      if (typeof key === "symbol") throw invalidArguments();
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || descriptor.get || descriptor.set) throw invalidArguments();
      budget.objectKeys += 1;
      budget.utf8Bytes += new TextEncoder().encode(key).byteLength;
      if (
        budget.objectKeys > MAX_ARGUMENT_OBJECT_KEYS ||
        budget.utf8Bytes > MAX_ARGUMENT_UTF8_BYTES
      ) {
        throw invalidArguments();
      }
      assertPlainJson(descriptor.value, seen, depth + 1, budget);
    }
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

function freezeTrustedBinding(
  binding: TrustedArtifactSessionBinding,
): TrustedArtifactSessionBinding {
  if (!validOpaqueId(binding.attemptId)) throw notAuthorized();
  return Object.freeze({
    attemptId: binding.attemptId,
    scope: Object.freeze({ ...binding.scope }),
  });
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

import type { ArtifactId, ResourceVersionId, RunId, Sha256Digest } from "@cube-runtime/domain";
import type { BlobStore, StableBlobRef } from "@cube-runtime/persistence";
import type { ArtifactPublicationPort, ExecutionScope } from "@cube-runtime/run-contracts";
import { digestCanonical } from "@cube-runtime/run-contracts/mutation-protocol";
import {
  type ArtifactExecutionAuthorization,
  assertArtifactExecutionAuthorization,
  type MonotonicClockPort,
  systemMonotonicClock,
} from "./authorization.js";
import type {
  ArtifactBlobBinding,
  ArtifactDeliveryRepositoryPort,
  ArtifactPublicationSnapshot,
  ArtifactPurpose,
  AuthorizedArtifactDownload,
  DeliverableDeclaration,
  UserRequestScope,
} from "./contracts.js";
import { ArtifactDeliveryError, artifactError } from "./errors.js";

const HARD_MAX_DOWNLOAD_TTL_SECONDS = 900;

export interface ArtifactDeliveryServiceOptions {
  readonly defaultDownloadTtlSeconds?: number;
  readonly maxDownloadTtlSeconds?: number;
  readonly runtimeMode?: "development" | "test" | "production";
  readonly monotonicClock?: MonotonicClockPort;
  /** 只供显式本地开发/测试配置；production 构造时会强制拒绝。 */
  readonly allowInsecureHttpDownload?: boolean;
}

export interface PublishArtifactCommand {
  readonly authorization: ArtifactExecutionAuthorization;
  /**
   * Tool Router 对已经通过严格协议校验的模型原始参数计算的摘要。
   * Workspace 路径可能先被提升成 ResourceVersion，因此该摘要不能由解析后的命令反推。
   */
  readonly toolArgsDigest: Sha256Digest;
  readonly idempotencyKey: string;
  readonly artifactId: ArtifactId;
  readonly resourceVersionId: ResourceVersionId;
  readonly replacesArtifactId?: ArtifactId;
  readonly name: string;
  readonly purpose: ArtifactPurpose;
  readonly deliverableKey?: string;
}

export interface ArtifactDownloadProjection {
  readonly artifactId: ArtifactId;
  readonly url: string;
  readonly expiresInSeconds: number;
  readonly fileName: string;
  readonly mediaType: string;
}

export class ArtifactDeliveryService implements ArtifactPublicationPort {
  readonly #defaultDownloadTtlSeconds: number;
  readonly #maxDownloadTtlSeconds: number;
  readonly #allowInsecureHttpDownload: boolean;
  readonly #monotonicClock: MonotonicClockPort;

  constructor(
    private readonly repository: ArtifactDeliveryRepositoryPort,
    private readonly blobs: BlobStore,
    options: ArtifactDeliveryServiceOptions = {},
  ) {
    this.#maxDownloadTtlSeconds = validateTtl(
      options.maxDownloadTtlSeconds ?? HARD_MAX_DOWNLOAD_TTL_SECONDS,
      HARD_MAX_DOWNLOAD_TTL_SECONDS,
      "maxDownloadTtlSeconds",
    );
    this.#defaultDownloadTtlSeconds = validateTtl(
      options.defaultDownloadTtlSeconds ?? 300,
      this.#maxDownloadTtlSeconds,
      "defaultDownloadTtlSeconds",
    );
    const runtimeMode = options.runtimeMode ?? "production";
    if (runtimeMode === "production" && options.allowInsecureHttpDownload === true) {
      throw invalidArgument("production 不允许明文 HTTP 下载 URL");
    }
    this.#allowInsecureHttpDownload = options.allowInsecureHttpDownload ?? false;
    this.#monotonicClock = options.monotonicClock ?? systemMonotonicClock;
  }

  async declareDeliverables(input: {
    readonly authorization: ArtifactExecutionAuthorization;
    readonly idempotencyKey: string;
    readonly declarations: readonly DeliverableDeclaration[];
  }): Promise<void> {
    validateIdempotencyKey(input.idempotencyKey);
    const authorizationExpectation = {
      toolName: "declare_deliverables",
      argsDigest: digestCanonical({
        idempotencyKey: input.idempotencyKey,
        declarations: input.declarations,
      }),
    } as const;
    this.#assertAuthorization(input.authorization, authorizationExpectation);
    const declarations = normalizeDeclarations(input.declarations);
    const commandDigest = digestCanonical({
      schemaVersion: 1,
      kind: "declare_deliverables",
      scope: stableScope(input.authorization.scope),
      idempotencyKey: input.idempotencyKey,
      declarations,
    });
    try {
      const result = await this.repository.declareDeliverables({
        authorization: input.authorization,
        idempotencyKey: input.idempotencyKey,
        commandDigest,
        declarations,
      });
      if (result.outcome === "applied" || result.outcome === "already_applied") {
        if (result.commandDigest !== commandDigest) throw idempotencyConflict();
        return;
      }
      if (result.outcome === "response_unknown") {
        this.#assertAuthorization(input.authorization, authorizationExpectation);
        const readback = await this.repository.readDeliverableDeclarationCommand({
          authorization: input.authorization,
          idempotencyKey: input.idempotencyKey,
        });
        if (
          (readback.outcome === "applied" || readback.outcome === "already_applied") &&
          readback.commandDigest === commandDigest
        ) {
          return;
        }
        if (
          (readback.outcome === "applied" || readback.outcome === "already_applied") &&
          readback.commandDigest !== commandDigest
        ) {
          throw idempotencyConflict();
        }
        throw dependencyUnavailable();
      }
      if (result.outcome === "conflict") throw idempotencyConflict();
      if (result.outcome === "not_running") {
        throw artifactError("ARTIFACT_INVALID_ARGUMENT", "只有运行中的 Run 可以声明交付物");
      }
      if (result.outcome === "not_found" || result.outcome === "scope_mismatch") {
        throw artifactNotFound();
      }
      throw dependencyUnavailable();
    } catch (error) {
      throw sanitize(error);
    }
  }

  async publishArtifact(command: PublishArtifactCommand): Promise<ArtifactPublicationSnapshot> {
    validateIdempotencyKey(command.idempotencyKey);
    const authorizationExpectation = {
      toolName: "publish_artifact",
      argsDigest: command.toolArgsDigest,
    } as const;
    this.#assertAuthorization(command.authorization, authorizationExpectation);
    const name = normalizeName(command.name);
    const deliverableKey = normalizePublicationPurpose(command.purpose, command.deliverableKey);
    const commandDigest = digestCanonical({
      schemaVersion: 1,
      kind: "publish_artifact",
      scope: stableScope(command.authorization.scope),
      idempotencyKey: command.idempotencyKey,
      toolArgsDigest: command.toolArgsDigest,
      artifactId: command.artifactId,
      resourceVersionId: command.resourceVersionId,
      replacesArtifactId: command.replacesArtifactId,
      name,
      purpose: command.purpose,
      deliverableKey,
    });

    try {
      const begun = await this.repository.beginPublication({
        authorization: command.authorization,
        idempotencyKey: command.idempotencyKey,
        commandDigest,
        artifactId: command.artifactId,
        resourceVersionId: command.resourceVersionId,
        ...(command.replacesArtifactId === undefined
          ? {}
          : { replacesArtifactId: command.replacesArtifactId }),
        name,
        purpose: command.purpose,
        ...(deliverableKey === undefined ? {} : { deliverableKey }),
      });
      if (
        begun.outcome !== "started" &&
        begun.outcome !== "already_started" &&
        begun.outcome !== "already_finished"
      ) {
        if (
          begun.outcome === "conflict" ||
          begun.outcome === "invalid_replacement" ||
          begun.outcome === "resource_mismatch"
        ) {
          throw idempotencyConflict();
        }
        if (begun.outcome === "not_found" || begun.outcome === "scope_mismatch") {
          throw artifactNotFound();
        }
        if (begun.outcome === "not_running") {
          throw artifactError("ARTIFACT_INVALID_ARGUMENT", "只有运行中的 Run 可以发布交付物");
        }
        throw dependencyUnavailable();
      }
      validatePublicationIdentity(begun.publication, command, name, deliverableKey);
      validateBinding(begun.binding, begun.publication);
      if (begun.publication.status === "published") return begun.publication;
      if (begun.publication.status === "failed") throw publicationFailed();

      const blobReady = await this.#verifyBlob(command.authorization.scope, begun.binding);
      const target = blobReady ? "published" : "failed";
      const settled = await this.#finishPublication(
        command.authorization,
        command.idempotencyKey,
        commandDigest,
        command.artifactId,
        target,
        begun.binding,
        authorizationExpectation,
      );
      validatePublicationIdentity(settled, command, name, deliverableKey);
      if (settled.status !== target) throw dependencyUnavailable();
      if (settled.status === "failed") throw publicationFailed();
      return settled;
    } catch (error) {
      throw sanitize(error);
    }
  }

  async assertReadyForCompletion(
    input: Parameters<ArtifactPublicationPort["assertReadyForCompletion"]>[0],
  ): Promise<void> {
    try {
      const result = await this.repository.inspectCompletion(input);
      if (result.outcome === "ready") return;
      // 完成门有意把存储异常与业务未就绪统一成稳定码，交给 Agent 修正或稍后再完成。
      throw artifactError("ARTIFACT_NOT_READY", "必需交付物尚未全部发布成功");
    } catch (error) {
      if (error instanceof ArtifactDeliveryError && error.code === "ARTIFACT_NOT_READY")
        throw error;
      throw artifactError("ARTIFACT_NOT_READY", "必需交付物尚未全部发布成功");
    }
  }

  async listDeliverables(input: {
    readonly request: UserRequestScope;
    readonly runId: RunId;
  }): Promise<readonly ArtifactPublicationSnapshot[]> {
    try {
      const result = await this.repository.listAuthorizedArtifacts(input);
      if (result.outcome !== "authorized") {
        if (result.outcome === "not_found") throw artifactNotFound();
        throw dependencyUnavailable();
      }
      // Repository 也应过滤；应用层再次投影，防止 Diagnostic/Trace 因适配器错误泄漏。
      return Object.freeze(
        result.artifacts.filter(
          (artifact) =>
            artifact.tenantId === input.request.tenantId &&
            artifact.runId === input.runId &&
            artifact.purpose === "deliverable" &&
            artifact.status === "published",
        ),
      );
    } catch (error) {
      throw sanitize(error);
    }
  }

  async createDownload(input: {
    readonly request: UserRequestScope;
    readonly artifactId: ArtifactId;
  }): Promise<ArtifactDownloadProjection> {
    try {
      const result = await this.repository.authorizeDownload(input);
      if (result.outcome !== "authorized") {
        if (result.outcome === "not_found") throw artifactNotFound();
        throw dependencyUnavailable();
      }
      const { download } = result;
      validateDownloadGrant(download, input);
      const fileName = safeDownloadName(download.publication.name, download.publication.artifactId);
      const mediaType = validateMediaType(download.binding.mediaType);
      const url = await this.blobs.presignDownload({
        scope: { tenantId: input.request.tenantId },
        blob: download.binding.blob,
        ttlSeconds: this.#defaultDownloadTtlSeconds,
        responseMediaType: mediaType,
        delivery: "artifact-download",
        downloadName: fileName,
      });
      validateDownloadUrl(url, this.#allowInsecureHttpDownload);
      const confirmed = await this.repository.confirmDownloadAuthorization(download);
      if (confirmed.outcome === "not_found" || confirmed.outcome === "changed") {
        throw artifactNotFound();
      }
      if (confirmed.outcome === "unavailable") throw dependencyUnavailable();
      return Object.freeze({
        artifactId: download.publication.artifactId,
        url,
        expiresInSeconds: this.#defaultDownloadTtlSeconds,
        fileName,
        mediaType,
      });
    } catch (error) {
      throw sanitize(error);
    }
  }

  async #verifyBlob(scope: ExecutionScope, binding: ArtifactBlobBinding): Promise<boolean> {
    try {
      const head = await this.blobs.head({ tenantId: scope.tenantId }, binding.blob);
      return (
        head !== undefined &&
        head.blob.kind === "stable" &&
        sameBlobIdentity(head.blob, binding.blob)
      );
    } catch {
      return false;
    }
  }

  async #finishPublication(
    authorization: ArtifactExecutionAuthorization,
    idempotencyKey: string,
    commandDigest: Sha256Digest,
    artifactId: ArtifactId,
    target: "published" | "failed",
    expectedBinding: ArtifactBlobBinding,
    authorizationExpectation: { readonly toolName: string; readonly argsDigest: Sha256Digest },
  ): Promise<ArtifactPublicationSnapshot> {
    this.#assertAuthorization(authorization, authorizationExpectation);
    const result = await this.repository.finishPublication({
      authorization,
      idempotencyKey,
      commandDigest,
      artifactId,
      target,
    });
    if (result.outcome === "applied" || result.outcome === "already_applied") {
      return result.publication;
    }
    if (result.outcome === "response_unknown") {
      this.#assertAuthorization(authorization, authorizationExpectation);
      const readback = await this.repository.readPublicationCommand({
        authorization,
        idempotencyKey,
      });
      if (readback.outcome === "found") {
        if (readback.commandDigest !== commandDigest) throw idempotencyConflict();
        if (!sameBindingIdentity(readback.binding, expectedBinding)) throw idempotencyConflict();
        return readback.publication;
      }
    }
    if (result.outcome === "conflict") throw idempotencyConflict();
    if (result.outcome === "not_found" || result.outcome === "scope_mismatch") {
      throw artifactNotFound();
    }
    throw dependencyUnavailable();
  }

  #assertAuthorization(
    authorization: ArtifactExecutionAuthorization,
    expected: { readonly toolName: string; readonly argsDigest: Sha256Digest },
  ): void {
    assertArtifactExecutionAuthorization(authorization, expected, this.#monotonicClock);
  }
}

function validatePublicationIdentity(
  publication: ArtifactPublicationSnapshot,
  command: PublishArtifactCommand,
  name: string,
  deliverableKey: string | undefined,
): void {
  if (
    publication.artifactId !== command.artifactId ||
    publication.tenantId !== command.authorization.scope.tenantId ||
    publication.threadId !== command.authorization.scope.threadId ||
    publication.runId !== command.authorization.scope.runId ||
    publication.resourceVersionId !== command.resourceVersionId ||
    publication.replacesArtifactId !== command.replacesArtifactId ||
    publication.name !== name ||
    publication.purpose !== command.purpose ||
    publication.deliverableKey !== deliverableKey
  ) {
    throw idempotencyConflict();
  }
}

function validateBinding(
  binding: ArtifactBlobBinding,
  publication: ArtifactPublicationSnapshot,
): void {
  if (
    binding.resourceVersionId !== publication.resourceVersionId ||
    binding.blob.tenantId !== publication.tenantId ||
    binding.blob.kind !== "stable" ||
    binding.blob.purpose !== "resource"
  ) {
    throw dependencyUnavailable();
  }
  validateMediaType(binding.mediaType);
}

function validateDownloadGrant(
  download: AuthorizedArtifactDownload,
  input: { readonly request: UserRequestScope; readonly artifactId: ArtifactId },
): void {
  const publication = download.publication;
  if (
    download.authorization.scope.tenantId !== input.request.tenantId ||
    download.authorization.scope.userId !== input.request.userId ||
    publication.artifactId !== input.artifactId ||
    publication.tenantId !== input.request.tenantId ||
    publication.purpose !== "deliverable" ||
    publication.status !== "published" ||
    download.binding.resourceVersionId !== publication.resourceVersionId ||
    download.binding.blob.tenantId !== publication.tenantId ||
    download.binding.blob.kind !== "stable" ||
    download.authorization.authorizationRevision.trim().length === 0
  ) {
    throw artifactNotFound();
  }
  validateBinding(download.binding, publication);
}

function sameBlobIdentity(left: StableBlobRef, right: StableBlobRef): boolean {
  return (
    left.kind === right.kind &&
    left.tenantId === right.tenantId &&
    left.purpose === right.purpose &&
    left.sha256 === right.sha256 &&
    left.size === right.size &&
    left.mediaType === right.mediaType &&
    left.incarnationId === right.incarnationId &&
    left.physicalObjectKey === right.physicalObjectKey
  );
}

function sameBindingIdentity(left: ArtifactBlobBinding, right: ArtifactBlobBinding): boolean {
  return (
    left.resourceVersionId === right.resourceVersionId &&
    left.mediaType === right.mediaType &&
    sameBlobIdentity(left.blob, right.blob)
  );
}

function normalizeDeclarations(
  declarations: readonly DeliverableDeclaration[],
): readonly DeliverableDeclaration[] {
  if (declarations.length > 64) throw invalidArgument("交付物声明数量超过上限");
  const keys = new Set<string>();
  return Object.freeze(
    declarations.map((declaration) => {
      const key = normalizeKey(declaration.key, "交付物声明键");
      if (keys.has(key)) throw invalidArgument("交付物声明键重复");
      keys.add(key);
      if (declaration.requirement !== "required" && declaration.requirement !== "optional") {
        throw invalidArgument("交付物必要性无效");
      }
      return Object.freeze({
        key,
        name: normalizeName(declaration.name),
        requirement: declaration.requirement,
      });
    }),
  );
}

function normalizePublicationPurpose(
  purpose: ArtifactPurpose,
  deliverableKey: string | undefined,
): string | undefined {
  if (purpose !== "deliverable" && purpose !== "diagnostic" && purpose !== "trace") {
    throw invalidArgument("Artifact 用途无效");
  }
  if (purpose === "deliverable") {
    if (deliverableKey === undefined) throw invalidArgument("Deliverable 必须绑定声明键");
    return normalizeKey(deliverableKey, "交付物声明键");
  }
  if (deliverableKey !== undefined) throw invalidArgument("过程产物不能绑定交付物声明键");
  return undefined;
}

function normalizeName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 255) throw invalidArgument("Artifact 名称长度无效");
  if (containsUnicodeControlOrFormat(name)) {
    throw invalidArgument("Artifact 名称包含控制或格式字符");
  }
  return name;
}

function normalizeKey(value: string, label: string): string {
  const key = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(key)) {
    throw invalidArgument(`${label}格式无效`);
  }
  return key;
}

function validateIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)) {
    throw invalidArgument("幂等键格式无效");
  }
}

function validateMediaType(mediaType: string): string {
  if (
    mediaType.length < 3 ||
    mediaType.length > 255 ||
    containsControl(mediaType) ||
    !/^[!#$&^_.+\-\w]+\/[!#$&^_.+\-\w]+(?:\s*;\s*[^\r\n]+)?$/u.test(mediaType)
  ) {
    throw dependencyUnavailable();
  }
  return mediaType;
}

function safeDownloadName(name: string, artifactId: ArtifactId): string {
  if (containsUnicodeControlOrFormat(name)) throw dependencyUnavailable();
  const normalized = Array.from(name.normalize("NFKC"))
    .map((character) =>
      containsControl(character) || '/\\"*:<>?|'.includes(character) ? "_" : character,
    )
    .join("")
    .replace(/[. ]+$/gu, "")
    .trim();
  const fallback = `artifact-${artifactId}`;
  const candidate = protectWindowsDeviceName(normalized.length === 0 ? fallback : normalized);
  let safe = "";
  for (const character of candidate) {
    if (safe.length + character.length > 180) break;
    safe += character;
  }
  return safe;
}

function protectWindowsDeviceName(value: string): string {
  const baseName = value.split(".", 1)[0]?.trim().toUpperCase() ?? "";
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(baseName) ? `_${value}` : value;
}

function validateDownloadUrl(value: string, allowInsecureHttp: boolean): void {
  try {
    const url = new URL(value);
    const protocolAllowed =
      url.protocol === "https:" || (allowInsecureHttp && url.protocol === "http:");
    if (
      !protocolAllowed ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.host.length === 0
    ) {
      throw dependencyUnavailable();
    }
  } catch (error) {
    if (error instanceof ArtifactDeliveryError) throw error;
    throw dependencyUnavailable();
  }
}

function validateTtl(value: number, upperBound: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > upperBound) {
    throw invalidArgument(`${label} 必须是 1 到 ${upperBound} 的整数`);
  }
  return value;
}

function stableScope(scope: ExecutionScope): ExecutionScope {
  return {
    tenantId: scope.tenantId,
    threadId: scope.threadId,
    runId: scope.runId,
    rootRunId: scope.rootRunId,
    workspaceId: scope.workspaceId,
    ...(scope.baseRevisionId === undefined ? {} : { baseRevisionId: scope.baseRevisionId }),
  };
}

function containsControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

function containsUnicodeControlOrFormat(value: string): boolean {
  return /[\p{Cc}\p{Cf}]/u.test(value);
}

function invalidArgument(message: string): ArtifactDeliveryError {
  return artifactError("ARTIFACT_INVALID_ARGUMENT", message);
}

function artifactNotFound(): ArtifactDeliveryError {
  return artifactError("ARTIFACT_NOT_FOUND", "Artifact 不存在或无权访问");
}

function idempotencyConflict(): ArtifactDeliveryError {
  return artifactError("ARTIFACT_IDEMPOTENCY_CONFLICT", "Artifact 幂等摘要或绑定冲突");
}

function publicationFailed(): ArtifactDeliveryError {
  return artifactError("ARTIFACT_PUBLICATION_FAILED", "Artifact 发布失败，请创建新版本后重新发布");
}

function dependencyUnavailable(): ArtifactDeliveryError {
  return artifactError("ARTIFACT_DEPENDENCY_UNAVAILABLE", "Artifact 服务暂时不可用");
}

function sanitize(error: unknown): ArtifactDeliveryError {
  // 未知依赖异常不携带 cause 和私有 message，避免数据库、对象键或签名 URL 进入公开错误。
  return error instanceof ArtifactDeliveryError ? error : dependencyUnavailable();
}

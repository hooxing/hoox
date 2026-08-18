import type { ResourceId, ResourceVersionId, WorkspaceId, WorkspaceRevisionId } from "@hoox/domain";
import type {
  PromoteResourceRequest,
  PromoteResourceRequestResult,
  PromotionCapabilityVerifier,
  ResourceCatalog,
  ResourceCatalogItem,
  ResourceContentReader,
  ResourceCursorCodec,
  ResourceImportPlanResult,
  ResourcePreviewResult,
  ResourceSearchItem,
  ResourceSearchResult,
  TrustedResourceContext,
  WorkspaceImportTargetInspector,
  WorkspacePromotionAuthorizer,
} from "./contracts.js";
import { type ResourceErrorCode, ResourceServiceError, resourceInvariant } from "./errors.js";
import { assertResourceName, normalizeWorkspaceRelativePath } from "./path.js";

export interface ResourceLibraryConfig {
  readonly defaultPageSize?: number;
  readonly maxPageSize?: number;
  readonly maxQueryBytes?: number;
  readonly defaultPreviewBytes?: number;
  readonly maxPreviewBytes?: number;
  readonly previewableMediaTypes?: readonly string[];
  readonly maxPromotionAuthorizationTtlSeconds?: number;
  readonly now?: () => Date;
}

export interface ResourceLibraryDependencies {
  readonly catalog: ResourceCatalog;
  readonly contentReader: ResourceContentReader;
  readonly cursorCodec: ResourceCursorCodec;
  readonly importTargets: WorkspaceImportTargetInspector;
  readonly promotionAuthorizer: WorkspacePromotionAuthorizer;
  readonly promotionCapabilities: PromotionCapabilityVerifier;
}

const DEFAULT_PREVIEW_MEDIA_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export class ResourceLibraryService {
  private readonly defaultPageSize: number;
  private readonly maxPageSize: number;
  private readonly maxQueryBytes: number;
  private readonly defaultPreviewBytes: number;
  private readonly maxPreviewBytes: number;
  private readonly previewableMediaTypes: ReadonlySet<string>;
  private readonly maxPromotionAuthorizationTtlSeconds: number;
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: ResourceLibraryDependencies,
    config: ResourceLibraryConfig = {},
  ) {
    this.maxPageSize = config.maxPageSize ?? 100;
    this.defaultPageSize = config.defaultPageSize ?? 20;
    this.maxQueryBytes = config.maxQueryBytes ?? 256;
    this.maxPreviewBytes = config.maxPreviewBytes ?? 256 * 1_024;
    this.defaultPreviewBytes = config.defaultPreviewBytes ?? 64 * 1_024;
    this.maxPromotionAuthorizationTtlSeconds = config.maxPromotionAuthorizationTtlSeconds ?? 900;
    this.now = config.now ?? (() => new Date());
    resourceInvariant(
      Number.isSafeInteger(this.maxPageSize) && this.maxPageSize >= 1 && this.maxPageSize <= 1_000,
      "INVALID_REQUEST",
      "Resource 最大页大小配置无效",
    );
    resourceInvariant(
      Number.isSafeInteger(this.defaultPageSize) &&
        this.defaultPageSize >= 1 &&
        this.defaultPageSize <= this.maxPageSize,
      "INVALID_REQUEST",
      "Resource 默认页大小配置无效",
    );
    resourceInvariant(
      Number.isSafeInteger(this.maxQueryBytes) &&
        this.maxQueryBytes >= 1 &&
        this.maxQueryBytes <= 4_096,
      "INVALID_REQUEST",
      "Resource 查询预算配置无效",
    );
    resourceInvariant(
      Number.isSafeInteger(this.maxPreviewBytes) &&
        this.maxPreviewBytes >= 1 &&
        this.maxPreviewBytes <= 16 * 1_024 * 1_024 &&
        Number.isSafeInteger(this.defaultPreviewBytes) &&
        this.defaultPreviewBytes >= 1 &&
        this.defaultPreviewBytes <= this.maxPreviewBytes,
      "INVALID_REQUEST",
      "Resource 预览预算配置无效",
    );
    resourceInvariant(
      Number.isSafeInteger(this.maxPromotionAuthorizationTtlSeconds) &&
        this.maxPromotionAuthorizationTtlSeconds >= 1 &&
        this.maxPromotionAuthorizationTtlSeconds <= 3_600,
      "INVALID_REQUEST",
      "Resource 提升授权 TTL 配置无效",
    );
    const configuredTypes = config.previewableMediaTypes ?? DEFAULT_PREVIEW_MEDIA_TYPES;
    const types = configuredTypes.map(normalizeMediaType);
    resourceInvariant(types.length > 0, "INVALID_REQUEST", "Resource 预览类型配置不能为空");
    this.previewableMediaTypes = new Set(types);
  }

  async search(input: {
    readonly context: TrustedResourceContext;
    readonly query?: string;
    readonly pageSize?: number;
    readonly cursor?: string;
  }): Promise<ResourceSearchResult> {
    assertTrustedContext(input.context);
    const normalizedQuery = normalizeSearchQuery(input.query ?? "", this.maxQueryBytes);
    const limit = normalizePageSize(input.pageSize, this.defaultPageSize, this.maxPageSize);
    const after =
      input.cursor === undefined
        ? undefined
        : this.dependencies.cursorCodec.decode({
            context: input.context,
            normalizedQuery,
            cursor: input.cursor,
          });
    const page = await callExternalPort(() =>
      this.dependencies.catalog.search({
        context: input.context,
        normalizedQuery,
        limit,
        ...(after === undefined ? {} : { after }),
      }),
    );
    const validatedPage = validateExternalResult(() => {
      const items = page.items;
      const nextPosition = page.nextPosition;
      validateCatalogPage(items, nextPosition, limit, after, input.context);
      return Object.freeze({
        items: Object.freeze(items.map(projectSearchItem)),
        nextPosition:
          nextPosition === undefined
            ? undefined
            : Object.freeze({
                updatedAt: nextPosition.updatedAt,
                resourceId: nextPosition.resourceId,
              }),
      });
    });
    const nextCursor =
      validatedPage.nextPosition === undefined
        ? undefined
        : this.dependencies.cursorCodec.encode({
            context: input.context,
            normalizedQuery,
            position: validatedPage.nextPosition,
          });
    return Object.freeze({
      // 显式投影白名单字段，防止目录适配器意外把 objectKey 等内部字段带到公开结果。
      items: validatedPage.items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    });
  }

  async preview(input: {
    readonly context: TrustedResourceContext;
    readonly resourceId: ResourceId;
    readonly versionId: ResourceVersionId;
    readonly offset?: number;
    readonly length?: number;
  }): Promise<ResourcePreviewResult> {
    assertTrustedContext(input.context);
    assertId(input.resourceId);
    assertId(input.versionId);
    const resolved = await this.resolveCanonicalVersion(input);
    if (resolved.status === "not_found") return Object.freeze({ status: "not_found" });
    const mediaType = normalizeMediaType(resolved.version.mediaType);
    if (!this.previewableMediaTypes.has(mediaType)) {
      return Object.freeze({ status: "unsupported_media_type", mediaType });
    }
    const offset = input.offset ?? 0;
    const length = input.length ?? this.defaultPreviewBytes;
    assertByteRange(offset, length, this.maxPreviewBytes);
    if (resolved.version.sizeBytes === 0) {
      if (offset !== 0) {
        return Object.freeze({ status: "range_not_satisfiable", totalSizeBytes: 0 });
      }
      return Object.freeze({
        status: "available",
        resourceId: resolved.resource.id,
        versionId: resolved.version.id,
        mediaType,
        range: Object.freeze({ offset: 0, length: 0 }),
        totalSizeBytes: 0,
        truncated: false,
        bytes: new Uint8Array(),
      });
    }
    if (offset >= resolved.version.sizeBytes) {
      return Object.freeze({
        status: "range_not_satisfiable",
        totalSizeBytes: resolved.version.sizeBytes,
      });
    }
    const boundedLength = Math.min(length, resolved.version.sizeBytes - offset);
    const bytes = await callExternalPort(() =>
      this.dependencies.contentReader.readRange({
        context: input.context,
        version: resolved.authorizedReadVersion,
        range: { offset, length: boundedLength },
      }),
    );
    const validatedBytes = validateExternalResult(() => {
      externalResultInvariant(
        bytes instanceof Uint8Array && bytes.byteLength === boundedLength,
        "CONTENT_INTEGRITY_ERROR",
        "Resource 内容读取未完整满足授权字节范围",
      );
      return new Uint8Array(bytes);
    });
    return Object.freeze({
      status: "available",
      resourceId: resolved.resource.id,
      versionId: resolved.version.id,
      mediaType,
      range: Object.freeze({ offset, length: validatedBytes.byteLength }),
      totalSizeBytes: resolved.version.sizeBytes,
      truncated: offset + validatedBytes.byteLength < resolved.version.sizeBytes,
      bytes: validatedBytes,
    });
  }

  async planImport(input: {
    readonly context: TrustedResourceContext;
    readonly resourceId: ResourceId;
    readonly versionId: ResourceVersionId;
    readonly targetWorkspaceId: WorkspaceId;
    readonly targetPath: string;
    readonly conflictPolicy?: "reject";
  }): Promise<ResourceImportPlanResult> {
    assertTrustedContext(input.context);
    assertId(input.resourceId);
    assertId(input.versionId);
    assertId(input.targetWorkspaceId);
    resourceInvariant(
      input.conflictPolicy === undefined || input.conflictPolicy === "reject",
      "INVALID_REQUEST",
      "首版 Resource 导入禁止覆盖目标文件",
    );
    const safeRelativePath = normalizeWorkspaceRelativePath(input.targetPath);
    const resolved = await this.resolveCanonicalVersion(input);
    if (resolved.status === "not_found") return Object.freeze({ status: "not_found" });
    const target = await callExternalPort(() =>
      this.dependencies.importTargets.inspect({
        context: input.context,
        workspaceId: input.targetWorkspaceId,
        safeRelativePath,
      }),
    );
    const targetStatus = validateExternalResult(() => target.status);
    if (targetStatus === "not_found") return Object.freeze({ status: "not_found" });
    if (targetStatus === "occupied") return Object.freeze({ status: "target_conflict" });
    resourceInvariant(
      targetStatus === "available",
      "CONTENT_INTEGRITY_ERROR",
      "Workspace 导入目标检查结果无效",
    );
    return Object.freeze({
      status: "planned",
      plan: Object.freeze({
        kind: "resource_import_plan",
        planVersion: 1,
        snapshot: Object.freeze({
          resourceId: resolved.resource.id,
          versionId: resolved.version.id,
          versionNumber: resolved.version.versionNumber,
          digest: resolved.version.digest,
          mediaType: normalizeMediaType(resolved.version.mediaType),
          sizeBytes: resolved.version.sizeBytes,
        }),
        target: Object.freeze({
          workspaceId: input.targetWorkspaceId,
          relativePath: safeRelativePath,
          conflictPolicy: "reject",
          precondition: "target_absent",
        }),
        materialization: "not_started",
        workspaceWriterLease: "not_acquired",
      }),
    });
  }

  async requestPromotion(input: {
    readonly context: TrustedResourceContext;
    readonly capability: unknown;
    readonly command: PromoteResourceRequest;
  }): Promise<PromoteResourceRequestResult> {
    assertTrustedContext(input.context);
    assertId(input.command.workspaceId);
    assertId(input.command.revisionId);
    const verifiedAgentContext = await callExternalPort(() =>
      this.dependencies.promotionCapabilities.verify(input.capability),
    );
    const agentContext = validateExternalResult(() => {
      if (verifiedAgentContext === undefined) return undefined;
      const actor = verifiedAgentContext.actor;
      return Object.freeze({
        tenantId: verifiedAgentContext.tenantId,
        userId: verifiedAgentContext.userId,
        actor: Object.freeze({
          kind: actor.kind,
          agentThreadId: actor.agentThreadId,
          threadId: actor.threadId,
          runId: actor.runId,
        }),
      });
    });
    if (
      agentContext === undefined ||
      agentContext.tenantId !== input.context.tenantId ||
      agentContext.userId !== input.context.userId
    ) {
      return Object.freeze({ status: "not_authorized" });
    }
    const resourceName = assertResourceName(input.command.resourceName);
    const safeRelativePath = normalizeWorkspaceRelativePath(input.command.relativePath);
    const outcome = await callExternalPort(() =>
      this.dependencies.promotionAuthorizer.authorizeSnapshot({
        context: agentContext,
        workspaceId: input.command.workspaceId,
        revisionId: input.command.revisionId,
        safeRelativePath,
      }),
    );
    const validatedOutcome = validateExternalResult(() => {
      const status = outcome.status;
      if (status === "not_found" || status === "not_authorized") {
        return Object.freeze({ status });
      }
      externalResultInvariant(
        status === "authorized",
        "CONTENT_INTEGRITY_ERROR",
        "提升授权结果格式无效",
      );
      const authorization = outcome.authorization;
      const authorizationId = authorization.authorizationId;
      const tenantId = authorization.tenantId;
      const workspaceId = authorization.workspaceId;
      const revisionId = authorization.revisionId;
      const relativePath = authorization.relativePath;
      const digest = authorization.digest;
      const mediaType = authorization.mediaType;
      const sizeBytes = authorization.sizeBytes;
      const expiresAt = authorization.expiresAt;
      externalResultInvariant(
        tenantId === input.context.tenantId &&
          workspaceId === input.command.workspaceId &&
          revisionId === input.command.revisionId &&
          relativePath === safeRelativePath,
        "NOT_AUTHORIZED",
        "提升授权与可信执行范围不一致",
      );
      externalResultInvariant(
        /^[A-Za-z0-9][A-Za-z0-9._:-]{15,254}$/u.test(authorizationId) &&
          /^[a-f0-9]{64}$/u.test(digest) &&
          Number.isSafeInteger(sizeBytes) &&
          sizeBytes >= 0 &&
          isCanonicalIsoTimestamp(expiresAt),
        "CONTENT_INTEGRITY_ERROR",
        "提升授权快照格式无效",
      );
      return Object.freeze({
        status,
        authorization: Object.freeze({
          authorizationId,
          tenantId,
          workspaceId,
          revisionId,
          relativePath,
          digest,
          mediaType: normalizeMediaType(mediaType),
          sizeBytes,
          expiresAt,
        }),
      });
    });
    if (validatedOutcome.status !== "authorized") {
      return Object.freeze({ status: validatedOutcome.status });
    }
    const authorization = validatedOutcome.authorization;
    const currentTime = this.now();
    const expirationTime = new Date(authorization.expiresAt);
    resourceInvariant(
      !Number.isNaN(currentTime.getTime()) &&
        expirationTime.getTime() > currentTime.getTime() &&
        expirationTime.getTime() - currentTime.getTime() <=
          this.maxPromotionAuthorizationTtlSeconds * 1_000,
      "NOT_AUTHORIZED",
      "提升授权已过期或有效期过长",
    );
    return Object.freeze({
      status: "authorized",
      request: Object.freeze({
        kind: "promote_resource",
        resourceName,
        origin: "promoted_workspace",
        source: authorization,
        catalogVisibility: "pending_explicit_commit",
      }),
    });
  }

  private async resolveCanonicalVersion(input: {
    readonly context: TrustedResourceContext;
    readonly resourceId: ResourceId;
    readonly versionId: ResourceVersionId;
  }) {
    const resolved = await callExternalPort(() => this.dependencies.catalog.resolveVersion(input));
    return validateExternalResult(() => {
      const status = resolved.status;
      if (status === "not_found") return Object.freeze({ status });
      externalResultInvariant(
        status === "found",
        "CONTENT_INTEGRITY_ERROR",
        "Resource 版本解析结果格式无效",
      );
      const resource = resolved.resource;
      const version = resolved.version;
      const resourceId = resource.id;
      const resourceTenantId = resource.tenantId;
      const versionId = version.id;
      const versionResourceId = version.resourceId;
      const versionTenantId = version.tenantId;
      const versionNumber = version.versionNumber;
      const objectKey = version.objectKey;
      const digest = version.digest;
      const mediaType = version.mediaType;
      const sizeBytes = version.sizeBytes;
      externalResultInvariant(
        resourceTenantId === input.context.tenantId &&
          versionTenantId === input.context.tenantId &&
          resourceId === input.resourceId &&
          versionResourceId === input.resourceId &&
          versionId === input.versionId,
        "NOT_AUTHORIZED",
        "Resource 版本授权结果与请求不一致",
      );
      externalResultInvariant(
        Number.isSafeInteger(versionNumber) &&
          versionNumber >= 1 &&
          Number.isSafeInteger(sizeBytes) &&
          sizeBytes >= 0 &&
          /^[a-f0-9]{64}$/u.test(digest) &&
          objectKey.trim().length > 0,
        "CONTENT_INTEGRITY_ERROR",
        "Resource 版本元数据无效",
      );
      return Object.freeze({
        status,
        resource: Object.freeze({ id: resourceId }),
        version: Object.freeze({
          id: versionId,
          resourceId: versionResourceId,
          tenantId: versionTenantId,
          versionNumber,
          objectKey,
          digest,
          mediaType,
          sizeBytes,
        }),
        // 只在受 callExternalPort 包裹的 reader 调用中传递名义领域实体；
        // 服务后续判断全部使用上面的纯值快照，不再触发外部 Getter/Proxy。
        authorizedReadVersion: version,
      });
    });
  }
}

export function normalizeSearchQuery(value: string, maxBytes = 256): string {
  resourceInvariant(typeof value === "string", "INVALID_REQUEST", "Resource 查询格式无效");
  resourceInvariant(
    !containsForbiddenUnicode(value),
    "INVALID_REQUEST",
    "Resource 查询包含非法字符",
  );
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  resourceInvariant(
    !containsControl(normalized) && Buffer.byteLength(normalized, "utf8") <= maxBytes,
    "INVALID_REQUEST",
    "Resource 查询超过限制或包含非法字符",
  );
  return normalized;
}

function normalizePageSize(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  resourceInvariant(
    Number.isSafeInteger(selected) && selected >= 1 && selected <= maximum,
    "INVALID_REQUEST",
    "Resource 页大小无效",
  );
  return selected;
}

function validateCatalogPage(
  items: readonly ResourceCatalogItem[],
  nextPosition: { readonly updatedAt: string; readonly resourceId: string } | undefined,
  limit: number,
  after: { readonly updatedAt: string; readonly resourceId: string } | undefined,
  context: TrustedResourceContext,
): void {
  externalResultInvariant(
    items.length <= limit,
    "CONTENT_INTEGRITY_ERROR",
    "Resource 目录返回超出页大小",
  );
  const resourceIds = new Set<string>();
  const versionIds = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    externalResultInvariant(item !== undefined, "CONTENT_INTEGRITY_ERROR", "Resource 目录页无效");
    externalResultInvariant(
      item.tenantId === context.tenantId && item.visibility === "searchable",
      "NOT_AUTHORIZED",
      "Resource 目录返回越权或不可见记录",
    );
    assertReturnedId(item.resourceId);
    assertReturnedId(item.versionId);
    externalResultInvariant(
      !resourceIds.has(item.resourceId) && !versionIds.has(item.versionId),
      "CONTENT_INTEGRITY_ERROR",
      "Resource 目录返回重复记录",
    );
    resourceIds.add(item.resourceId);
    versionIds.add(item.versionId);
    if (after !== undefined) {
      externalResultInvariant(
        isStrictlyAfterPosition(item, after),
        "CONTENT_INTEGRITY_ERROR",
        "Resource 目录记录没有位于游标之后",
      );
    }
    if (index === 0) continue;
    const previous = items[index - 1];
    const current = item;
    externalResultInvariant(
      previous !== undefined && current !== undefined,
      "CONTENT_INTEGRITY_ERROR",
      "Resource 目录页无效",
    );
    const previousTime = Date.parse(previous.updatedAt);
    const currentTime = Date.parse(current.updatedAt);
    externalResultInvariant(
      !Number.isNaN(previousTime) && !Number.isNaN(currentTime),
      "CONTENT_INTEGRITY_ERROR",
      "Resource 目录时间格式无效",
    );
    const ordered =
      previousTime > currentTime ||
      (previousTime === currentTime && previous.resourceId > current.resourceId);
    externalResultInvariant(ordered, "CONTENT_INTEGRITY_ERROR", "Resource 目录排序不稳定");
  }
  if (nextPosition !== undefined) {
    const last = items.at(-1);
    externalResultInvariant(
      last !== undefined &&
        last.updatedAt === nextPosition.updatedAt &&
        last.resourceId === nextPosition.resourceId,
      "CONTENT_INTEGRITY_ERROR",
      "Resource 目录游标位置无效",
    );
  }
}

function projectSearchItem(item: ResourceCatalogItem): ResourceSearchItem {
  const normalizedName = item.name.normalize("NFKC").trim();
  externalResultInvariant(
    Number.isSafeInteger(item.versionNumber) &&
      item.versionNumber >= 1 &&
      Number.isSafeInteger(item.sizeBytes) &&
      item.sizeBytes >= 0 &&
      isCanonicalIsoTimestamp(item.updatedAt) &&
      normalizedName.length >= 1 &&
      Buffer.byteLength(normalizedName, "utf8") <= 255 &&
      !containsControl(normalizedName) &&
      (["upload", "file_source", "promoted_workspace", "artifact"] as const).includes(item.origin),
    "CONTENT_INTEGRITY_ERROR",
    "Resource 目录元数据无效",
  );
  return Object.freeze({
    resourceId: item.resourceId,
    versionId: item.versionId,
    versionNumber: item.versionNumber,
    name: normalizedName,
    origin: item.origin,
    mediaType: normalizeMediaType(item.mediaType),
    sizeBytes: item.sizeBytes,
    updatedAt: item.updatedAt,
  });
}

function assertByteRange(offset: number, length: number, maximum: number): void {
  resourceInvariant(
    Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(length) && length >= 1,
    "INVALID_REQUEST",
    "Resource 预览字节范围无效",
  );
  if (length > maximum) {
    throw new ResourceServiceError("PREVIEW_BUDGET_EXCEEDED", "Resource 预览超过单次字节预算");
  }
  resourceInvariant(
    Number.isSafeInteger(offset + length),
    "INVALID_REQUEST",
    "Resource 预览字节范围溢出",
  );
}

function normalizeMediaType(value: string): string {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  externalResultInvariant(
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(mediaType),
    "CONTENT_INTEGRITY_ERROR",
    "Resource 媒体类型无效",
  );
  return mediaType;
}

function assertTrustedContext(context: TrustedResourceContext): void {
  resourceInvariant(
    typeof context === "object" &&
      context !== null &&
      validId(context.tenantId) &&
      validId(context.userId),
    "NOT_AUTHORIZED",
    "缺少有效的 Resource 认证上下文",
  );
}

function containsControl(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
}

function containsForbiddenUnicode(value: string): boolean {
  // 查询允许会被折叠的 TAB/CR/LF；其他控制、格式控制和未配对 surrogate 均拒绝。
  if (/[\p{Cf}\p{Cs}]/u.test(value)) return true;
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return (
      point !== undefined &&
      ((point >= 0 && point <= 31 && point !== 9 && point !== 10 && point !== 13) || point === 127)
    );
  });
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{3}))?Z$/u.exec(value);
  if (match === null) return false;
  const normalized = match[2] === undefined ? `${match[1]}.000Z` : value;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === normalized;
}

export type ResourcePreviewCommand = Parameters<ResourceLibraryService["preview"]>[0];
export type ResourceImportCommand = Parameters<ResourceLibraryService["planImport"]>[0];
export type ResourcePromotionCommand = Parameters<ResourceLibraryService["requestPromotion"]>[0];
export type ResourceSearchCommand = Parameters<ResourceLibraryService["search"]>[0];

// 避免这些领域类型在声明文件中被 TypeScript 视为仅内部推断名称。
export type ResourceLibraryIdentifiers = {
  readonly workspaceId: WorkspaceId;
  readonly revisionId: WorkspaceRevisionId;
};

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(value);
}

function assertId(value: unknown): asserts value is string {
  resourceInvariant(validId(value), "INVALID_REQUEST", "Resource 命令 ID 格式无效");
}

function assertReturnedId(value: unknown): asserts value is string {
  externalResultInvariant(validId(value), "CONTENT_INTEGRITY_ERROR", "Resource 目录 ID 格式无效");
}

function isStrictlyAfterPosition(
  item: { readonly updatedAt: string; readonly resourceId: string },
  after: { readonly updatedAt: string; readonly resourceId: string },
): boolean {
  const itemTime = Date.parse(item.updatedAt);
  const afterTime = Date.parse(after.updatedAt);
  if (Number.isNaN(itemTime) || Number.isNaN(afterTime)) return false;
  return itemTime < afterTime || (itemTime === afterTime && item.resourceId < after.resourceId);
}

async function callExternalPort<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    // 不保留 cause，避免 SQL、对象键、签名 URL 或供应商响应进入日志/HTTP。
    throw new ResourceServiceError("DEPENDENCY_FAILURE", "Resource 依赖操作失败");
  }
}

function validateExternalResult<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    // 只保留本服务在校验过程中亲自创建的错误。外部 Getter/Proxy 即使抛出
    // ResourceServiceError，也不能借此穿透 SQL、objectKey 或供应商响应。
    if (
      typeof error === "object" &&
      error !== null &&
      internalExternalResultValidationErrors.has(error)
    ) {
      throw error;
    }
    throw new ResourceServiceError("DEPENDENCY_FAILURE", "Resource 依赖操作失败");
  }
}

const internalExternalResultValidationErrors = new WeakSet<object>();

function externalResultInvariant(
  condition: unknown,
  code: ResourceErrorCode,
  message: string,
): asserts condition {
  if (condition) return;
  const error = new ResourceServiceError(code, message);
  internalExternalResultValidationErrors.add(error);
  throw error;
}

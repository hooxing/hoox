import type {
  ResourceId,
  ResourceVersionId,
  WorkspaceId,
  WorkspaceRevisionId,
} from "@cube-runtime/domain";
import type {
  AgentResourceAccessScope,
  PromoteResourceRequest,
  PromoteResourceRequestResult,
  ResourceAccessScope,
  ResourceCatalog,
  ResourceContentReader,
  ResourceCursorCodec,
  ResourceImportPlanResult,
  ResourcePreviewResult,
  ResourceSearchItem,
  ResourceSearchResult,
  WorkspaceImportTargetInspector,
  WorkspacePromotionAuthorizer,
} from "./contracts.js";
import { ResourceServiceError, resourceInvariant } from "./errors.js";
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
    readonly scope: ResourceAccessScope;
    readonly query?: string;
    readonly pageSize?: number;
    readonly cursor?: string;
  }): Promise<ResourceSearchResult> {
    assertScope(input.scope);
    const normalizedQuery = normalizeSearchQuery(input.query ?? "", this.maxQueryBytes);
    const limit = normalizePageSize(input.pageSize, this.defaultPageSize, this.maxPageSize);
    const after =
      input.cursor === undefined
        ? undefined
        : this.dependencies.cursorCodec.decode({
            scope: input.scope,
            normalizedQuery,
            cursor: input.cursor,
          });
    const page = await this.dependencies.catalog.search({
      scope: input.scope,
      normalizedQuery,
      limit,
      ...(after === undefined ? {} : { after }),
    });
    validateCatalogPage(page.items, page.nextPosition, limit);
    const nextCursor =
      page.nextPosition === undefined
        ? undefined
        : this.dependencies.cursorCodec.encode({
            scope: input.scope,
            normalizedQuery,
            position: page.nextPosition,
          });
    return Object.freeze({
      // 显式投影白名单字段，防止目录适配器意外把 objectKey 等内部字段带到公开结果。
      items: Object.freeze(page.items.map(projectSearchItem)),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    });
  }

  async preview(input: {
    readonly scope: ResourceAccessScope;
    readonly resourceId: ResourceId;
    readonly versionId: ResourceVersionId;
    readonly offset?: number;
    readonly length?: number;
  }): Promise<ResourcePreviewResult> {
    assertScope(input.scope);
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
    const bytes = await this.dependencies.contentReader.readRange({
      scope: input.scope,
      version: resolved.version,
      range: { offset, length: boundedLength },
    });
    resourceInvariant(
      bytes instanceof Uint8Array && bytes.byteLength <= boundedLength,
      "CONTENT_INTEGRITY_ERROR",
      "Resource 内容读取超过授权字节范围",
    );
    return Object.freeze({
      status: "available",
      resourceId: resolved.resource.id,
      versionId: resolved.version.id,
      mediaType,
      range: Object.freeze({ offset, length: bytes.byteLength }),
      totalSizeBytes: resolved.version.sizeBytes,
      truncated: offset + bytes.byteLength < resolved.version.sizeBytes,
      bytes: new Uint8Array(bytes),
    });
  }

  async planImport(input: {
    readonly scope: ResourceAccessScope;
    readonly resourceId: ResourceId;
    readonly versionId: ResourceVersionId;
    readonly targetWorkspaceId: WorkspaceId;
    readonly targetPath: string;
    readonly conflictPolicy?: "reject";
  }): Promise<ResourceImportPlanResult> {
    assertScope(input.scope);
    resourceInvariant(
      input.conflictPolicy === undefined || input.conflictPolicy === "reject",
      "INVALID_REQUEST",
      "首版 Resource 导入禁止覆盖目标文件",
    );
    const safeRelativePath = normalizeWorkspaceRelativePath(input.targetPath);
    const resolved = await this.resolveCanonicalVersion(input);
    if (resolved.status === "not_found") return Object.freeze({ status: "not_found" });
    const target = await this.dependencies.importTargets.inspect({
      scope: input.scope,
      workspaceId: input.targetWorkspaceId,
      safeRelativePath,
    });
    if (target.status === "not_found") return Object.freeze({ status: "not_found" });
    if (target.status === "occupied") return Object.freeze({ status: "target_conflict" });
    resourceInvariant(
      target.status === "available",
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
    readonly scope: AgentResourceAccessScope;
    readonly command: PromoteResourceRequest;
  }): Promise<PromoteResourceRequestResult> {
    assertScope(input.scope);
    if (input.scope.actor?.kind !== "agent") {
      return Object.freeze({ status: "not_authorized" });
    }
    const resourceName = assertResourceName(input.command.resourceName);
    const safeRelativePath = normalizeWorkspaceRelativePath(input.command.relativePath);
    const outcome = await this.dependencies.promotionAuthorizer.authorizeSnapshot({
      scope: input.scope,
      workspaceId: input.command.workspaceId,
      revisionId: input.command.revisionId,
      safeRelativePath,
    });
    if (outcome.status === "not_found" || outcome.status === "not_authorized") {
      return Object.freeze({ status: outcome.status });
    }
    resourceInvariant(
      outcome.status === "authorized",
      "CONTENT_INTEGRITY_ERROR",
      "提升授权结果格式无效",
    );
    const authorization = outcome.authorization;
    resourceInvariant(
      authorization.tenantId === input.scope.tenantId &&
        authorization.workspaceId === input.command.workspaceId &&
        authorization.revisionId === input.command.revisionId &&
        authorization.relativePath === safeRelativePath,
      "NOT_AUTHORIZED",
      "提升授权与可信执行范围不一致",
    );
    resourceInvariant(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{15,254}$/u.test(authorization.authorizationId) &&
        /^[a-f0-9]{64}$/u.test(authorization.digest) &&
        Number.isSafeInteger(authorization.sizeBytes) &&
        authorization.sizeBytes >= 0 &&
        isCanonicalIsoTimestamp(authorization.expiresAt),
      "CONTENT_INTEGRITY_ERROR",
      "提升授权快照格式无效",
    );
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
    const normalizedAuthorization = Object.freeze({
      authorizationId: authorization.authorizationId,
      tenantId: authorization.tenantId,
      workspaceId: authorization.workspaceId,
      revisionId: authorization.revisionId,
      relativePath: authorization.relativePath,
      digest: authorization.digest,
      mediaType: normalizeMediaType(authorization.mediaType),
      sizeBytes: authorization.sizeBytes,
      expiresAt: authorization.expiresAt,
    });
    return Object.freeze({
      status: "authorized",
      request: Object.freeze({
        kind: "promote_resource",
        resourceName,
        origin: "promoted_workspace",
        source: normalizedAuthorization,
        catalogVisibility: "pending_explicit_commit",
      }),
    });
  }

  private async resolveCanonicalVersion(input: {
    readonly scope: ResourceAccessScope;
    readonly resourceId: ResourceId;
    readonly versionId: ResourceVersionId;
  }) {
    const resolved = await this.dependencies.catalog.resolveVersion(input);
    if (resolved.status === "not_found") return resolved;
    resourceInvariant(
      resolved.status === "found",
      "CONTENT_INTEGRITY_ERROR",
      "Resource 版本解析结果格式无效",
    );
    resourceInvariant(
      resolved.resource.tenantId === input.scope.tenantId &&
        resolved.version.tenantId === input.scope.tenantId &&
        resolved.resource.id === input.resourceId &&
        resolved.version.resourceId === input.resourceId &&
        resolved.version.id === input.versionId,
      "NOT_AUTHORIZED",
      "Resource 版本授权结果与请求不一致",
    );
    resourceInvariant(
      Number.isSafeInteger(resolved.version.versionNumber) &&
        resolved.version.versionNumber >= 1 &&
        Number.isSafeInteger(resolved.version.sizeBytes) &&
        resolved.version.sizeBytes >= 0 &&
        /^[a-f0-9]{64}$/u.test(resolved.version.digest) &&
        resolved.version.objectKey.trim().length > 0,
      "CONTENT_INTEGRITY_ERROR",
      "Resource 版本元数据无效",
    );
    return resolved;
  }
}

export function normalizeSearchQuery(value: string, maxBytes = 256): string {
  resourceInvariant(typeof value === "string", "INVALID_REQUEST", "Resource 查询格式无效");
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
  items: readonly ResourceSearchItem[],
  nextPosition: { readonly updatedAt: string; readonly resourceId: string } | undefined,
  limit: number,
): void {
  resourceInvariant(
    items.length <= limit,
    "CONTENT_INTEGRITY_ERROR",
    "Resource 目录返回超出页大小",
  );
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const current = items[index];
    resourceInvariant(
      previous !== undefined && current !== undefined,
      "CONTENT_INTEGRITY_ERROR",
      "Resource 目录页无效",
    );
    const previousTime = Date.parse(previous.updatedAt);
    const currentTime = Date.parse(current.updatedAt);
    resourceInvariant(
      !Number.isNaN(previousTime) && !Number.isNaN(currentTime),
      "CONTENT_INTEGRITY_ERROR",
      "Resource 目录时间格式无效",
    );
    const ordered =
      previousTime > currentTime ||
      (previousTime === currentTime && previous.resourceId > current.resourceId);
    resourceInvariant(ordered, "CONTENT_INTEGRITY_ERROR", "Resource 目录排序不稳定");
  }
  if (nextPosition !== undefined) {
    const last = items.at(-1);
    resourceInvariant(
      last !== undefined &&
        last.updatedAt === nextPosition.updatedAt &&
        last.resourceId === nextPosition.resourceId,
      "CONTENT_INTEGRITY_ERROR",
      "Resource 目录游标位置无效",
    );
  }
}

function projectSearchItem(item: ResourceSearchItem): ResourceSearchItem {
  const normalizedName = item.name.normalize("NFKC").trim();
  resourceInvariant(
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
  resourceInvariant(
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(mediaType),
    "CONTENT_INTEGRITY_ERROR",
    "Resource 媒体类型无效",
  );
  return mediaType;
}

function assertScope(scope: ResourceAccessScope): void {
  resourceInvariant(
    typeof scope === "object" &&
      scope !== null &&
      typeof scope.tenantId === "string" &&
      scope.tenantId.length >= 3 &&
      typeof scope.userId === "string" &&
      scope.userId.length >= 3,
    "NOT_AUTHORIZED",
    "缺少可信 Resource 访问范围",
  );
}

function containsControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
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

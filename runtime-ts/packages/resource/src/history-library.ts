import type { TenantId } from "@hoox/domain";
import type { TrustedResourceContext } from "./contracts.js";
import { ResourceServiceError, resourceInvariant } from "./errors.js";
import type { ResourceFilesystemStoredObject } from "./resource-filesystem.js";

export const DEFAULT_HISTORY_FILE_WINDOW_MONTHS = 6;
export const DEFAULT_HISTORY_FILE_PAGE_LIMIT = 24;
export const MAX_HISTORY_FILE_PAGE_LIMIT = 50;

export interface HistoryFileLibraryFile {
  readonly threadId: string;
  readonly taskName: string;
  readonly resourceId: string;
  readonly versionId: string;
  readonly name: string;
  readonly entryName: string;
  readonly path: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly attachedAt: string;
  readonly object: ResourceFilesystemStoredObject;
}

export interface HistoryFileLibraryTask {
  readonly threadId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastFileAt: string;
  readonly fileCount: number;
  readonly files: readonly HistoryFileLibraryFile[];
}

export interface HistoryFileLibraryCursor {
  readonly lastFileAt: string;
  readonly threadId: string;
}

export interface HistoryFileLibraryPage {
  readonly items: readonly HistoryFileLibraryTask[];
  readonly range: Readonly<{ activeAfter?: string; activeBefore?: string }>;
  readonly hasMore: boolean;
  readonly hasOlder: boolean;
  readonly next?: HistoryFileLibraryCursor;
}

export interface HistoryFileLibraryCatalog {
  listTaskPage(input: {
    readonly tenantId: TenantId;
    readonly query: string;
    readonly activeAfter?: string;
    readonly activeBefore?: string;
    readonly before?: HistoryFileLibraryCursor;
    readonly limit: number;
  }): Promise<HistoryFileLibraryPage | undefined>;
  resolveLibraryFile(input: {
    readonly tenantId: TenantId;
    readonly resourceId: string;
    readonly versionId: string;
  }): Promise<HistoryFileLibraryFile | undefined>;
}

export interface ListHistoryFilesInput {
  readonly context: TrustedResourceContext;
  readonly query?: string;
  readonly activeAfter?: string;
  readonly activeBefore?: string;
  readonly before?: HistoryFileLibraryCursor;
  readonly limit?: number;
}

export class HistoryFileLibraryService {
  constructor(
    private readonly catalog: HistoryFileLibraryCatalog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(input: ListHistoryFilesInput): Promise<HistoryFileLibraryPage> {
    assertContext(input.context);
    const query = normalizeQuery(input.query);
    const activeBefore = optionalTimestamp(input.activeBefore, "历史文件结束时间无效");
    const activeAfter =
      optionalTimestamp(input.activeAfter, "历史文件开始时间无效") ??
      (activeBefore === undefined ? sixMonthsBefore(this.now()) : undefined);
    if (activeAfter !== undefined && activeBefore !== undefined) {
      resourceInvariant(
        Date.parse(activeAfter) < Date.parse(activeBefore),
        "INVALID_REQUEST",
        "历史文件时间范围无效",
      );
    }
    const before = normalizeCursor(input.before);
    const limit = input.limit ?? DEFAULT_HISTORY_FILE_PAGE_LIMIT;
    resourceInvariant(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_HISTORY_FILE_PAGE_LIMIT,
      "INVALID_REQUEST",
      "历史文件分页大小无效",
    );
    const page = await this.catalog.listTaskPage({
      tenantId: input.context.tenantId,
      query,
      ...(activeAfter === undefined ? {} : { activeAfter }),
      ...(activeBefore === undefined ? {} : { activeBefore }),
      ...(before === undefined ? {} : { before }),
      limit,
    });
    if (page === undefined) {
      throw new ResourceServiceError("NOT_FOUND", "当前空间不支持历史文件");
    }
    return page;
  }

  async resolve(input: {
    readonly context: TrustedResourceContext;
    readonly resourceId: string;
    readonly versionId: string;
  }): Promise<HistoryFileLibraryFile> {
    assertContext(input.context);
    assertId(input.resourceId, "历史文件 Resource ID 无效");
    assertId(input.versionId, "历史文件版本 ID 无效");
    const file = await this.catalog.resolveLibraryFile({
      tenantId: input.context.tenantId,
      resourceId: input.resourceId,
      versionId: input.versionId,
    });
    if (file === undefined) throw new ResourceServiceError("NOT_FOUND", "历史文件不存在");
    return file;
  }
}

function sixMonthsBefore(now: Date): string {
  const value = new Date(now.getTime());
  resourceInvariant(!Number.isNaN(value.getTime()), "INVALID_REQUEST", "当前时间无效");
  value.setUTCMonth(value.getUTCMonth() - DEFAULT_HISTORY_FILE_WINDOW_MONTHS);
  return value.toISOString();
}

function optionalTimestamp(value: string | undefined, message: string): string | undefined {
  if (value === undefined) return undefined;
  resourceInvariant(isCanonicalTimestamp(value), "INVALID_REQUEST", message);
  return new Date(value).toISOString();
}

function normalizeCursor(
  value: HistoryFileLibraryCursor | undefined,
): HistoryFileLibraryCursor | undefined {
  if (value === undefined) return undefined;
  resourceInvariant(
    isCanonicalTimestamp(value.lastFileAt),
    "INVALID_REQUEST",
    "历史文件分页游标时间无效",
  );
  assertId(value.threadId, "历史文件分页游标任务无效");
  return Object.freeze({
    lastFileAt: new Date(value.lastFileAt).toISOString(),
    threadId: value.threadId,
  });
}

function normalizeQuery(value: string | undefined): string {
  const normalized = (value ?? "").replace(/\s+/gu, " ").trim();
  resourceInvariant(
    Array.from(normalized).length <= 120 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(normalized),
    "INVALID_REQUEST",
    "历史文件搜索条件无效",
  );
  return normalized;
}

function assertContext(context: TrustedResourceContext): void {
  resourceInvariant(
    typeof context === "object" &&
      context !== null &&
      validId(context.tenantId) &&
      validId(context.userId),
    "NOT_AUTHORIZED",
    "缺少有效的历史文件认证上下文",
  );
}

function assertId(value: string, message: string): void {
  resourceInvariant(validId(value), "INVALID_REQUEST", message);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(value);
}

function isCanonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const normalized = value.includes(".") ? value : value.replace(/Z$/u, ".000Z");
  return parsed.toISOString() === normalized;
}

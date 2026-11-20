import { adminAuthorizationHeader } from "./admin-session.js";
import { AdminApiError } from "./api.js";

export const runStatuses = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof runStatuses)[number];
export const runOrigins = ["normal", "playground", "evaluation", "api"] as const;
export type RunOrigin = (typeof runOrigins)[number];

export interface RunUsageDto {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly generationDurationMs: number;
}

export interface RunSummaryDto {
  readonly tenantId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly agentDefinitionId: string | null;
  readonly agentRevisionId: string | null;
  readonly origin: string | null;
  readonly attemptCount: number;
  readonly latestAttemptId?: string;
  readonly latestAttemptStatus?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly failedToolCalls: number;
  readonly errorCount: number;
  readonly usage: RunUsageDto;
}

export interface RunAttemptDto {
  readonly attemptId: string;
  readonly status: string;
  readonly stage: string;
  readonly createdAt: string;
  readonly finishedAt?: string;
}

export interface RunTimelineRecordDto {
  readonly id: string;
  readonly sequence: number;
  readonly endSequence: number;
  readonly step?: number;
  readonly kind: string;
  readonly event: string;
  readonly summary: string;
  readonly status: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface RunTimelineDto {
  readonly records: readonly RunTimelineRecordDto[];
  readonly stats: {
    readonly eventCount: number;
    readonly recordCount: number;
    readonly modelSteps: number;
    readonly toolCalls: number;
    readonly failedToolCalls: number;
    readonly errors: number;
    readonly durationMs?: number;
  };
}

export interface RunPageDto {
  readonly items: readonly RunSummaryDto[];
  readonly nextCursor?: string;
  readonly contentAccess: boolean;
}

export interface RunDetailDto {
  readonly run: RunSummaryDto & { readonly attempts: readonly RunAttemptDto[] };
  readonly attemptId?: string;
  readonly timeline: RunTimelineDto;
  readonly contentAccess: boolean;
}

export interface RunContentDto extends RunDetailDto {
  readonly auditId: string;
}

export interface RunListFilters {
  readonly tenantId?: string;
  readonly status?: RunStatus;
  readonly createdFrom?: string;
  readonly createdTo?: string;
  readonly agentDefinitionId?: string;
  readonly agentRevisionId?: string;
  readonly origin?: RunOrigin;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface RunExplorerApiContract {
  listRuns(filters: RunListFilters): Promise<RunPageDto>;
  getRun(tenantId: string, runId: string, attemptId?: string): Promise<RunDetailDto>;
  /** 每次调用都会在服务端写入一条正文访问审计；结果不得进入跨页面缓存。 */
  readRunContent(tenantId: string, runId: string, attemptId?: string): Promise<RunContentDto>;
}

function messageFor(status: number): string {
  if (status === 400) return "筛选条件不符合要求，请检查后重试。";
  if (status === 401 || status === 403) return "当前账号没有执行该操作的权限。";
  if (status === 404) return "Run 不存在或已不可访问。";
  return "后台控制服务暂时不可用，请稍后重试。";
}

export class RunExplorerApi implements RunExplorerApiContract {
  constructor(
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
    private readonly baseUrl = "/v1/admin/control",
    private readonly authorizationHeader: () => string | undefined = adminAuthorizationHeader,
  ) {}

  listRuns(filters: RunListFilters): Promise<RunPageDto> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    return this.request(`/runs${suffix}`);
  }

  getRun(tenantId: string, runId: string, attemptId?: string): Promise<RunDetailDto> {
    return this.request(`${runPath(tenantId, runId)}${attemptQuery(attemptId)}`);
  }

  readRunContent(tenantId: string, runId: string, attemptId?: string): Promise<RunContentDto> {
    return this.request(`${runPath(tenantId, runId)}/content${attemptQuery(attemptId)}`);
  }

  private async request<T>(path: string): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });
    const authorization = this.authorizationHeader();
    if (authorization !== undefined) headers.set("Authorization", authorization);
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers,
      });
    } catch {
      throw new AdminApiError("无法连接后台控制服务。", 0, true);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new AdminApiError(messageFor(response.status), response.status, response.status >= 500);
    }
    if (typeof body !== "object" || body === null || !("data" in body)) {
      throw new AdminApiError("后台控制服务返回了无法识别的数据。", 502, true);
    }
    return (body as { readonly data: T }).data;
  }
}

function runPath(tenantId: string, runId: string): string {
  return `/runs/${encodeURIComponent(tenantId)}/${encodeURIComponent(runId)}`;
}

function attemptQuery(attemptId: string | undefined): string {
  return attemptId === undefined ? "" : `?attemptId=${encodeURIComponent(attemptId)}`;
}

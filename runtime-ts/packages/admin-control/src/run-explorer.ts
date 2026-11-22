import type { RuntimeEventV1 } from "@hoox/run-contracts";
import {
  type ObservedRuntimeEvent,
  outlineTrajectory,
  projectTrajectory,
  type InternalTrajectoryEventV1,
  type TrajectoryProjection,
} from "@hoox/trajectory";

/** 与 `ControlOperatorRole` 相同；这里单独声明以避免与主模块形成循环导入。 */
type OperatorRole = "viewer" | "operator" | "admin";

export const RUN_EXPLORER_STATUSES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type RunExplorerStatus = (typeof RUN_EXPLORER_STATUSES)[number];

/** Run 来源；对应事实落库前所有 Run 的来源均为 null。 */
export const RUN_EXPLORER_ORIGINS = ["normal", "playground", "evaluation", "api"] as const;
export type RunExplorerOrigin = (typeof RUN_EXPLORER_ORIGINS)[number];

/**
 * 正文能力只授予 `admin`；数据库正文视图按同一规则独立校验。非管理员返回结构视图。
 */
export type ControlCapability = "run_structure.read" | "run_content.read";

const capabilityMatrix: Readonly<Record<OperatorRole, readonly ControlCapability[]>> = {
  viewer: ["run_structure.read"],
  operator: ["run_structure.read"],
  admin: ["run_structure.read", "run_content.read"],
};

export function controlCapabilities(role: OperatorRole | undefined): readonly ControlCapability[] {
  return role === undefined ? [] : capabilityMatrix[role];
}

export interface RunExplorerQuery {
  readonly tenantId?: string;
  readonly status?: RunExplorerStatus;
  readonly createdFrom?: string;
  readonly createdTo?: string;
  readonly agentDefinitionId?: string;
  readonly agentRevisionId?: string;
  readonly origin?: RunExplorerOrigin;
  readonly search?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface RunExplorerCursor {
  readonly createdAt: string;
  readonly tenantId: string;
  readonly runId: string;
}

export interface RunExplorerAttempt {
  readonly attemptId: string;
  readonly status: string;
  readonly stage: string;
  readonly createdAt: string;
  readonly finishedAt?: string;
}

export interface RunExplorerUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly generationDurationMs: number;
}

/** Run 目录投影。正文字段只在管理员响应中填充；其他角色由服务层清空。 */
export interface RunExplorerSummary {
  readonly tenantId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly userInput?: string;
  readonly userEmail?: string;
  readonly userDisplayName?: string;
  readonly agentDisplayName?: string;
  readonly status: RunExplorerStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly agentDefinitionId: string | null;
  readonly agentRevisionId: string | null;
  readonly origin: RunExplorerOrigin | null;
  readonly attemptCount: number;
  readonly latestAttemptId?: string;
  readonly latestAttemptStatus?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** Run 创建到最新 Attempt 结束的端到端耗时，包含排队；未结束时缺省。 */
  readonly durationMs?: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly failedToolCalls: number;
  readonly errorCount: number;
  readonly usage: RunExplorerUsage;
}

export interface RunExplorerRunRecord extends RunExplorerSummary {
  readonly attempts: readonly RunExplorerAttempt[];
}

export interface RunExplorerEventRow {
  readonly attemptId: string;
  readonly sequence: number;
  readonly kind: string;
  readonly occurredAt: string;
  readonly payload: unknown;
}

export interface RunExplorerPage {
  readonly items: readonly RunExplorerSummary[];
  readonly nextCursor?: string;
  readonly contentAccess: boolean;
}

export interface RunExplorerDetail {
  readonly run: RunExplorerRunRecord;
  readonly attemptId?: string;
  readonly timeline: TrajectoryProjection;
  /** 是否为正文读取已审计的管理员详情；接口每次读取均重新授权。 */
  readonly contentAccess: boolean;
  readonly auditId?: string;
}

export interface RunExplorerContent extends RunExplorerDetail {
  readonly auditId: string;
}

export interface RunExplorerRepository {
  resolveRole(userId: string): Promise<OperatorRole | undefined>;
  listRuns(input: {
    readonly actorUserId: string;
    readonly tenantId?: string;
    readonly status?: RunExplorerStatus;
    readonly createdFrom?: string;
    readonly createdTo?: string;
    readonly agentDefinitionId?: string;
    readonly agentRevisionId?: string;
    readonly origin?: RunExplorerOrigin;
    readonly search?: string;
    readonly after?: RunExplorerCursor;
    readonly limit: number;
    readonly audit?: {
      readonly auditId: string;
      readonly querySummary: Readonly<Record<string, unknown>>;
    };
  }): Promise<readonly RunExplorerSummary[]>;
  getRun(input: {
    readonly actorUserId: string;
    readonly tenantId: string;
    readonly runId: string;
    readonly inputAuditId?: string;
  }): Promise<RunExplorerRunRecord | undefined>;
  /** 读取正文已在数据库内剥离的事件结构。 */
  readOutline(input: {
    readonly actorUserId: string;
    readonly tenantId: string;
    readonly runId: string;
    readonly attemptId: string;
  }): Promise<readonly RunExplorerEventRow[]>;
  /**
   * 在同一事务中先写入正文访问审计再读取正文。审计写入失败或操作者不再是有效 admin 时
   * 必须抛错或返回空结果，不能返回正文。
   */
  readContent(input: {
    readonly actorUserId: string;
    readonly tenantId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly auditId: string;
  }): Promise<readonly RunExplorerEventRow[]>;
}

export interface RunTrajectoryReaderPort {
  readPage(input: {
    readonly actorUserId: string;
    readonly auditId: string;
    readonly tenantId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly limit: number;
    readonly afterCursor?: Readonly<{
      occurredAt: string;
      agentThreadId: string;
      sequence: number;
    }>;
  }): Promise<{
    readonly records: readonly (InternalTrajectoryEventV1 & { readonly agentThreadId: string })[];
    readonly hasMore: boolean;
    readonly nextCursor?: string;
    readonly bytes: number;
  }>;
}

export interface RunTrajectoryPage {
  readonly events: readonly (InternalTrajectoryEventV1 & { readonly agentThreadId: string })[];
  readonly bytes: number;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export class RunExplorerError extends Error {
  constructor(readonly code: "NOT_AUTHORIZED" | "NOT_FOUND" | "UNAVAILABLE") {
    super(code);
    this.name = "RunExplorerError";
  }
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;

function identifier(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!identifierPattern.test(value)) throw new TypeError(`${name} 格式无效`);
  return value;
}

function isoTimestamp(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} 不是有效时间`);
  return new Date(parsed).toISOString();
}

export function encodeRunExplorerCursor(cursor: RunExplorerCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.tenantId, cursor.runId])).toString(
    "base64url",
  );
}

export function decodeRunExplorerCursor(value: string): RunExplorerCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed.every((item) => typeof item === "string")
    ) {
      const [createdAt, tenantId, runId] = parsed as [string, string, string];
      identifier(tenantId, "游标 Tenant");
      identifier(runId, "游标 Run");
      return { createdAt: isoTimestamp(createdAt, "游标时间") ?? createdAt, tenantId, runId };
    }
  } catch {
    // 统一按无效游标处理，不回显原值。
  }
  throw new TypeError("分页游标无效");
}

function observedEvents(rows: readonly RunExplorerEventRow[]): ObservedRuntimeEvent[] {
  return rows.map((row) => ({
    // 行来自受约束的 run_events；投影对未知类型与缺失字段按无操作处理。
    event: {
      schemaVersion: 1,
      kind: row.kind,
      sequence: row.sequence,
      payload: row.payload,
    } as RuntimeEventV1,
    observedAt: row.occurredAt,
  }));
}

function selectAttempt(run: RunExplorerRunRecord, attemptId: string | undefined) {
  if (attemptId === undefined) return run.latestAttemptId;
  if (!run.attempts.some((attempt) => attempt.attemptId === attemptId))
    throw new RunExplorerError("NOT_FOUND");
  return attemptId;
}

function redactRunInput<T extends RunExplorerSummary>(run: T): T {
  const { threadTitle: _threadTitle, userInput: _userInput, ...safe } = run;
  return {
    ...safe,
    threadTitle: "",
    ...("attempts" in run ? { attempts: run.attempts } : {}),
  } as T;
}

const emptyTimeline: TrajectoryProjection = Object.freeze({
  records: Object.freeze([]),
  stats: Object.freeze({
    eventCount: 0,
    recordCount: 0,
    modelSteps: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    errors: 0,
  }),
});

/**
 * 后台 Run 浏览器。列表与结构详情对有效控制面角色开放；问题与正文仅向 admin 返回，
 * 且管理员详情每次读取均写入审计。数据来自持久 Run 视图与事件。
 */
export class RunExplorerService {
  constructor(
    private readonly repository: RunExplorerRepository,
    private readonly auditId: () => string,
    private readonly trajectories?: RunTrajectoryReaderPort,
  ) {}

  private async capabilities(actorUserId: string): Promise<readonly ControlCapability[]> {
    const capabilities = controlCapabilities(await this.repository.resolveRole(actorUserId));
    if (!capabilities.includes("run_structure.read")) throw new RunExplorerError("NOT_AUTHORIZED");
    return capabilities;
  }

  async listRuns(actorUserId: string, query: RunExplorerQuery = {}): Promise<RunExplorerPage> {
    const capabilities = await this.capabilities(actorUserId);
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new TypeError("Run 条数无效");
    if (query.status !== undefined && !RUN_EXPLORER_STATUSES.includes(query.status))
      throw new TypeError("Run 状态无效");
    if (query.origin !== undefined && !RUN_EXPLORER_ORIGINS.includes(query.origin))
      throw new TypeError("Run 来源无效");
    const createdFrom = isoTimestamp(query.createdFrom, "开始时间");
    const createdTo = isoTimestamp(query.createdTo, "结束时间");
    if (createdFrom !== undefined && createdTo !== undefined && createdFrom > createdTo)
      throw new TypeError("时间范围无效");
    const tenantId = identifier(query.tenantId, "Tenant");
    const agentDefinitionId = identifier(query.agentDefinitionId, "AgentDefinition");
    const agentRevisionId = identifier(query.agentRevisionId, "Revision");
    const search = query.search?.trim();
    if (search !== undefined && search.length > 200) throw new TypeError("关键词过长");
    const auditId = capabilities.includes("run_content.read") ? this.auditId() : undefined;
    const rows = await this.repository.listRuns({
      actorUserId,
      ...(tenantId === undefined ? {} : { tenantId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(createdFrom === undefined ? {} : { createdFrom }),
      ...(createdTo === undefined ? {} : { createdTo }),
      ...(agentDefinitionId === undefined ? {} : { agentDefinitionId }),
      ...(agentRevisionId === undefined ? {} : { agentRevisionId }),
      ...(query.origin === undefined ? {} : { origin: query.origin }),
      ...(search === undefined || search.length === 0 ? {} : { search }),
      ...(query.cursor === undefined ? {} : { after: decodeRunExplorerCursor(query.cursor) }),
      limit: limit + 1,
      ...(auditId === undefined
        ? {}
        : {
            audit: {
              auditId,
              querySummary: {
                tenantId: tenantId ?? null,
                status: query.status ?? null,
                createdFrom: createdFrom ?? null,
                createdTo: createdTo ?? null,
                agentDefinitionId: agentDefinitionId ?? null,
                agentRevisionId: agentRevisionId ?? null,
                origin: query.origin ?? null,
                search: search ?? null,
                cursor: query.cursor === undefined ? null : "provided",
                limit,
              },
            },
          }),
    });
    const items = rows
      .slice(0, limit)
      .map((run) => (capabilities.includes("run_content.read") ? run : redactRunInput(run)));
    const last = items.at(-1);
    return Object.freeze({
      items: Object.freeze(items),
      ...(rows.length > limit && last !== undefined
        ? {
            nextCursor: encodeRunExplorerCursor({
              createdAt: last.createdAt,
              tenantId: last.tenantId,
              runId: last.runId,
            }),
          }
        : {}),
      contentAccess: capabilities.includes("run_content.read"),
    });
  }

  private async requireRun(
    actorUserId: string,
    tenantId: string,
    runId: string,
    inputAuditId?: string,
  ) {
    const run = await this.repository.getRun({
      actorUserId,
      tenantId: identifier(tenantId, "Tenant") ?? tenantId,
      runId: identifier(runId, "Run") ?? runId,
      ...(inputAuditId === undefined ? {} : { inputAuditId }),
    });
    if (run === undefined) throw new RunExplorerError("NOT_FOUND");
    return run;
  }

  /** 管理员直接取得完整详情；其他角色仅取得经过 outlineTrajectory 的结构时间线。 */
  async getRunDetail(
    actorUserId: string,
    tenantId: string,
    runId: string,
    attemptId?: string,
  ): Promise<RunExplorerDetail> {
    const capabilities = await this.capabilities(actorUserId);
    const inputAuditId = capabilities.includes("run_content.read") ? this.auditId() : undefined;
    const run = await this.requireRun(actorUserId, tenantId, runId, inputAuditId);
    const selected = selectAttempt(run, identifier(attemptId, "Attempt"));
    const timeline =
      selected === undefined
        ? emptyTimeline
        : outlineTrajectory(
            projectTrajectory(
              observedEvents(
                await this.repository.readOutline({
                  actorUserId,
                  tenantId: run.tenantId,
                  runId: run.runId,
                  attemptId: selected,
                }),
              ),
            ),
          );
    if (capabilities.includes("run_content.read") && selected !== undefined) {
      const content = await this.readRunContent(actorUserId, run.tenantId, run.runId, selected);
      return Object.freeze({ ...content });
    }
    return Object.freeze({
      run: capabilities.includes("run_content.read") ? run : redactRunInput(run),
      ...(selected === undefined ? {} : { attemptId: selected }),
      timeline,
      contentAccess: capabilities.includes("run_content.read"),
    });
  }

  /** 正文详情：要求 `run_content.read`，每次调用都在读取事务中写入一条正文访问审计。 */
  async readRunContent(
    actorUserId: string,
    tenantId: string,
    runId: string,
    attemptId?: string,
  ): Promise<RunExplorerContent> {
    const capabilities = await this.capabilities(actorUserId);
    if (!capabilities.includes("run_content.read")) throw new RunExplorerError("NOT_AUTHORIZED");
    const run = await this.requireRun(actorUserId, tenantId, runId, this.auditId());
    const selected = selectAttempt(run, identifier(attemptId, "Attempt"));
    if (selected === undefined) throw new RunExplorerError("NOT_FOUND");
    const auditId = this.auditId();
    const rows = await this.repository.readContent({
      actorUserId,
      tenantId: run.tenantId,
      runId: run.runId,
      attemptId: selected,
      auditId,
    });
    return Object.freeze({
      run,
      attemptId: selected,
      timeline: projectTrajectory(observedEvents(rows)),
      contentAccess: true,
      auditId,
    });
  }

  async readTrajectory(
    actorUserId: string,
    tenantId: string,
    runId: string,
    attemptId: string,
    cursor?: string,
  ): Promise<RunTrajectoryPage> {
    const capabilities = await this.capabilities(actorUserId);
    if (!capabilities.includes("run_content.read")) throw new RunExplorerError("NOT_AUTHORIZED");
    if (this.trajectories === undefined) throw new RunExplorerError("UNAVAILABLE");
    const run = await this.requireRun(actorUserId, tenantId, runId, this.auditId());
    const selected = selectAttempt(run, identifier(attemptId, "Attempt"));
    if (selected === undefined) throw new RunExplorerError("NOT_FOUND");
    const afterCursor = decodeTrajectoryCursor(cursor);
    const page = await this.trajectories.readPage({
      actorUserId,
      auditId: this.auditId(),
      tenantId: run.tenantId,
      runId: run.runId,
      attemptId: selected,
      limit: 100,
      ...(afterCursor === undefined ? {} : { afterCursor }),
    });
    return Object.freeze({
      events: page.records,
      bytes: page.bytes,
      hasMore: page.hasMore,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  }
}

function decodeTrajectoryCursor(value: string | undefined) {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "occurredAt" in parsed &&
      typeof parsed.occurredAt === "string" &&
      "agentThreadId" in parsed &&
      typeof parsed.agentThreadId === "string" &&
      "sequence" in parsed &&
      typeof parsed.sequence === "number" &&
      Number.isSafeInteger(parsed.sequence) &&
      parsed.sequence >= 0
    ) {
      return {
        occurredAt: isoTimestamp(parsed.occurredAt, "轨迹游标时间") as string,
        agentThreadId: parsed.agentThreadId,
        sequence: parsed.sequence,
      };
    }
  } catch {
    throw new TypeError("轨迹分页游标无效");
  }
  throw new TypeError("轨迹分页游标无效");
}

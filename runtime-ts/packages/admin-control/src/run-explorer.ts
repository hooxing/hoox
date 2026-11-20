import type { RuntimeEventV1 } from "@hoox/run-contracts";
import {
  type ObservedRuntimeEvent,
  outlineTrajectory,
  projectTrajectory,
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
 * 控制面权限位。`run_content.read` 是查看 Run 正文（Prompt、思考、回复、工具摘要与错误原文）
 * 的显式权限，当前只由 `admin` 角色持有；数据库正文视图按同一规则独立校验。
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

/** Run 结构摘要：只含标识、状态、时间与计数，不含 Thread 标题、输入或模型正文。 */
export interface RunExplorerSummary {
  readonly tenantId: string;
  readonly runId: string;
  readonly threadId: string;
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
  /** 当前操作者是否持有 `run_content.read`；只决定界面是否提供入口，正文接口仍独立授权。 */
  readonly contentAccess: boolean;
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
    readonly after?: RunExplorerCursor;
    readonly limit: number;
  }): Promise<readonly RunExplorerSummary[]>;
  getRun(input: {
    readonly actorUserId: string;
    readonly tenantId: string;
    readonly runId: string;
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

export class RunExplorerError extends Error {
  constructor(readonly code: "NOT_AUTHORIZED" | "NOT_FOUND") {
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
 * 后台 Run 浏览器。列表与结构详情对所有有效控制面角色开放；正文只经 `readContent` 返回，
 * 要求 `run_content.read` 且每次读取都写入审计。数据只来自 Run 表、持久事件与模型用量账本。
 */
export class RunExplorerService {
  constructor(
    private readonly repository: RunExplorerRepository,
    private readonly auditId: () => string,
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
    const rows = await this.repository.listRuns({
      actorUserId,
      ...(tenantId === undefined ? {} : { tenantId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(createdFrom === undefined ? {} : { createdFrom }),
      ...(createdTo === undefined ? {} : { createdTo }),
      ...(agentDefinitionId === undefined ? {} : { agentDefinitionId }),
      ...(agentRevisionId === undefined ? {} : { agentRevisionId }),
      ...(query.origin === undefined ? {} : { origin: query.origin }),
      ...(query.cursor === undefined ? {} : { after: decodeRunExplorerCursor(query.cursor) }),
      limit: limit + 1,
    });
    const items = rows.slice(0, limit);
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

  private async requireRun(actorUserId: string, tenantId: string, runId: string) {
    const run = await this.repository.getRun({
      actorUserId,
      tenantId: identifier(tenantId, "Tenant") ?? tenantId,
      runId: identifier(runId, "Run") ?? runId,
    });
    if (run === undefined) throw new RunExplorerError("NOT_FOUND");
    return run;
  }

  /** 结构详情：时间线经过 `outlineTrajectory`，不触发审计，也不返回任何正文。 */
  async getRunDetail(
    actorUserId: string,
    tenantId: string,
    runId: string,
    attemptId?: string,
  ): Promise<RunExplorerDetail> {
    const capabilities = await this.capabilities(actorUserId);
    const run = await this.requireRun(actorUserId, tenantId, runId);
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
    return Object.freeze({
      run,
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
    const run = await this.requireRun(actorUserId, tenantId, runId);
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
}

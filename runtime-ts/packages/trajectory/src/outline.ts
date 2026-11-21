import type { TrajectoryProjection, TrajectoryRecord } from "./index.js";

/**
 * 结构轨迹只保留时间线形状、类型、标识、枚举、计数与耗时，不包含任何用户或模型正文。
 * 摘要按记录类型重新生成，详情只保留白名单字段；输入即使是含正文的完整投影也不会泄漏。
 */
export function outlineTrajectory(projection: TrajectoryProjection): TrajectoryProjection {
  return {
    records: projection.records.map((record) => Object.freeze(outlineRecord(record))),
    stats: projection.stats,
  };
}

function pick(
  source: Readonly<Record<string, unknown>> | undefined,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (source === undefined) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      result[key] = value;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function nestedString(
  source: Readonly<Record<string, unknown>> | undefined,
  key: string,
  nestedKey: string,
): string | undefined {
  const value = source?.[key];
  if (typeof value !== "object" || value === null) return undefined;
  const nested = (value as Readonly<Record<string, unknown>>)[nestedKey];
  return typeof nested === "string" ? nested : undefined;
}

function nestedNumber(
  source: Readonly<Record<string, unknown>> | undefined,
  key: string,
  nestedKey: string,
): number | undefined {
  const value = source?.[key];
  if (typeof value !== "object" || value === null) return undefined;
  const nested = (value as Readonly<Record<string, unknown>>)[nestedKey];
  return typeof nested === "number" ? nested : undefined;
}

function arrayLength(source: Readonly<Record<string, unknown>> | undefined, key: string): number {
  const value = source?.[key];
  return Array.isArray(value) ? value.length : 0;
}

function code(source: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const value = source?.code;
  return typeof value === "string" ? value : undefined;
}

function withDetail(
  record: TrajectoryRecord,
  summary: string,
  detail: Readonly<Record<string, unknown>> | undefined,
): TrajectoryRecord {
  const { detail: _omitted, ...rest } = record;
  return detail === undefined ? { ...rest, summary } : { ...rest, summary, detail };
}

function outlineRecord(record: TrajectoryRecord): TrajectoryRecord {
  const detail = record.detail;
  switch (record.kind) {
    case "state": {
      const safe = pick(detail, ["status", "stage", "code"]);
      const status = typeof safe?.status === "string" ? safe.status : "unknown";
      const stage = typeof safe?.stage === "string" ? safe.stage : "unknown";
      const failure = typeof safe?.code === "string" ? ` · ${safe.code}` : "";
      return withDetail(record, `${status} · ${stage}${failure}`, safe);
    }
    case "reasoning":
      return withDetail(record, "模型推理", undefined);
    case "assistant":
      return withDetail(record, "模型回复", pick(detail, ["stopReason"]));
    case "tool": {
      const action = nestedString(detail, "presentation", "action");
      const failureCode = nestedString(detail, "failure", "code");
      const safe = {
        ...pick(detail, ["callId", "parentCallId", "isError", "executionMode"]),
        ...(action === undefined ? {} : { action }),
        ...(failureCode === undefined ? {} : { failureCode }),
      };
      const mocked = detail?.executionMode === "playground_mock";
      return withDetail(
        record,
        mocked ? `${record.event} · Playground Mock` : record.event,
        Object.keys(safe).length === 0 ? undefined : safe,
      );
    }
    case "waiting":
      return withDetail(record, "等待用户回答", pick(detail, ["checkpointId"]));
    case "recovery": {
      const safe = pick(detail, ["decision", "reason", "generation"]);
      return withDetail(
        record,
        safe?.decision === "sandbox_reused"
          ? "复用既有 Sandbox"
          : `重建 Sandbox：${typeof safe?.reason === "string" ? safe.reason : "unknown"}`,
        safe,
      );
    }
    case "runtime":
      return outlineRuntimeRecord(record);
  }
}

function outlineRuntimeRecord(record: TrajectoryRecord): TrajectoryRecord {
  const detail = record.detail;
  switch (record.event) {
    case "agent.started":
      return withDetail(record, "Agent 开始执行", undefined);
    case "agent.settled":
      return withDetail(record, "Agent 已收敛", undefined);
    case "artifact_correction_requested": {
      const safe = pick(detail, ["round", "maxRounds", "code"]);
      return withDetail(
        record,
        `交付物修正 ${String(safe?.round ?? "?")}/${String(safe?.maxRounds ?? "?")}`,
        safe,
      );
    }
    case "runtime.notice":
    case "error": {
      const failure = code(detail) ?? "UNKNOWN";
      return withDetail(record, failure, { code: failure });
    }
    case "todo.updated": {
      const version = nestedNumber(detail, "snapshot", "version");
      return withDetail(
        record,
        `任务清单更新到版本 ${version ?? "?"}`,
        version === undefined ? undefined : { version },
      );
    }
    case "queue.updated": {
      const steering = arrayLength(detail, "steering");
      const followUp = arrayLength(detail, "followUp");
      return withDetail(record, `队列：steering ${steering}，follow-up ${followUp}`, {
        steering,
        followUp,
      });
    }
    case "compaction.forbidden":
      return withDetail(record, "阻止 Pi 内置上下文压缩", undefined);
    default:
      return withDetail(record, record.event, undefined);
  }
}

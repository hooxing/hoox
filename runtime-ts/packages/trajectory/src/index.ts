import type { RuntimeEventV1 } from "@hoox/run-contracts";

export type TrajectoryRecordKind =
  | "state"
  | "reasoning"
  | "assistant"
  | "tool"
  | "waiting"
  | "recovery"
  | "runtime";

export type TrajectoryRecordStatus = "running" | "completed" | "failed" | "waiting";

export interface ObservedRuntimeEvent {
  readonly event: RuntimeEventV1;
  readonly observedAt: string;
}

export interface TrajectoryRecord {
  readonly id: string;
  readonly sequence: number;
  readonly endSequence: number;
  readonly step?: number | undefined;
  readonly kind: TrajectoryRecordKind;
  readonly event: string;
  readonly summary: string;
  readonly status: TrajectoryRecordStatus;
  readonly startedAt: string;
  readonly completedAt?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly detail?: Readonly<Record<string, unknown>> | undefined;
}

export interface TrajectoryStats {
  readonly eventCount: number;
  readonly recordCount: number;
  readonly modelSteps: number;
  readonly toolCalls: number;
  readonly failedToolCalls: number;
  readonly errors: number;
  readonly durationMs?: number | undefined;
}

export interface TrajectoryProjection {
  readonly records: readonly TrajectoryRecord[];
  readonly stats: TrajectoryStats;
}

type MutableRecord = {
  id: string;
  sequence: number;
  endSequence: number;
  step?: number | undefined;
  kind: TrajectoryRecordKind;
  event: string;
  summary: string;
  status: TrajectoryRecordStatus;
  startedAt: string;
  completedAt?: string | undefined;
  durationMs?: number | undefined;
  detail?: Readonly<Record<string, unknown>> | undefined;
};

function milliseconds(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function closeRecord(
  record: MutableRecord,
  event: ObservedRuntimeEvent,
  status: TrajectoryRecordStatus,
) {
  record.endSequence = event.event.sequence;
  record.completedAt = event.observedAt;
  record.status = status;
  const start = milliseconds(record.startedAt);
  const end = milliseconds(event.observedAt);
  if (start !== undefined && end !== undefined) record.durationMs = Math.max(0, end - start);
}

function bounded(value: string, maximum = 240): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function appendText(current: string, delta: string): string {
  const combined = current + delta;
  return combined.length <= 32_768 ? combined : combined.slice(combined.length - 32_768);
}

function eventDetail(payload: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * 将 durable Run 事件投影为维护者轨迹。`observedAt` 由调用方提供：内部轨迹查看器使用本地
 * 不可变镜像文件的 mtime（只表示诊断观察时刻），后台 Run 浏览器使用 PostgreSQL occurred_at。
 * 投影结果包含推理、回复等正文；只能展示结构时必须再经过 `outlineTrajectory`。
 */
export function projectTrajectory(input: readonly ObservedRuntimeEvent[]): TrajectoryProjection {
  const events = [...input].sort((left, right) => left.event.sequence - right.event.sequence);
  const records: MutableRecord[] = [];
  const tools = new Map<string, MutableRecord>();
  let reasoning: MutableRecord | undefined;
  let assistant: MutableRecord | undefined;
  let modelStep = 0;
  let modelOutputExpected = true;
  let failedToolCalls = 0;
  let errors = 0;

  const startModelStep = () => {
    if (modelOutputExpected || modelStep === 0) {
      modelStep += 1;
      modelOutputExpected = false;
    }
    return modelStep;
  };

  for (const observed of events) {
    const event = observed.event;
    if (event.kind === "attempt_state_changed") {
      const failed =
        event.payload.code !== undefined ||
        ["failed", "cancelled", "abandoned", "recovery_required"].includes(event.payload.status);
      if (failed) errors += 1;
      records.push({
        id: `state-${event.sequence}`,
        sequence: event.sequence,
        endSequence: event.sequence,
        kind: "state",
        event: "attempt_state_changed",
        summary: `${event.payload.status} · ${event.payload.stage}${event.payload.code === undefined ? "" : ` · ${event.payload.code}`}`,
        status: failed
          ? "failed"
          : event.payload.status === "running"
            ? "running"
            : event.payload.status === "waiting"
              ? "waiting"
              : "completed",
        startedAt: observed.observedAt,
        detail: eventDetail(event.payload),
      });
      continue;
    }
    if (event.kind === "run_waiting") {
      records.push({
        id: `waiting-${event.sequence}`,
        sequence: event.sequence,
        endSequence: event.sequence,
        kind: "waiting",
        event: "run_waiting",
        summary: bounded(event.payload.question),
        status: "waiting",
        startedAt: observed.observedAt,
        detail: eventDetail(event.payload),
      });
      continue;
    }
    if (event.kind === "sandbox_recovery_decided") {
      records.push({
        id: `recovery-${event.sequence}`,
        sequence: event.sequence,
        endSequence: event.sequence,
        kind: "recovery",
        event: "sandbox_recovery_decided",
        summary:
          event.payload.decision === "sandbox_reused"
            ? "复用既有 Sandbox"
            : `重建 Sandbox：${event.payload.reason}`,
        status: "completed",
        startedAt: observed.observedAt,
        detail: eventDetail(event.payload),
      });
      continue;
    }
    if (event.kind === "artifact_correction_requested") {
      records.push({
        id: `runtime-${event.sequence}`,
        sequence: event.sequence,
        endSequence: event.sequence,
        kind: "runtime",
        event: "artifact_correction_requested",
        summary: `交付物修正 ${event.payload.round}/${event.payload.maxRounds}：${bounded(event.payload.feedback)}`,
        status: "failed",
        startedAt: observed.observedAt,
        detail: eventDetail(event.payload),
      });
      errors += 1;
      continue;
    }

    const payload = event.payload;
    switch (payload.type) {
      case "agent.started":
        modelOutputExpected = true;
        records.push({
          id: `agent-${event.sequence}`,
          sequence: event.sequence,
          endSequence: event.sequence,
          kind: "runtime",
          event: payload.type,
          summary: "Agent 开始执行",
          status: "running",
          startedAt: observed.observedAt,
        });
        break;
      case "agent.settled":
        records.push({
          id: `agent-${event.sequence}`,
          sequence: event.sequence,
          endSequence: event.sequence,
          kind: "runtime",
          event: payload.type,
          summary: "Agent 已收敛",
          status: "completed",
          startedAt: observed.observedAt,
        });
        break;
      case "thinking.started": {
        const step = startModelStep();
        reasoning = {
          id: `reasoning-${event.sequence}`,
          sequence: event.sequence,
          endSequence: event.sequence,
          step,
          kind: "reasoning",
          event: "thinking",
          summary: "正在推理",
          status: "running",
          startedAt: observed.observedAt,
          detail: { text: "" },
        };
        records.push(reasoning);
        break;
      }
      case "thinking.delta": {
        if (reasoning === undefined || reasoning.status !== "running") {
          const step = startModelStep();
          reasoning = {
            id: `reasoning-${event.sequence}`,
            sequence: event.sequence,
            endSequence: event.sequence,
            step,
            kind: "reasoning",
            event: "thinking",
            summary: "正在推理",
            status: "running",
            startedAt: observed.observedAt,
            detail: { text: "" },
          };
          records.push(reasoning);
        }
        const text = appendText(String(reasoning.detail?.text ?? ""), payload.delta);
        reasoning.detail = { text };
        reasoning.summary = bounded(text) || "正在推理";
        reasoning.endSequence = event.sequence;
        break;
      }
      case "thinking.completed":
        if (reasoning !== undefined && reasoning.status === "running")
          closeRecord(reasoning, observed, "completed");
        reasoning = undefined;
        break;
      case "message.delta": {
        if (reasoning !== undefined && reasoning.status === "running") {
          closeRecord(reasoning, observed, "completed");
          reasoning = undefined;
        }
        const step = startModelStep();
        if (assistant === undefined || assistant.status !== "running") {
          assistant = {
            id: `assistant-${event.sequence}`,
            sequence: event.sequence,
            endSequence: event.sequence,
            step,
            kind: "assistant",
            event: "message",
            summary: "正在生成回复",
            status: "running",
            startedAt: observed.observedAt,
            detail: { text: "" },
          };
          records.push(assistant);
        }
        const text = appendText(String(assistant.detail?.text ?? ""), payload.delta);
        assistant.detail = { text };
        assistant.summary = bounded(text) || "正在生成回复";
        assistant.endSequence = event.sequence;
        break;
      }
      case "message.completed":
        if (assistant !== undefined && assistant.status === "running") {
          assistant.detail = { ...assistant.detail, stopReason: payload.stopReason };
          closeRecord(assistant, observed, "completed");
        }
        assistant = undefined;
        break;
      case "tool.started": {
        if (reasoning !== undefined && reasoning.status === "running")
          closeRecord(reasoning, observed, "completed");
        reasoning = undefined;
        if (assistant !== undefined && assistant.status === "running")
          closeRecord(assistant, observed, "completed");
        assistant = undefined;
        const record: MutableRecord = {
          id: `tool-${payload.callId}`,
          sequence: event.sequence,
          endSequence: event.sequence,
          step: Math.max(1, modelStep),
          kind: "tool",
          event: payload.name,
          summary:
            payload.presentation?.title === undefined
              ? payload.name
              : `${payload.name} · ${payload.presentation.title}`,
          status: "running",
          startedAt: observed.observedAt,
          detail: eventDetail(payload),
        };
        records.push(record);
        tools.set(payload.callId, record);
        break;
      }
      case "tool.updated": {
        const record = tools.get(payload.callId);
        if (record !== undefined) record.endSequence = event.sequence;
        break;
      }
      case "tool.completed": {
        const record = tools.get(payload.callId);
        if (record !== undefined) {
          record.detail = {
            ...record.detail,
            isError: payload.isError,
            ...(payload.failure === undefined ? {} : { failure: payload.failure }),
          };
          closeRecord(record, observed, payload.isError ? "failed" : "completed");
        }
        if (payload.isError) failedToolCalls += 1;
        modelOutputExpected = true;
        break;
      }
      case "runtime.notice":
      case "error":
        records.push({
          id: `error-${event.sequence}`,
          sequence: event.sequence,
          endSequence: event.sequence,
          step: modelStep === 0 ? undefined : modelStep,
          kind: "runtime",
          event: payload.type,
          summary: `${payload.code} · ${bounded(payload.message)}`,
          status: "failed",
          startedAt: observed.observedAt,
          detail: eventDetail(payload),
        });
        errors += 1;
        break;
      case "todo.updated":
        records.push({
          id: `todo-${event.sequence}`,
          sequence: event.sequence,
          endSequence: event.sequence,
          step: modelStep === 0 ? undefined : modelStep,
          kind: "runtime",
          event: payload.type,
          summary: `任务清单更新到版本 ${payload.snapshot.version}`,
          status: "completed",
          startedAt: observed.observedAt,
          detail: eventDetail(payload),
        });
        break;
      case "queue.updated":
        records.push({
          id: `queue-${event.sequence}`,
          sequence: event.sequence,
          endSequence: event.sequence,
          step: modelStep === 0 ? undefined : modelStep,
          kind: "runtime",
          event: payload.type,
          summary: `队列：steering ${payload.steering.length}，follow-up ${payload.followUp.length}`,
          status: "completed",
          startedAt: observed.observedAt,
          detail: eventDetail(payload),
        });
        break;
      case "compaction.forbidden":
        records.push({
          id: `compaction-${event.sequence}`,
          sequence: event.sequence,
          endSequence: event.sequence,
          step: modelStep === 0 ? undefined : modelStep,
          kind: "runtime",
          event: payload.type,
          summary: "阻止 Pi 内置上下文压缩",
          status: "completed",
          startedAt: observed.observedAt,
          detail: eventDetail(payload),
        });
        break;
      case "turn.completed":
        break;
    }
  }

  const first = events.at(0)?.observedAt;
  const last = events.at(-1)?.observedAt;
  const firstMs = first === undefined ? undefined : milliseconds(first);
  const lastMs = last === undefined ? undefined : milliseconds(last);
  return {
    records: records.map((record) => Object.freeze({ ...record })),
    stats: {
      eventCount: events.length,
      recordCount: records.length,
      modelSteps: modelStep,
      toolCalls: records.filter((record) => record.kind === "tool").length,
      failedToolCalls,
      errors,
      ...(firstMs === undefined || lastMs === undefined
        ? {}
        : { durationMs: Math.max(0, lastMs - firstMs) }),
    },
  };
}

export * from "./deepseek.js";
export * from "./internal.js";
export * from "./outline.js";

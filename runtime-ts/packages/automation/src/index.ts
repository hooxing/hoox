export type ScheduledTaskStatus = "active" | "paused" | "completed" | "deleted";
export type ScheduledTaskOverlapPolicy = "coalesce" | "skip";

export interface ScheduledTask {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly sourceThreadId: string;
  readonly targetThreadId: string;
  readonly name: string;
  readonly instruction: string;
  readonly timezone: string;
  readonly rrule?: string;
  readonly status: ScheduledTaskStatus;
  readonly overlapPolicy: ScheduledTaskOverlapPolicy;
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  readonly currentRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScheduledTaskCreateCommand {
  readonly name: string;
  readonly instruction: string;
  readonly firstRunAt: string;
  readonly rrule?: string;
  readonly timezone: string;
  readonly overlapPolicy?: ScheduledTaskOverlapPolicy;
}

export interface ScheduledTaskUpdateCommand {
  readonly name?: string;
  readonly instruction?: string;
  readonly firstRunAt?: string;
  readonly rrule?: string | null;
  readonly timezone?: string;
  readonly overlapPolicy?: ScheduledTaskOverlapPolicy;
}

const maximumTextBytes = 16_384;
const maximumNameCharacters = 120;
const maximumInterval = 525_600;
const allowedFrequencies = new Set(["MINUTELY", "HOURLY", "DAILY"]);

export function normalizeScheduledTaskName(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length < 1 || Array.from(normalized).length > maximumNameCharacters) {
    throw new TypeError("定时任务名称长度无效");
  }
  return normalized;
}

export function normalizeScheduledTaskInstruction(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || Buffer.byteLength(normalized, "utf8") > maximumTextBytes) {
    throw new TypeError("定时任务指令长度无效");
  }
  return normalized;
}

export function normalizeTimeZone(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 100) throw new TypeError("时区无效");
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: normalized }).format(new Date(0));
  } catch {
    throw new TypeError("时区无效");
  }
  return normalized;
}

export function normalizeRunAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("首次执行时间无效");
  return new Date(timestamp).toISOString();
}

export function normalizeRrule(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toUpperCase();
  if (normalized.length < 1 || normalized.length > 300) throw new TypeError("RRULE 无效");
  const parts = new Map<string, string>();
  for (const token of normalized.split(";")) {
    const [key, raw, ...rest] = token.split("=");
    if (key === undefined || raw === undefined || rest.length > 0 || parts.has(key)) {
      throw new TypeError("RRULE 无效");
    }
    parts.set(key, raw);
  }
  const frequency = parts.get("FREQ");
  if (frequency === undefined || !allowedFrequencies.has(frequency)) {
    throw new TypeError("RRULE 首版只支持 MINUTELY、HOURLY、DAILY");
  }
  const unsupported = [...parts.keys()].filter((key) => key !== "FREQ" && key !== "INTERVAL");
  if (unsupported.length > 0) throw new TypeError("RRULE 包含首版不支持的字段");
  const intervalText = parts.get("INTERVAL") ?? "1";
  if (!/^[1-9][0-9]{0,5}$/u.test(intervalText)) throw new TypeError("RRULE INTERVAL 无效");
  const interval = Number(intervalText);
  if (!Number.isSafeInteger(interval) || interval > maximumInterval) {
    throw new TypeError("RRULE INTERVAL 无效");
  }
  return `FREQ=${frequency};INTERVAL=${interval}`;
}

export function nextScheduledRunAt(current: string, rrule: string | undefined): string | undefined {
  if (rrule === undefined) return undefined;
  const normalized = normalizeRrule(rrule);
  if (normalized === undefined) return undefined;
  const values = Object.fromEntries(normalized.split(";").map((part) => part.split("=")));
  const interval = Number(values.INTERVAL);
  const unit =
    values.FREQ === "MINUTELY" ? 60_000 : values.FREQ === "HOURLY" ? 3_600_000 : 86_400_000;
  const next = Date.parse(current) + interval * unit;
  if (!Number.isSafeInteger(next)) throw new TypeError("下一次执行时间超出范围");
  return new Date(next).toISOString();
}

export interface ScheduledTaskScope {
  readonly tenantId: string;
  readonly userId: string;
}

export type ScheduledTaskMutation =
  | ({
      readonly action: "create";
      readonly sourceThreadId: string;
      readonly targetThreadId: string;
    } & ScheduledTaskCreateCommand)
  | ({ readonly action: "update"; readonly taskId: string } & ScheduledTaskUpdateCommand)
  | { readonly action: "pause"; readonly taskId: string }
  | { readonly action: "resume"; readonly taskId: string }
  | { readonly action: "delete"; readonly taskId: string };

export type ScheduledTaskMutationResult =
  | { readonly outcome: "applied" | "replayed"; readonly task: ScheduledTask }
  | { readonly outcome: "key_conflict" | "not_found" | "not_authorized" | "invalid_state" };

export interface ScheduledTaskManagementPort {
  list(input: { readonly scope: ScheduledTaskScope }): Promise<readonly ScheduledTask[]>;
  mutate(input: {
    readonly scope: ScheduledTaskScope;
    readonly commandId: string;
    readonly requestDigest: string;
    readonly mutation: ScheduledTaskMutation;
    readonly createdByRunId?: string;
  }): Promise<ScheduledTaskMutationResult>;
}

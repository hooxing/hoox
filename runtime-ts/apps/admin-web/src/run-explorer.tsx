import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { projectInternalTrajectory } from "@hoox/trajectory";
import { AdminApiError } from "./api.js";
import {
  type RunDetailDto,
  type RunExplorerApiContract,
  type RunListFilters,
  type RunPageDto,
  type RunStatus,
  type RunSummaryDto,
  type RunTrajectoryDto,
  type RunTrajectoryPageDto,
  type RunTrajectoryRecordDto,
  type RunTimelineRecordDto,
  runStatuses,
} from "./run-explorer-api.js";

export async function loadTrajectoryPages(
  readPage: NonNullable<RunExplorerApiContract["readTrajectory"]>,
  tenantId: string,
  runId: string,
  attemptId: string,
  onProgress: (progress: { readonly events: number; readonly bytes: number }) => void,
  limits = { events: 50_000, bytes: 20 * 1024 * 1024 },
) {
  const events: RunTrajectoryPageDto["events"][number][] = [];
  let loadedBytes = 0;
  let truncatedEvents = 0;
  let cursor: string | undefined;
  let partial = false;
  let limitReached = false;
  let hasNextPage = true;
  while (hasNextPage) {
    const page = await readPage(tenantId, runId, attemptId, cursor);
    if (
      events.length + page.events.length > limits.events ||
      loadedBytes + page.bytes > limits.bytes
    ) {
      partial = true;
      limitReached = true;
      onProgress({ events: events.length, bytes: loadedBytes });
      break;
    }
    for (const pageEvent of page.events) {
      if (pageEvent.truncated === true) {
        partial = true;
        truncatedEvents += 1;
      }
      events.push(pageEvent);
    }
    loadedBytes += page.bytes;
    onProgress({ events: events.length, bytes: loadedBytes });
    hasNextPage = !limitReached && page.hasMore && page.nextCursor !== undefined;
    if (!hasNextPage) break;
    cursor = page.nextCursor;
  }
  const sessions = new Map<string, typeof events>();
  for (const event of events) {
    const sessionId = JSON.stringify([event.agentThreadId, event.agentTurnId]);
    const session = sessions.get(sessionId) ?? [];
    session.push(event);
    sessions.set(sessionId, session);
  }
  const projected = [...sessions.entries()].map(([sessionId, sessionEvents]) => {
    const projection = projectInternalTrajectory(
      sessionEvents.map(({ agentThreadId: _thread, agentTurnId: _turn, ...event }) => event),
    );
    const main = sessionEvents[0]?.agentThreadId === "";
    const sessionLabel = main
      ? "主 Agent"
      : `子 Agent ${sessionEvents[0]?.agentThreadId} · ${sessionEvents[0]?.agentTurnId}`;
    return { sessionId, sessionLabel, projection };
  });
  const timestamps = events.map((event) => Date.parse(event.occurredAt)).filter(Number.isFinite);
  const firstTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const projections = projected
    .flatMap(({ sessionId, sessionLabel, projection }) =>
      projection.records.map((record) => ({
        ...record,
        id: `${encodeURIComponent(sessionId)}:${record.id}`,
        sessionId,
        sessionLabel,
        monotonicOffsetMs: Math.max(0, Date.parse(record.startedAt) - firstTimestamp),
      })),
    )
    .sort(
      (left, right) =>
        left.monotonicOffsetMs - right.monotonicOffsetMs || left.id.localeCompare(right.id),
    );
  const sessionStats = projected.map(({ projection }) => projection.stats);
  const recordsByTurn = new Map<string, typeof projections>();
  for (const record of projections) {
    const key = JSON.stringify([record.sessionId, record.turn]);
    const group = recordsByTurn.get(key) ?? [];
    group.push(record);
    recordsByTurn.set(key, group);
  }
  const turns = projected.flatMap(({ sessionId, sessionLabel, projection }) =>
    projection.turns.map((turn) => ({
      ...turn,
      sessionId,
      sessionLabel,
      records: recordsByTurn.get(JSON.stringify([sessionId, turn.turn])) ?? [],
    })),
  );
  const stats =
    sessionStats.length === 1 && sessionStats[0] !== undefined
      ? sessionStats[0]
      : (() => {
          const totals = sessionStats.reduce(
            (total, item) => ({
              events: total.events + item.events,
              records: total.records + item.records,
              turns: total.turns + item.turns,
              calls: total.calls + item.calls,
              failedCalls: total.failedCalls + item.failedCalls,
              inputTokens: total.inputTokens + item.inputTokens,
              outputTokens: total.outputTokens + item.outputTokens,
              cacheReadTokens: total.cacheReadTokens + item.cacheReadTokens,
              cacheWriteTokens: total.cacheWriteTokens + item.cacheWriteTokens,
              modelDurationMs: total.modelDurationMs + item.modelDurationMs,
              modelWaitDurationMs:
                total.modelWaitDurationMs === null || item.modelWaitDurationMs === null
                  ? null
                  : total.modelWaitDurationMs + item.modelWaitDurationMs,
              durationMs: Math.max(total.durationMs, item.durationMs),
            }),
            {
              events: 0,
              records: 0,
              turns: 0,
              calls: 0,
              failedCalls: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              modelDurationMs: 0,
              modelWaitDurationMs: 0 as number | null,
              durationMs: 0,
            },
          );
          const cacheDenominator = totals.inputTokens + totals.cacheReadTokens;
          return {
            ...totals,
            outputTokensPerSecond:
              totals.modelDurationMs > 0
                ? (totals.outputTokens / totals.modelDurationMs) * 1_000
                : null,
            cacheHitRate: cacheDenominator > 0 ? totals.cacheReadTokens / cacheDenominator : null,
          };
        })();
  return {
    turns,
    records: projections,
    stats,
    partial,
    loadedEvents: events.length,
    loadedBytes,
    truncatedEvents,
  };
}

export const runStatusLabels: Readonly<Record<RunStatus, string>> = {
  queued: "排队中",
  running: "运行中",
  waiting: "等待回答",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
};

const recordKindLabels: Readonly<Record<string, string>> = {
  state: "状态",
  reasoning: "推理",
  assistant: "回复",
  tool: "工具",
  waiting: "等待",
  recovery: "恢复",
  runtime: "运行时",
};

function errorMessage(reason: unknown): string {
  return reason instanceof AdminApiError ? reason.message : "操作未完成，请刷新后重试。";
}

function formatDate(value: string | undefined): string {
  if (value === undefined) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

export function formatDuration(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes} 分 ${seconds} 秒`;
}

function formatCount(value: number): string {
  return value.toLocaleString("zh-CN");
}

function statusLabel(value: string): string {
  return runStatusLabels[value as RunStatus] ?? value;
}

/** datetime-local 输入按浏览器本地时区解释，提交前转为 UTC ISO 时间。 */
function localInputToIso(value: string): string | undefined {
  if (value.length === 0) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
}

function RunRow({
  run,
  onOpen,
}: {
  readonly run: RunSummaryDto;
  readonly onOpen: (run: RunSummaryDto) => void;
}) {
  return (
    <tr>
      <td title={run.userInput ?? "暂无用户输入记录"}>
        <strong>{run.agentDisplayName ?? "未记录 Agent 名称"}</strong>
        <div className="run-question">{run.userInput ?? "暂无用户输入记录"}</div>
        <small>{run.threadTitle}</small>
        <small>{run.userEmail ?? run.userDisplayName ?? "未知用户"}</small>
      </td>
      <td>
        <time>{formatDate(run.createdAt)}</time>
      </td>
      <td>
        <span className={`run-status ${run.status}`}>{statusLabel(run.status)}</span>
      </td>
      <td>{formatDuration(run.durationMs)}</td>
      <td>{formatCount(run.modelCalls)}</td>
      <td>
        {formatCount(run.toolCalls)}
        {run.failedToolCalls > 0 && (
          <small className="run-failure-note"> · 失败 {run.failedToolCalls}</small>
        )}
      </td>
      <td>
        {formatCount(run.usage.inputTokens + run.usage.cacheReadTokens)} /{" "}
        {formatCount(run.usage.outputTokens)}
      </td>
      <td>{formatCount(run.attemptCount)}</td>
      <td>{run.origin ?? "未记录"}</td>
      <td>{run.origin ?? "未记录"}</td>
      <td>
        <button
          type="button"
          className="text-button"
          onClick={() => void navigator.clipboard.writeText(run.runId).catch(() => {})}
          title={run.runId}
        >
          复制 ID
        </button>
        <button type="button" className="text-button" onClick={() => onOpen(run)}>
          查看
        </button>
      </td>
    </tr>
  );
}

/**
 * 运行记录列表。所有字段来自 Run 表、持久事件计数与模型用量账本，不含任何正文。
 * Agent 与来源列在对应事实落库前显示“未记录”。
 */
export function RunExplorerList({
  api,
  onOpen,
}: {
  readonly api: RunExplorerApiContract;
  readonly onOpen: (run: RunSummaryDto) => void;
}) {
  const [tenantId, setTenantId] = useState("");
  const [status, setStatus] = useState<RunStatus | "">("");
  const [createdFrom, setCreatedFrom] = useState("");
  const [createdTo, setCreatedTo] = useState("");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<RunListFilters>({});
  const [page, setPage] = useState<RunPageDto>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (next: RunListFilters, append: boolean) => {
      setBusy(true);
      setError(undefined);
      try {
        const result = await api.listRuns(next);
        setPage((current) =>
          append && current !== undefined
            ? { ...result, items: [...current.items, ...result.items] }
            : result,
        );
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void load({}, false);
  }, [load]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const from = localInputToIso(createdFrom);
    const to = localInputToIso(createdTo);
    const next: RunListFilters = {
      ...(tenantId.trim().length === 0 ? {} : { tenantId: tenantId.trim() }),
      ...(status === "" ? {} : { status }),
      ...(from === undefined ? {} : { createdFrom: from }),
      ...(to === undefined ? {} : { createdTo: to }),
      ...(search.trim() ? { search: search.trim() } : {}),
    };
    setFilters(next);
    void load(next, false);
  };

  return (
    <section className="control-panel run-explorer" aria-label="运行记录">
      <div className="user-management-heading">
        <div>
          <span className="eyebrow">Run explorer</span>
          <h2>运行记录</h2>
          <p>按 Tenant、状态与创建时间筛选 Run，查看耗时、模型调用与 Token 用量。</p>
        </div>
        <span className="count">{page?.items.length ?? 0}</span>
      </div>
      <form className="run-filters" onSubmit={submit}>
        <label>
          搜索用户问题或 Thread 标题
          <input
            aria-label="搜索用户问题"
            value={search}
            maxLength={200}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label>
          Tenant
          <input
            aria-label="Tenant"
            value={tenantId}
            maxLength={256}
            placeholder="全部 Tenant"
            onChange={(event) => setTenantId(event.target.value)}
          />
        </label>
        <label>
          状态
          <select
            aria-label="状态"
            value={status}
            onChange={(event) => setStatus(event.target.value as RunStatus | "")}
          >
            <option value="">全部状态</option>
            {runStatuses.map((value) => (
              <option key={value} value={value}>
                {runStatusLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          创建不早于
          <input
            aria-label="创建不早于"
            type="datetime-local"
            value={createdFrom}
            onChange={(event) => setCreatedFrom(event.target.value)}
          />
        </label>
        <label>
          创建不晚于
          <input
            aria-label="创建不晚于"
            type="datetime-local"
            value={createdTo}
            onChange={(event) => setCreatedTo(event.target.value)}
          />
        </label>
        <button type="submit" className="quiet-button" disabled={busy}>
          查询
        </button>
      </form>
      {error !== undefined && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {page === undefined ? (
        <p className="empty-state">{busy ? "正在读取运行记录…" : "暂无数据。"}</p>
      ) : page.items.length === 0 ? (
        <p className="empty-state">没有符合条件的 Run。</p>
      ) : (
        <div className="run-table-wrap">
          <table className="run-table">
            <thead>
              <tr>
                <th>用户问题 / Agent / 用户</th>
                <th>创建时间</th>
                <th>状态</th>
                <th>耗时（含排队）</th>
                <th>模型调用</th>
                <th>工具调用</th>
                <th>Token 输入 / 输出</th>
                <th>Attempt</th>
                <th>Agent ID</th>
                <th>来源</th>
                <th>
                  <span className="visually-hidden">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((run) => (
                <RunRow key={`${run.tenantId}/${run.runId}`} run={run} onOpen={onOpen} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page?.nextCursor !== undefined && (
        <button
          type="button"
          className="quiet-button run-load-more"
          disabled={busy}
          onClick={() => {
            if (page.nextCursor !== undefined)
              void load({ ...filters, cursor: page.nextCursor }, true);
          }}
        >
          加载更多
        </button>
      )}
    </section>
  );
}

function detailText(record: RunTimelineRecordDto): string | undefined {
  const text = record.detail?.text;
  return typeof text === "string" && text.length > 0 ? text : undefined;
}

function TimelineRecord({
  record,
  origin,
  showContent,
}: {
  readonly record: RunTimelineRecordDto;
  readonly origin: number | undefined;
  readonly showContent: boolean;
}) {
  const started = Date.parse(record.startedAt);
  const offset =
    origin === undefined || !Number.isFinite(started) ? undefined : Math.max(0, started - origin);
  const text = showContent ? detailText(record) : undefined;
  const parameters =
    showContent && record.detail !== undefined ? JSON.stringify(record.detail, null, 2) : undefined;
  return (
    <li className={`run-timeline-record ${record.kind} ${record.status}`}>
      <span className="run-timeline-offset">+{formatDuration(offset)}</span>
      <span className="run-timeline-kind">{recordKindLabels[record.kind] ?? record.kind}</span>
      <span className="run-timeline-summary">
        <strong>{record.summary}</strong>
        {record.step !== undefined && <small>第 {record.step} 步</small>}
        {text !== undefined && <pre className="run-timeline-content">{text}</pre>}
        {parameters !== undefined && parameters !== "{}" && (
          <pre className="run-timeline-content">{parameters}</pre>
        )}
      </span>
      <span className="run-timeline-duration">{formatDuration(record.durationMs)}</span>
    </li>
  );
}

/**
 * Run 详情。默认只展示结构时间线；持有正文权限的管理员需主动打开正文，服务端每次都写审计。
 * 正文只保存在本组件状态中，切换 Attempt 或离开页面即丢弃。
 */
export function RunExplorerDetail({
  api,
  tenantId,
  runId,
  onBack,
  live = false,
}: {
  readonly api: RunExplorerApiContract;
  readonly tenantId: string;
  readonly runId: string;
  readonly onBack?: () => void;
  readonly live?: boolean;
}) {
  const [attemptId, setAttemptId] = useState<string>();
  const [detail, setDetail] = useState<RunDetailDto>();
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload 只用于读取失败后手动刷新，不重新受理 Run。
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setDetail(undefined);
    setError(undefined);
    async function readOutline() {
      try {
        const next = await api.getRun(tenantId, runId, attemptId);
        if (cancelled) return;
        setDetail(next);
        // 活跃 Run 仍定时刷新；管理员每次详情读取都由服务端独立记录审计。
        if (live && ["queued", "running", "waiting"].includes(next.run.status)) {
          timer = setTimeout(() => void readOutline(), 2000);
        }
      } catch (reason) {
        if (cancelled) return;
        setDetail(undefined);
        setError(errorMessage(reason));
      }
    }
    void readOutline();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, tenantId, runId, attemptId, live, reload]);

  const run = detail?.run;

  return (
    <section className="control-panel run-detail" aria-label="Run 详情">
      <div className="user-management-heading">
        <div>
          <span className="eyebrow">{live ? "执行轨迹" : "Run detail"}</span>
          <h2>
            <code>{runId}</code>
          </h2>
          <p>
            Tenant <code>{tenantId}</code>
            {run === undefined
              ? ""
              : ` · ${run.threadTitle || "Thread"} ${run.threadId} · ${run.userEmail ?? run.userDisplayName ?? "未知用户"}`}
          </p>
        </div>
        {onBack && (
          <button type="button" className="text-button" onClick={onBack}>
            返回列表
          </button>
        )}
      </div>
      {error !== undefined && (
        <div className="error-banner" role="alert">
          {error}
          <button
            type="button"
            className="text-button"
            onClick={() => setReload((value) => value + 1)}
          >
            重新读取轨迹
          </button>
        </div>
      )}
      {run !== undefined && (
        <div className="run-detail-metrics">
          <span>
            <small>状态</small>
            <strong className={`run-status ${run.status}`}>{statusLabel(run.status)}</strong>
          </span>
          <span>
            <small>耗时（含排队）</small>
            <strong>{formatDuration(run.durationMs)}</strong>
          </span>
          <span>
            <small>模型调用</small>
            <strong>{formatCount(run.modelCalls)}</strong>
          </span>
          <span>
            <small>工具调用 / 失败</small>
            <strong>
              {formatCount(run.toolCalls)} / {formatCount(run.failedToolCalls)}
            </strong>
          </span>
          <span>
            <small>Token 输入 / 缓存 / 输出</small>
            <strong>
              {formatCount(run.usage.inputTokens)} / {formatCount(run.usage.cacheReadTokens)} /{" "}
              {formatCount(run.usage.outputTokens)}
            </strong>
          </span>
          <span>
            <small>模型生成时长</small>
            <strong>{formatDuration(run.usage.generationDurationMs)}</strong>
          </span>
        </div>
      )}
      {run !== undefined && run.attempts.length > 0 && (
        <label className="run-attempt-select">
          Attempt
          <select
            aria-label="Attempt"
            value={detail?.attemptId ?? ""}
            onChange={(event) => setAttemptId(event.target.value)}
          >
            {run.attempts.map((attempt, index) => (
              <option key={attempt.attemptId} value={attempt.attemptId}>
                #{index + 1} · {attempt.status} · {formatDate(attempt.createdAt)}
              </option>
            ))}
          </select>
        </label>
      )}
      {detail !== undefined ? (
        <RunAttemptTimeline
          key={`${detail.attemptId}/${detail.contentAccess}`}
          api={api}
          tenantId={tenantId}
          runId={runId}
          detail={detail}
        />
      ) : (
        !error && (
          <p className="empty-state" role="status">
            正在读取 Run…
          </p>
        )
      )}
    </section>
  );
}

function RunAttemptTimeline({
  api,
  tenantId,
  runId,
  detail,
}: {
  readonly api: RunExplorerApiContract;
  readonly tenantId: string;
  readonly runId: string;
  readonly detail: RunDetailDto;
}) {
  const [trajectory, setTrajectory] = useState<RunTrajectoryDto>();
  const [trajectoryError, setTrajectoryError] = useState(false);
  const [trajectoryProgress, setTrajectoryProgress] = useState({
    events: 0,
    bytes: 0,
    loading: false,
  });
  useEffect(() => {
    let cancelled = false;
    setTrajectory(undefined);
    setTrajectoryError(false);
    setTrajectoryProgress({ events: 0, bytes: 0, loading: false });
    if (detail.attemptId === undefined || api.readTrajectory === undefined) return;
    const attemptId = detail.attemptId;
    const readPage = api.readTrajectory;
    const readAllPages = async () => {
      setTrajectoryProgress({ events: 0, bytes: 0, loading: true });
      try {
        const result = await loadTrajectoryPages(
          readPage,
          tenantId,
          runId,
          attemptId,
          (progress) => {
            if (!cancelled) setTrajectoryProgress({ ...progress, loading: true });
          },
        );
        if (cancelled) return;
        setTrajectory(result);
        setTrajectoryProgress({
          events: result.loadedEvents,
          bytes: result.loadedBytes,
          loading: false,
        });
      } catch {
        if (!cancelled) setTrajectoryError(true);
      }
    };
    void readAllPages();
    return () => {
      cancelled = true;
    };
  }, [api, tenantId, runId, detail.attemptId]);

  if (trajectory !== undefined && (trajectory.records.length > 0 || trajectory.partial)) {
    return <DeepSeekTrajectoryDebugger trajectory={trajectory} />;
  }
  const timeline = detail.timeline;
  const firstRecord = timeline.records[0];
  const origin = firstRecord === undefined ? undefined : Date.parse(firstRecord.startedAt);
  return (
    <>
      {trajectoryError && (
        <p className="boundary-note" role="alert">
          完整轨迹读取失败；以下显示现有持久事件时间线，请稍后重试。
        </p>
      )}
      {trajectoryProgress.loading && (
        <p className="boundary-note" role="status">
          正在读取完整轨迹：{trajectoryProgress.events.toLocaleString()} 条事件，
          {(trajectoryProgress.bytes / (1024 * 1024)).toFixed(1)} MB
        </p>
      )}
      {trajectory !== undefined && trajectory.records.length === 0 && (
        <p className="boundary-note">该 Run 早于完整轨迹记录，以下显示现有持久事件时间线。</p>
      )}
      {timeline.records.length === 0 ? (
        <p className="empty-state">该 Run 早于完整轨迹记录；该 Attempt 尚无持久事件。</p>
      ) : (
        <>
          <p className="boundary-note">
            {timeline.stats.recordCount} 条记录 · {timeline.stats.modelSteps} 个近似模型步骤 ·{" "}
            {timeline.stats.toolCalls} 次工具调用 · {timeline.stats.errors} 个错误 · 事件跨度{" "}
            {formatDuration(timeline.stats.durationMs)}
          </p>
          <ol className="run-timeline">
            {timeline.records.map((record) => (
              <TimelineRecord
                key={record.id}
                record={record}
                origin={origin}
                showContent={detail.contentAccess}
              />
            ))}
          </ol>
        </>
      )}
    </>
  );
}

// 两个视图共享同一记录窗口；展开长 JSON 不会改变窗口边界。
const trajectoryWindowSize = 20;

function appendSearchTerms(value: unknown, terms: string[]): void {
  if (value === null || typeof value !== "object") {
    terms.push(String(value));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    terms.push(key);
    appendSearchTerms(item, terms);
  }
}

function TrajectoryDetail({ detail }: { readonly detail: unknown }) {
  const json = useMemo(() => JSON.stringify(detail, null, 2), [detail]);
  return (
    <div className="trajectory-entry-detail">
      <button
        type="button"
        className="text-button"
        onClick={() => void navigator.clipboard.writeText(json).catch(() => {})}
      >
        复制 JSON
      </button>
      <pre className="run-timeline-content">{json}</pre>
    </div>
  );
}

export function DeepSeekTrajectoryDebugger({
  trajectory,
}: {
  readonly trajectory: RunTrajectoryDto;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [showDuration, setShowDuration] = useState(true);
  const [showTurns, setShowTurns] = useState(true);
  const [showCalls, setShowCalls] = useState(true);
  const [showSubcalls, setShowSubcalls] = useState(true);
  const [page, setPage] = useState(0);
  const needle = query.trim().toLocaleLowerCase();
  const searching = needle !== "";
  const searchIndex = useMemo(() => {
    if (!searching) return undefined;
    return trajectory.records.map((record) => {
      const terms = [record.label, record.summary];
      appendSearchTerms(record.detail, terms);
      return terms.join(" ").toLocaleLowerCase();
    });
  }, [searching, trajectory.records]);
  const records = useMemo(
    () =>
      trajectory.records.filter((record, index) => {
        if (!showCalls && (record.kind === "tool" || record.kind === "subtool")) return false;
        if (!showSubcalls && record.kind === "subtool") return false;
        return searchIndex === undefined || searchIndex[index]?.includes(needle);
      }),
    [trajectory.records, needle, searchIndex, showCalls, showSubcalls],
  );
  const lastPage = Math.max(0, Math.ceil(records.length / trajectoryWindowSize) - 1);
  const start = Math.min(page, lastPage) * trajectoryWindowSize;
  const visibleRecords = records.slice(start, start + trajectoryWindowSize);
  const groups = new Map<string, RunTrajectoryRecordDto[]>();
  for (const record of visibleRecords) {
    const groupKey = `${record.sessionId}:${record.turn}`;
    const group = groups.get(groupKey) ?? [];
    group.push(record);
    groups.set(groupKey, group);
  }
  const origin = records[0]?.monotonicOffsetMs ?? 0;
  const maxOffset = Math.max(
    1,
    ...records.map((record) => record.monotonicOffsetMs - origin + (record.durationMs ?? 0)),
  );
  const usage = trajectory.stats;
  const tokenTotal =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const contextPercent =
    usage.contextWindowTokens === undefined || usage.contextWindowTokens === 0
      ? undefined
      : Math.min(100, Math.round((usage.inputTokens / usage.contextWindowTokens) * 100));
  const select = (record: RunTrajectoryRecordDto) => setSelectedId(record.id);

  return (
    <section className="trajectory-debugger" aria-label="完整运行轨迹">
      {trajectory.partial && (
        <p className="boundary-note" role="status">
          {trajectory.truncatedEvents > 0
            ? `有 ${trajectory.truncatedEvents.toLocaleString()} 条超大事件仅显示有界占位；`
            : "已达到读取上限；"}
          汇总仅覆盖已加载部分（{trajectory.loadedEvents.toLocaleString()} 条事件，
          {(trajectory.loadedBytes / (1024 * 1024)).toFixed(1)} MB）。
        </p>
      )}
      <div className="trajectory-toolbar" role="toolbar" aria-label="轨迹视图控制">
        <label>
          <input
            type="checkbox"
            checked={showDuration}
            onChange={(event) => setShowDuration(event.target.checked)}
          />
          时长
        </label>
        <label>
          <input
            type="checkbox"
            checked={showTurns}
            onChange={(event) => setShowTurns(event.target.checked)}
          />
          轮次
        </label>
        <label>
          <input
            type="checkbox"
            checked={showCalls}
            onChange={(event) => {
              setShowCalls(event.target.checked);
              setPage(0);
            }}
          />
          调用
        </label>
        <label>
          <input
            type="checkbox"
            checked={showSubcalls}
            onChange={(event) => {
              setShowSubcalls(event.target.checked);
              setPage(0);
            }}
          />
          子调用
        </label>
        <input
          aria-label="搜索轨迹"
          placeholder="搜索轨迹内容"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
        />
      </div>
      {lastPage > 0 && (
        <nav className="trajectory-toolbar" aria-label="轨迹显示窗口">
          <button
            type="button"
            disabled={start === 0}
            onClick={() => setPage(start / trajectoryWindowSize - 1)}
          >
            上一组
          </button>
          <span aria-live="polite">
            显示 {start + 1}–{start + visibleRecords.length} / {records.length} 条记录
          </span>
          <button
            type="button"
            disabled={page >= lastPage}
            onClick={() => setPage(start / trajectoryWindowSize + 1)}
          >
            下一组
          </button>
        </nav>
      )}
      <section className="trajectory-timeline" aria-label="轨迹时间轴">
        {(["input", "model", "tools"] as const).map((lane) => (
          <div className="trajectory-lane" key={lane}>
            <strong>{lane === "input" ? "输入" : lane === "model" ? "模型" : "工具"}</strong>
            <div className="trajectory-lane-track">
              {visibleRecords
                .filter((record) => record.lane === lane)
                .map((record) => (
                  <button
                    type="button"
                    key={record.id}
                    aria-label={`${record.sessionLabel} ${record.label} ${record.summary}`}
                    title={`${record.sessionLabel} · ${record.label}: ${record.summary}`}
                    aria-pressed={selectedId === record.id}
                    className={`trajectory-bar ${record.kind} ${selectedId === record.id ? "selected" : ""}`}
                    style={{
                      left: `${Math.max(0, ((record.monotonicOffsetMs - origin) / maxOffset) * 100)}%`,
                      width: `${Math.max(1.5, ((showDuration ? (record.durationMs ?? 0) : 1) / maxOffset) * 100)}%`,
                    }}
                    onClick={() => select(record)}
                  />
                ))}
            </div>
          </div>
        ))}
      </section>
      <div className="trajectory-ledger">
        {[...groups].map(([groupKey, turnRecords]) => (
          <section className="trajectory-turn" key={groupKey}>
            {showTurns && (
              <h3>
                {turnRecords[0]?.sessionLabel} · 第 {turnRecords[0]?.turn} 轮
              </h3>
            )}
            {turnRecords.map((record) => {
              const isExpanded = expanded.has(record.id);
              return (
                <article
                  className={`trajectory-entry ${selectedId === record.id ? "selected" : ""}`}
                  key={record.id}
                >
                  <button
                    type="button"
                    className="trajectory-entry-toggle"
                    aria-expanded={isExpanded}
                    onClick={() => {
                      select(record);
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(record.id)) next.delete(record.id);
                        else next.add(record.id);
                        return next;
                      });
                    }}
                  >
                    <span className={`trajectory-kind ${record.kind}`}>
                      {record.sessionLabel} · {record.label}
                    </span>
                    <span className="trajectory-summary">{record.summary}</span>
                    <span className="trajectory-duration">
                      {record.durationMs === null ? "—" : formatDuration(record.durationMs)}
                    </span>
                  </button>
                  {isExpanded && <TrajectoryDetail detail={record.detail} />}
                </article>
              );
            })}
          </section>
        ))}
      </div>
      <section className="trajectory-summary-stats" aria-label="轨迹汇总">
        <span>轮次 {usage.turns}</span>
        <span>
          调用 {usage.calls}（失败 {usage.failedCalls}）
        </span>
        <span>
          生成速度{" "}
          {usage.outputTokensPerSecond === null
            ? "—"
            : `${usage.outputTokensPerSecond.toFixed(1)} tok/s`}
        </span>
        <span>总 Token {formatCount(tokenTotal)}</span>
        <span>
          缓存命中率{" "}
          {usage.cacheHitRate === null ? "—" : `${Math.round(usage.cacheHitRate * 100)}%`}
        </span>
        <span>上下文占用 {contextPercent === undefined ? "—" : `${contextPercent}%`}</span>
      </section>
      {trajectory.records.length === 0 && (
        <p className="empty-state">
          {trajectory.partial
            ? "已加载部分暂无可投影记录。"
            : "该 Run 早于完整轨迹记录，以下可查看现有事件时间线。"}
        </p>
      )}
    </section>
  );
}

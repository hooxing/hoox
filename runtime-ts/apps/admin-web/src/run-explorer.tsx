import { type FormEvent, useCallback, useEffect, useState } from "react";
import { AdminApiError } from "./api.js";
import {
  type RunContentDto,
  type RunDetailDto,
  type RunExplorerApiContract,
  type RunListFilters,
  type RunPageDto,
  type RunStatus,
  type RunSummaryDto,
  type RunTimelineRecordDto,
  runStatuses,
} from "./run-explorer-api.js";

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
      <td>
        <time>{formatDate(run.createdAt)}</time>
      </td>
      <td>
        <code>{run.tenantId}</code>
      </td>
      <td>
        <code>{run.runId}</code>
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
      <td>{run.agentDefinitionId ?? "未记录"}</td>
      <td>{run.origin ?? "未记录"}</td>
      <td>
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
      <div className="user-directory-note">
        <strong>隐私边界</strong>
        <span>
          列表只包含标识、状态、时间与计数，不返回 Thread 标题、用户输入或模型正文。
          {page?.contentAccess === true
            ? "你持有“查看运行正文”权限，正文需在详情页单独打开并会记录审计。"
            : ""}
        </span>
      </div>
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
                <th>创建时间</th>
                <th>Tenant</th>
                <th>Run</th>
                <th>状态</th>
                <th>耗时（含排队）</th>
                <th>模型调用</th>
                <th>工具调用</th>
                <th>Token 输入 / 输出</th>
                <th>Attempt</th>
                <th>Agent</th>
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
  return (
    <li className={`run-timeline-record ${record.kind} ${record.status}`}>
      <span className="run-timeline-offset">+{formatDuration(offset)}</span>
      <span className="run-timeline-kind">{recordKindLabels[record.kind] ?? record.kind}</span>
      <span className="run-timeline-summary">
        <strong>{record.summary}</strong>
        {record.step !== undefined && <small>第 {record.step} 步</small>}
        {text !== undefined && <pre className="run-timeline-content">{text}</pre>}
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
        // 只串行刷新非终态 Run 的结构；正文请求必须由操作者显式触发。
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
            {run === undefined ? "" : ` · Thread ${run.threadId}`}
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
  detail,
}: {
  readonly api: RunExplorerApiContract;
  readonly detail: RunDetailDto;
}) {
  const [content, setContent] = useState<RunContentDto>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const openContent = async () => {
    if (!detail.contentAccess || !detail.attemptId || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setContent(await api.readRunContent(detail.run.tenantId, detail.run.runId, detail.attemptId));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  const timeline = content?.timeline ?? detail.timeline;
  const firstRecord = timeline.records[0];
  const origin = firstRecord === undefined ? undefined : Date.parse(firstRecord.startedAt);
  return (
    <>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div className="run-content-boundary">
        {content !== undefined ? (
          <>
            <span role="status">
              正在显示打开时的正文。本次访问已记录审计（<code>{content.auditId}</code>）。
            </span>
            <button type="button" className="text-button" onClick={() => setContent(undefined)}>
              收起正文
            </button>
          </>
        ) : detail.contentAccess ? (
          <>
            <span>
              当前只显示结构与指标。打开正文会读取 Prompt 与模型输出，并以你的身份记录审计。
            </span>
            <button
              type="button"
              className="quiet-button"
              disabled={busy || detail.attemptId === undefined}
              onClick={() => void openContent()}
            >
              查看正文
            </button>
          </>
        ) : (
          <span>当前账号没有“查看运行正文”权限，只显示结构与指标。</span>
        )}
      </div>
      {timeline.records.length === 0 ? (
        <p className="empty-state">该 Attempt 尚无持久事件。</p>
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
                showContent={content !== undefined}
              />
            ))}
          </ol>
        </>
      )}
    </>
  );
}

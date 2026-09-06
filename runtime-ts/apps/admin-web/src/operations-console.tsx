import type {
  AdminControlOverviewDto,
  PlatformUserPageDto,
  PlatformUserSummaryDto,
} from "@hoox/protocol";
import { type FormEvent, useState } from "react";

function formatDate(value: string | undefined): string {
  if (value === undefined) return "尚无活动";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

function MetricCard({
  label,
  value,
  note,
  tone = "default",
}: {
  readonly label: string;
  readonly value: number | string;
  readonly note: string;
  readonly tone?: "default" | "positive" | "warning";
}) {
  return (
    <article className={`operation-metric ${tone}`}>
      <span>{label}</span>
      <strong>{typeof value === "number" ? value.toLocaleString("zh-CN") : value}</strong>
      <small>{note}</small>
    </article>
  );
}

function formatThroughput(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
}

function formatRate(value: number | null): string {
  return value === null
    ? "—"
    : `${(value * 100).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}%`;
}

export function trajectoryViewerUrl(input: {
  readonly development: boolean;
  readonly baseUrl: string;
}): string | undefined {
  if (input.development) return "http://127.0.0.1:4188";
  return input.baseUrl === "/admin/" ? "/trajectory/" : undefined;
}

export function ControlDataUnavailable({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <section className="control-panel control-data-unavailable">
      <span className="service-state-dot" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
        <small>页面不会使用示例数字冒充真实生产数据。</small>
      </div>
    </section>
  );
}

export function OperationsDashboard({ value }: { readonly value: AdminControlOverviewDto }) {
  const stats = value.statistics;
  const usage = stats.modelUsage24h;
  const trajectoryUrl = trajectoryViewerUrl({
    development: import.meta.env.DEV,
    baseUrl: import.meta.env.BASE_URL,
  });
  return (
    <div className="operations-dashboard">
      <section className="operations-summary">
        <div>
          <span className="eyebrow">Business observability</span>
          <h2>数据运营</h2>
          <p>指标直接来自 PostgreSQL 受限聚合投影，不读取对话正文或用户密码材料。</p>
        </div>
        <div className="operations-summary-actions">
          <time>数据生成于 {formatDate(stats.generatedAt)}</time>
          {trajectoryUrl !== undefined && (
            <a
              className="trajectory-viewer-link"
              href={trajectoryUrl}
              target="_blank"
              rel="noreferrer"
            >
              打开内部轨迹
            </a>
          )}
        </div>
      </section>

      <section className="metric-section model-usage-section" aria-labelledby="model-usage-title">
        <div className="metric-section-heading">
          <div>
            <span className="metric-icon">AI</span>
            <span>
              <h3 id="model-usage-title">模型用量与吞吐</h3>
              <p>过去 24 小时已观测模型调用的聚合结果，不读取请求或响应正文。</p>
            </span>
          </div>
          <span className="metric-window">24 小时</span>
        </div>
        <div className="operation-metric-grid model-usage-grid">
          <MetricCard
            label="Tokens/s"
            value={formatThroughput(usage.outputTokensPerSecond)}
            note="输出 Token ÷ Assistant 生成时长"
            tone="positive"
          />
          <MetricCard
            label="缓存命中率"
            value={formatRate(usage.cacheHitRate)}
            note="缓存读取 ÷ 全部输入 Token"
          />
          <MetricCard label="输入 Token" value={usage.inputTokens} note="未缓存输入 + 缓存读取" />
          <MetricCard label="输出 Token" value={usage.outputTokens} note="模型生成总量" />
        </div>
      </section>

      <section className="metric-section" aria-labelledby="user-metrics-title">
        <div className="metric-section-heading">
          <div>
            <span className="metric-icon">U</span>
            <span>
              <h3 id="user-metrics-title">用户增长与活跃</h3>
              <p>账号注册事实与创建对话的去重用户数。</p>
            </span>
          </div>
        </div>
        <div className="operation-metric-grid">
          <MetricCard label="累计用户" value={stats.users.total} note="全部本地产品账号" />
          <MetricCard
            label="24h 新增"
            value={stats.users.registered24h}
            note="过去 24 小时完成注册"
            tone="positive"
          />
          <MetricCard
            label="7 日活跃用户"
            value={stats.users.active7d}
            note="7 日内更新过对话的创建者去重"
          />
          <MetricCard
            label="已停用用户"
            value={stats.users.disabled}
            note="无法登录且会话已撤销"
            tone={stats.users.disabled > 0 ? "warning" : "default"}
          />
        </div>
      </section>

      <section className="metric-section" aria-labelledby="conversation-metrics-title">
        <div className="metric-section-heading">
          <div>
            <span className="metric-icon">C</span>
            <span>
              <h3 id="conversation-metrics-title">对话使用情况</h3>
              <p>一个 Thread 计为一条对话；Run 是对话内的一次执行。</p>
            </span>
          </div>
        </div>
        <div className="operation-metric-grid">
          <MetricCard label="累计对话" value={stats.conversations.total} note="全部 Thread" />
          <MetricCard
            label="24h 新对话"
            value={stats.conversations.created24h}
            note="过去 24 小时创建"
            tone="positive"
          />
          <MetricCard
            label="24h 活跃对话"
            value={stats.conversations.active24h}
            note="过去 24 小时发生更新"
          />
          <MetricCard
            label="已归档对话"
            value={stats.conversations.archived}
            note="用户主动归档的 Thread"
          />
        </div>
      </section>

      <section className="metric-section" aria-labelledby="reliability-metrics-title">
        <div className="metric-section-heading">
          <div>
            <span className="metric-icon">R</span>
            <span>
              <h3 id="reliability-metrics-title">运行可靠性</h3>
              <p>Run、派发、沙箱和异步记忆链路的实时状态。</p>
            </span>
          </div>
        </div>
        <div className="operation-metric-grid dense">
          <MetricCard label="累计 Run" value={stats.runs.total} note="所有执行记录" />
          <MetricCard
            label="排队 / 执行"
            value={stats.runs.queued + stats.runs.running}
            note={`${stats.runs.queued} 排队 · ${stats.runs.running} 执行`}
          />
          <MetricCard
            label="24h 成功"
            value={stats.runs.succeeded24h}
            note="过去 24 小时成功完成"
            tone="positive"
          />
          <MetricCard
            label="24h 失败"
            value={stats.runs.failed24h}
            note={`${stats.runs.cancelled24h} 个取消`}
            tone={stats.runs.failed24h > 0 ? "warning" : "default"}
          />
          <MetricCard
            label="待派发"
            value={stats.dispatch.pending}
            note={`${stats.dispatch.claimed} 个已认领`}
          />
          <MetricCard
            label="活跃沙箱"
            value={stats.sandboxes.active}
            note={`${stats.sandboxes.paused} 暂停 · ${stats.sandboxes.cleanupPending} 待清理`}
          />
          <MetricCard
            label="记忆积压"
            value={stats.memory.pending}
            note="等待写入 Mem0"
            tone={stats.memory.pending > 0 ? "warning" : "default"}
          />
          <MetricCard
            label="记忆失败"
            value={stats.memory.failed}
            note="需要检查 Mem0 或重试队列"
            tone={stats.memory.failed > 0 ? "warning" : "default"}
          />
        </div>
      </section>

      <section className="metric-definition-panel">
        <div>
          <span className="eyebrow">Metric contract</span>
          <h3>统计口径</h3>
        </div>
        <dl>
          <div>
            <dt>活跃用户</dt>
            <dd>7 日内至少有一条自己创建的对话发生更新，按 userId 去重。</dd>
          </div>
          <div>
            <dt>活跃对话</dt>
            <dd>Thread.updated_at 落在最近 24 小时，不推断正文消息数量。</dd>
          </div>
          <div>
            <dt>记忆积压</dt>
            <dd>写入队列处于 pending、claimed 或 submitted 的记录。</dd>
          </div>
          <div>
            <dt>统计隔离</dt>
            <dd>
              控制服务只能读取聚合视图；模型用量不含 Provider 身份、请求正文、响应正文或密钥。
            </dd>
          </div>
          <div>
            <dt>Tokens/s 与缓存率</dt>
            <dd>
              Tokens/s 使用聚合输出量除以聚合 Assistant
              生成时长；缓存率使用缓存读取除以未缓存输入与缓存读取之和。
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function UserRow({
  user,
  busy,
  selected,
  onSelect,
  onSubmit,
}: {
  readonly user: PlatformUserSummaryDto;
  readonly busy: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onSubmit: () => Promise<void>;
}) {
  const nextStatus = user.status === "active" ? "disabled" : "active";
  return (
    <article className={`user-row ${user.status}`}>
      <span className="user-avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
      <span className="user-identity">
        <strong>{user.displayName}</strong>
        <small>{user.email}</small>
        <code>{user.userId}</code>
      </span>
      <span className="user-usage">
        <strong>{user.conversationCount.toLocaleString("zh-CN")}</strong>
        <small>对话</small>
      </span>
      <span className="user-usage">
        <strong>{user.runCount.toLocaleString("zh-CN")}</strong>
        <small>Run</small>
      </span>
      <span className="user-activity">
        <small>最近活动</small>
        <time>{formatDate(user.lastActiveAt)}</time>
        <small>{user.activeSessions} 个有效登录会话</small>
      </span>
      <span className={`user-status ${user.status}`}>
        {user.status === "active" ? "正常" : "已停用"}
      </span>
      <button
        type="button"
        className="text-button"
        disabled={busy}
        onClick={() => {
          if (user.status === "active") onSelect();
          else void onSubmit();
        }}
      >
        {selected ? "取消" : user.status === "active" ? "停用" : "恢复"}
      </button>
      {selected && user.status === "active" && (
        <form
          className="user-status-confirm"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
        >
          <span>
            <strong>{nextStatus === "disabled" ? "停用该用户" : "恢复该用户"}</strong>
            <small>
              {nextStatus === "disabled"
                ? "提交后将立即拒绝登录并撤销现有会话。"
                : "提交后允许用户重新登录；旧会话不会恢复。"}
            </small>
          </span>
          <button
            type="submit"
            className={nextStatus === "disabled" ? "danger-button" : "primary-button"}
            disabled={busy}
          >
            确认{nextStatus === "disabled" ? "停用" : "恢复"}
          </button>
        </form>
      )}
    </article>
  );
}

export function UserManagementWorkspace({
  value,
  query,
  busy,
  onSearch,
  onStatusChange,
}: {
  readonly value: PlatformUserPageDto | undefined;
  readonly query: string;
  readonly busy: boolean;
  readonly onSearch: (query: string) => void;
  readonly onStatusChange: (userId: string, status: "active" | "disabled") => Promise<boolean>;
}) {
  const [draftQuery, setDraftQuery] = useState(query);
  const [selectedUserId, setSelectedUserId] = useState<string>();
  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSearch(draftQuery.trim());
  };
  return (
    <section className="control-panel user-management">
      <div className="user-management-heading">
        <div>
          <span className="eyebrow">Identity operations</span>
          <h2>用户管理</h2>
          <p>查询产品账号、使用情况和会话状态；操作会自动记录。</p>
        </div>
        <span className="count">{value?.total ?? 0}</span>
      </div>
      <form className="user-search" onSubmit={submitSearch}>
        <input
          aria-label="搜索用户"
          value={draftQuery}
          maxLength={120}
          placeholder="按姓名、邮箱或 userId 搜索"
          onChange={(event) => setDraftQuery(event.target.value)}
        />
        <button type="submit" className="quiet-button" disabled={busy}>
          查询
        </button>
        {query.length > 0 && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setDraftQuery("");
              onSearch("");
            }}
          >
            清除
          </button>
        )}
      </form>
      <div className="user-directory-note">
        <strong>隐私边界</strong>
        <span>目录只包含账号资料与计数，不返回密码散列、盐、Session Token 或对话正文。</span>
      </div>
      {value === undefined ? (
        <p className="empty-state">连接后台控制服务后显示真实用户目录。</p>
      ) : value.items.length === 0 ? (
        <p className="empty-state">没有找到符合条件的用户。</p>
      ) : (
        <div className="user-list">
          {value.items.map((user) => (
            <UserRow
              key={user.userId}
              user={user}
              busy={busy}
              selected={selectedUserId === user.userId}
              onSelect={() =>
                setSelectedUserId((current) => (current === user.userId ? undefined : user.userId))
              }
              onSubmit={async () => {
                const saved = await onStatusChange(
                  user.userId,
                  user.status === "active" ? "disabled" : "active",
                );
                if (saved) setSelectedUserId(undefined);
              }}
            />
          ))}
        </div>
      )}
      {value !== undefined && value.total > value.items.length && (
        <p className="boundary-note">
          当前显示前 {value.items.length} 位用户；请使用搜索缩小范围。
        </p>
      )}
    </section>
  );
}

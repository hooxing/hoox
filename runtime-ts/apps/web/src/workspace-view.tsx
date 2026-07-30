import {
  Archive,
  ChevronRight,
  Download,
  Eye,
  FileText,
  LoaderCircle,
  MessageSquarePlus,
  PanelLeftClose,
  PanelRightClose,
  PanelRightOpen,
  Send,
  Square,
  Wrench,
} from "lucide-react";
import { type FormEventHandler, type ReactNode, type RefObject, useEffect, useRef } from "react";
import {
  type Artifact,
  canPreviewArtifact,
  type ModelWireTraceRecord,
  type Run,
  type RunEvent,
  type RunStatus,
  type Thread,
} from "./api.js";
import { buildTimeline, eventSummary } from "./event-view.js";
import { AssistantMarkdown } from "./markdown-view.js";
import { ModelWireTracePanel } from "./model-wire-trace-view.js";

export const activeRunStatuses = new Set<RunStatus>(["queued", "running", "waiting"]);
export const compactWorkspaceMedia = "(max-width: 820px)";

export function canCreateThread(title: string, actionLoading: boolean): boolean {
  return title.trim().length > 0 && !actionLoading;
}

export function shouldOpenActivityPanel(isCompact: boolean): boolean {
  return !isCompact;
}

const statusLabel: Record<RunStatus, string> = {
  queued: "排队中",
  running: "执行中",
  waiting: "等待输入",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
};

export function RunStatusBadge({ status }: { readonly status: RunStatus | undefined }) {
  if (status === undefined) return <span className="run-status is-ready">就绪</span>;
  return <span className={`run-status is-${status}`}>{statusLabel[status]}</span>;
}

function ActivityIcon({ type }: { readonly type: string }) {
  return type.startsWith("tool.") ? (
    <Wrench size={15} aria-hidden="true" />
  ) : (
    <ChevronRight size={15} aria-hidden="true" />
  );
}

export function RunTimeline({ events }: { readonly events: readonly RunEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="conversation-empty" aria-live="polite">
        <LoaderCircle className="spin" size={18} aria-hidden="true" />
        <span>运行已创建，正在等待第一条活动。</span>
      </div>
    );
  }
  const entries = buildTimeline(events);
  return (
    <ol className="conversation-list" aria-label="运行对话">
      {entries.map((entry) =>
        entry.type === "assistant" ? (
          <li key={entry.id} className="message assistant-message">
            <span className="message-avatar" aria-hidden="true">
              A
            </span>
            <div className="message-card">
              <span className="message-label">Agent</span>
              <AssistantMarkdown text={entry.text} />
            </div>
          </li>
        ) : (
          <li key={entry.event.eventId} className="activity-inline">
            <ActivityIcon type={entry.event.type} />
            <span>{eventSummary(entry.event)}</span>
          </li>
        ),
      )}
    </ol>
  );
}

/**
 * Artifact 归属于整次 Run 而不是单个流式事件；将其紧随对话展示，避免用户离开阅读路径才可操作交付物。
 */
export function InlineArtifactDelivery({
  artifacts,
  onPreview,
  onDownload,
}: {
  readonly artifacts: readonly Artifact[];
  readonly onPreview: (artifactId: string) => void;
  readonly onDownload: (artifactId: string) => void;
}) {
  if (artifacts.length === 0) return null;
  return (
    <section className="inline-artifact-delivery" aria-labelledby="inline-deliverable-title">
      <div className="inline-artifact-heading">
        <div>
          <span className="message-label">Agent 交付物</span>
          <h2 id="inline-deliverable-title">本次回复的可下载产物</h2>
        </div>
        <span className="count-badge">{artifacts.length}</span>
      </div>
      <ul className="artifact-list inline-artifact-list">
        {artifacts.map((artifact) => (
          <li key={artifact.id}>
            <FileText size={17} aria-hidden="true" />
            <div className="artifact-details">
              <strong>{artifact.name}</strong>
              <small>
                {artifact.mediaType ?? "未知格式"} ·{" "}
                {artifact.status === "published" ? "可用" : artifact.status}
              </small>
            </div>
            <fieldset className="artifact-actions">
              <legend className="sr-only">{artifact.name} 操作</legend>
              {canPreviewArtifact(artifact.mediaType) && (
                <button
                  type="button"
                  className="icon-button"
                  title="预览产物"
                  aria-label={`预览 ${artifact.name}`}
                  disabled={artifact.status !== "published"}
                  onClick={() => onPreview(artifact.id)}
                >
                  <Eye size={16} />
                </button>
              )}
              <button
                type="button"
                className="icon-button"
                title="下载产物"
                aria-label={`下载 ${artifact.name}`}
                disabled={artifact.status !== "published"}
                onClick={() => onDownload(artifact.id)}
              >
                <Download size={16} />
              </button>
            </fieldset>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function EmptyConversation() {
  return (
    <div className="conversation-empty welcome-empty">
      <span className="welcome-mark" aria-hidden="true">
        ✦
      </span>
      <div>
        <h2>从一个明确的目标开始</h2>
        <p>描述希望 Agent 完成的任务。执行过程和可交付产物会在这里持续更新。</p>
      </div>
    </div>
  );
}

export function RunRecoveryLoading() {
  return (
    <div className="conversation-empty" aria-live="polite">
      <LoaderCircle className="spin" size={18} aria-hidden="true" />
      <span>正在恢复最新运行…</span>
    </div>
  );
}

export function ActivityPanel({
  isOpen,
  events,
  modelWireTraces,
  modelWireTraceHasMore,
  modelWireTraceUnavailable,
  onToggle,
  onLoadModelWireTrace,
  onLoadMoreModelWireTraces,
}: {
  readonly isOpen: boolean;
  readonly events: readonly RunEvent[];
  readonly modelWireTraces: readonly ModelWireTraceRecord[];
  readonly modelWireTraceHasMore: boolean;
  readonly modelWireTraceUnavailable: boolean;
  readonly onToggle: () => void;
  readonly onLoadModelWireTrace: (record: ModelWireTraceRecord) => Promise<Uint8Array>;
  readonly onLoadMoreModelWireTraces: () => Promise<void>;
}) {
  return (
    <aside className={`activity-panel ${isOpen ? "" : "is-collapsed"}`} aria-label="运行活动与诊断">
      <button
        className="panel-toggle icon-button"
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-label={isOpen ? "收起活动侧栏" : "展开活动侧栏"}
        title={isOpen ? "收起活动侧栏" : "展开活动侧栏"}
      >
        {isOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
      </button>
      {isOpen && (
        <div className="activity-scroll">
          <ModelWireTracePanel
            records={modelWireTraces}
            hasMore={modelWireTraceHasMore}
            unavailable={modelWireTraceUnavailable}
            onLoadBody={onLoadModelWireTrace}
            onLoadMore={onLoadMoreModelWireTraces}
          />
          <section className="activity-section activity-log" aria-labelledby="activity-title">
            <div className="section-heading">
              <div>
                <span className="eyebrow">活动</span>
                <h2 id="activity-title">安全摘要</h2>
              </div>
              <span className="count-badge">{events.length}</span>
            </div>
            {events.length === 0 ? (
              <p className="panel-empty">尚无运行活动。</p>
            ) : (
              <ol className="activity-list">
                {events.map((event) => (
                  <li key={event.eventId}>
                    <ActivityIcon type={event.type} />
                    <span>{eventSummary(event)}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </aside>
  );
}

export function ConversationComposer({
  input,
  disabled,
  onChange,
  onSubmit,
}: {
  readonly input: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit: FormEventHandler<HTMLFormElement>;
}) {
  return (
    <form className="composer" onSubmit={onSubmit}>
      <label className="sr-only" htmlFor="agent-request">
        发送给 Agent 的任务
      </label>
      <textarea
        id="agent-request"
        value={input}
        onChange={(event) => onChange(event.target.value)}
        placeholder="描述你希望 Agent 完成的任务…"
        rows={3}
        disabled={disabled}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div className="composer-footer">
        <span>Ctrl / ⌘ + Enter 发送</span>
        <button type="submit" className="send-button" disabled={disabled || !input.trim()}>
          <Send size={16} />
          发送
        </button>
      </div>
    </form>
  );
}

export function ThreadNavigation({ children }: { readonly children: ReactNode }) {
  return (
    <nav className="thread-list" aria-label="会话列表">
      {children}
    </nav>
  );
}

export function ThreadCreate({
  title,
  actionLoading,
  onChange,
  onCreate,
}: {
  readonly title: string;
  readonly actionLoading: boolean;
  readonly onChange: (value: string) => void;
  readonly onCreate: () => void;
}) {
  const canCreate = canCreateThread(title, actionLoading);
  const submissionInFlightRef = useRef(actionLoading);
  useEffect(() => {
    submissionInFlightRef.current = actionLoading;
  }, [actionLoading]);
  const requestCreate = () => {
    if (!canCreate || submissionInFlightRef.current) return;
    // React 提交状态写回前也可能连续收到键盘事件，本地栅栏同步阻止同一标题重入。
    submissionInFlightRef.current = true;
    onCreate();
  };
  return (
    <div className="thread-create">
      <label className="sr-only" htmlFor="thread-title">
        新建会话标题
      </label>
      <input
        id="thread-title"
        data-navigation-initial-focus
        value={title}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && canCreate) {
            event.preventDefault();
            requestCreate();
          }
        }}
        placeholder="新建会话标题"
        disabled={actionLoading}
      />
      <button
        type="button"
        className="icon-button"
        title="创建会话"
        aria-label="创建会话"
        onClick={requestCreate}
        disabled={!canCreate}
      >
        <MessageSquarePlus size={17} />
      </button>
    </div>
  );
}

export function NavigationSidebar({
  isCompact,
  isOpen,
  returnFocusRef,
  onClose,
  children,
}: {
  readonly isCompact: boolean;
  readonly isOpen: boolean;
  readonly returnFocusRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const sidebarRef = useRef<HTMLElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!isCompact) {
      wasOpenRef.current = false;
      return;
    }
    if (isOpen) {
      wasOpenRef.current = true;
      const initialFocus =
        sidebarRef.current?.querySelector<HTMLElement>(
          "[data-navigation-initial-focus]:not(:disabled)",
        ) ?? sidebarRef.current?.querySelector<HTMLElement>("button:not(:disabled)");
      initialFocus?.focus();
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      returnFocusRef.current?.focus();
    }
  }, [isCompact, isOpen, returnFocusRef]);

  const hidden = isCompact && !isOpen;
  return (
    <aside
      ref={sidebarRef}
      className="sidebar"
      aria-label="会话导航"
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
      onKeyDown={(event) => {
        if (isCompact && isOpen && event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="brand-row">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            C
          </span>
          <span>Cube Agent</span>
        </div>
        <button
          className="mobile-only icon-button"
          type="button"
          onClick={onClose}
          aria-label="关闭会话导航"
        >
          <PanelLeftClose size={18} />
        </button>
      </div>
      {children}
    </aside>
  );
}

export function ThreadHeader({
  thread,
  run,
  actionLoading,
  onArchive,
  onCancel,
}: {
  readonly thread: Thread;
  readonly run: Run | undefined;
  readonly actionLoading: boolean;
  readonly onArchive: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <header className="conversation-header">
      <div>
        <div className="header-meta">
          <span className="connection-dot" aria-hidden="true" />
          本地 Agent 会话
        </div>
        <h1>{thread.title}</h1>
        <div className="run-meta">
          <RunStatusBadge status={run?.status} />
          {run && <span>运行 {run.id}</span>}
        </div>
      </div>
      <div className="header-actions">
        {run && activeRunStatuses.has(run.status) && (
          <button
            type="button"
            className="quiet-button"
            onClick={onCancel}
            disabled={actionLoading}
          >
            <Square size={14} />
            停止运行
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          title="归档会话"
          aria-label="归档会话"
          onClick={onArchive}
          disabled={actionLoading}
        >
          <Archive size={17} />
        </button>
      </div>
    </header>
  );
}

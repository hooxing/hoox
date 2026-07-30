import {
  Archive,
  ChevronRight,
  Download,
  Eye,
  FileText,
  LoaderCircle,
  MessageSquarePlus,
  Package,
  PanelLeftClose,
  PanelRightClose,
  PanelRightOpen,
  Send,
  Square,
} from "lucide-react";
import {
  type FormEventHandler,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type Artifact,
  canPreviewArtifact,
  type Run,
  type RunEvent,
  type RunStatus,
  type Thread,
} from "./api.js";
import { buildRunProgress } from "./event-view.js";
import { AssistantMarkdown } from "./markdown-view.js";

/** waiting 仍可取消，但不代表 Worker 正在执行。 */
export const cancellableRunStatuses = new Set<RunStatus>(["queued", "running", "waiting"]);
/** 仅尚会自行变化的 Run 继续短轮询；waiting 由用户下一次提交恢复。 */
export const pollingRunStatuses = new Set<RunStatus>(["queued", "running"]);
export const timedRunStatuses = new Set<RunStatus>(["running"]);
export const compactWorkspaceMedia = "(max-width: 820px)";
export const composerTextareaResize = "none";

export function canCreateThread(title: string, actionLoading: boolean): boolean {
  return title.trim().length > 0 && !actionLoading;
}

export function shouldOpenActivityPanel(_isCompact: boolean): boolean {
  // 无产物时侧栏收敛；首个产物到达后由工作台自动展开。
  return false;
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

function useElapsedSeconds(run: Run | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (run === undefined || !timedRunStatuses.has(run.status)) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [run]);
  if (run === undefined) return 0;
  const startedAt = Date.parse(run.createdAt);
  return Number.isFinite(startedAt) ? Math.max(0, Math.floor((now - startedAt) / 1_000)) : 0;
}

function elapsedLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`;
}

export function RunTimeline({
  run,
  events,
}: {
  readonly run: Run;
  readonly events: readonly RunEvent[];
}) {
  const progress = buildRunProgress(events);
  const isRunning = timedRunStatuses.has(run.status);
  const isQueued = run.status === "queued";
  const isWaiting = run.status === "waiting";
  const showActivity = isRunning || isQueued;
  const elapsed = useElapsedSeconds(run);
  const isFailure = run.status === "failed" || run.status === "cancelled";
  const summary = isFailure
    ? run.status === "cancelled"
      ? "运行已停止。你可以调整任务后再次发送。"
      : "运行未完成。请稍后重试，或调整任务后再次发送。"
    : isWaiting
      ? "需要你的输入"
      : isRunning
        ? progress.currentAction
        : isQueued
          ? "正在排队，准备开始任务。"
          : run.status === "succeeded"
            ? "已完成本次任务。"
            : "等待你的下一步输入。";
  return (
    <section
      className={`run-progress ${showActivity ? "is-active" : ""} ${isFailure ? "is-failed" : ""}`}
      aria-label="运行进度"
      aria-live="polite"
    >
      <div className="run-progress-summary">
        {showActivity ? (
          <LoaderCircle className="spin" size={18} aria-hidden="true" />
        ) : (
          <ChevronRight size={18} aria-hidden="true" />
        )}
        <div>
          <strong>{summary}</strong>
          <span>
            {isRunning ? `已运行 ${elapsedLabel(elapsed)} · ` : ""}已完成{" "}
            {progress.steps.filter((step) => step.status === "completed").length} 步
          </span>
        </div>
      </div>
      {progress.steps.length > 0 && (
        <details className="run-progress-history">
          <summary>查看简要步骤</summary>
          <ol>
            {progress.steps.map((step) => (
              <li key={step.id} className={`is-${step.status}`}>
                <span>{step.label.replace("正在", "")}</span>
                {step.count > 1 && <small>× {step.count}</small>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

export function RunTranscript({ events }: { readonly events: readonly RunEvent[] }) {
  const progress = buildRunProgress(events);
  if (progress.finalMessage === undefined && progress.waitingQuestion === undefined) return null;
  return (
    <section className="assistant-transcript" aria-label="Agent 正文">
      {progress.finalMessage !== undefined && <AssistantMessage text={progress.finalMessage} />}
      {progress.waitingQuestion !== undefined && (
        <AssistantMessage label="需要你的输入" text={progress.waitingQuestion} />
      )}
    </section>
  );
}

export function AssistantMessage({
  text,
  label = "Agent",
}: {
  readonly text: string;
  readonly label?: string;
}) {
  return (
    <article className="message assistant-message" aria-label={label}>
      <span className="message-avatar" aria-hidden="true">
        A
      </span>
      <div className="message-card">
        <span className="message-label">{label}</span>
        <AssistantMarkdown text={text} />
      </div>
    </article>
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
  artifacts,
  onToggle,
  onPreview,
  onDownload,
  returnFocusRef,
  fallbackFocusRef,
}: {
  readonly isOpen: boolean;
  readonly artifacts: readonly Artifact[];
  readonly onToggle: () => void;
  readonly onPreview: (artifactId: string) => void;
  readonly onDownload: (artifactId: string) => void;
  readonly returnFocusRef: RefObject<HTMLButtonElement | null>;
  readonly fallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  const open = isOpen && artifacts.length > 0;
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      closeButtonRef.current?.focus();
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      // 切换 Thread 后旧的产物入口可能已卸载，退回到中部工作区而非保留失效焦点。
      const returnTarget = returnFocusRef.current;
      if (returnTarget !== null) returnTarget.focus();
      else fallbackFocusRef.current?.focus();
    }
  }, [fallbackFocusRef, open, returnFocusRef]);
  if (artifacts.length === 0) return null;
  return (
    <aside
      className={`activity-panel ${open ? "" : "is-collapsed"}`}
      aria-label="本次运行产物"
      aria-hidden={!open || undefined}
      inert={!open || undefined}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          onToggle();
        }
      }}
    >
      <button
        ref={closeButtonRef}
        className="panel-toggle icon-button"
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? "关闭产物抽屉" : "打开产物抽屉"}
        title={open ? "关闭产物抽屉" : "打开产物抽屉"}
      >
        {open ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
      </button>
      {open && (
        <div className="activity-scroll">
          <section className="activity-section" aria-labelledby="deliverable-title">
            <div className="section-heading">
              <div>
                <span className="eyebrow">交付物</span>
                <h2 id="deliverable-title">本次运行产物</h2>
              </div>
              <span className="count-badge">{artifacts.length}</span>
            </div>
            {artifacts.length === 0 ? (
              <p className="panel-empty">尚未生成可交付的产物。</p>
            ) : (
              <ul className="artifact-list">
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
        style={{ resize: composerTextareaResize }}
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
  actionLoading,
  onCreate,
}: {
  readonly actionLoading: boolean;
  readonly onCreate: () => void;
}) {
  const requestCreate = () => {
    if (actionLoading) return;
    onCreate();
  };
  return (
    <div className="thread-create">
      <button
        data-navigation-initial-focus
        type="button"
        className="new-thread-button"
        title="新建会话"
        aria-label="新建会话"
        onClick={requestCreate}
        disabled={actionLoading}
      >
        <MessageSquarePlus size={17} />
        新建会话
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
  artifactCount,
  actionLoading,
  onArchive,
  onCancel,
  onOpenArtifacts,
  artifactTriggerRef,
}: {
  readonly thread: Thread;
  readonly run: Run | undefined;
  readonly artifactCount: number;
  readonly actionLoading: boolean;
  readonly onArchive: () => void;
  readonly onCancel: () => void;
  readonly onOpenArtifacts: () => void;
  readonly artifactTriggerRef: RefObject<HTMLButtonElement | null>;
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
        {run && cancellableRunStatuses.has(run.status) && (
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
        {artifactCount > 0 && (
          <button
            ref={artifactTriggerRef}
            type="button"
            className="quiet-button artifact-entry-button"
            onClick={onOpenArtifacts}
            aria-label={`打开本次运行产物，共 ${artifactCount} 个`}
            title="查看本次运行产物"
          >
            <Package size={15} />
            产物 <span>{artifactCount}</span>
          </button>
        )}
        <button
          type="button"
          className="quiet-button archive-button"
          title="归档会话"
          aria-label="归档会话"
          onClick={onArchive}
          disabled={actionLoading}
        >
          <Archive size={17} />
          归档
        </button>
      </div>
    </header>
  );
}

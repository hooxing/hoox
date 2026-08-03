import {
  Archive,
  ChevronRight,
  Download,
  Eye,
  FileText,
  LoaderCircle,
  MessageSquarePlus,
  PanelLeftClose,
  Paperclip,
  Send,
  Square,
  X,
} from "lucide-react";
import {
  type FormEventHandler,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
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
  type ThreadContextMessage,
  type ThreadContinuityStatus,
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

const statusLabel: Record<RunStatus, string> = {
  queued: "排队中",
  running: "执行中",
  waiting: "等待输入",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
};

export function RunStatusBadge({
  status,
  executionStatus,
}: {
  readonly status: RunStatus | undefined;
  readonly executionStatus?: Run["executionStatus"];
}) {
  if (status === undefined) return <span className="run-status is-ready">就绪</span>;
  if (executionStatus === "recovery_required") {
    return <span className="run-status is-recovery-required">执行已中断</span>;
  }
  return <span className={`run-status is-${status}`}>{statusLabel[status]}</span>;
}

function useElapsedSeconds(run: Run | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (
      run === undefined ||
      run.executionStatus === "recovery_required" ||
      !timedRunStatuses.has(run.status)
    )
      return;
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

function RunThinkingPanel({
  text,
  status,
  run,
}: {
  readonly text: string;
  readonly status: "running" | "completed";
  readonly run: Run;
}) {
  const recoveryRequired = run.executionStatus === "recovery_required";
  const isLive = status === "running" && run.status === "running" && !recoveryRequired;
  const wasInterrupted = status === "running" && !isLive;
  const visibleStatus = isLive ? "running" : wasInterrupted ? "stopped" : "completed";
  const statusText = isLive
    ? "正在思考"
    : wasInterrupted && recoveryRequired
      ? "思考已中断"
      : wasInterrupted
        ? "思考已结束"
        : "思考已完成";
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const followLatestRef = useRef(true);
  const summaryId = useId();
  const contentId = useId();

  useEffect(() => {
    // 每段实时思考自动展开，收到终态或 Run 先行结束时自动折叠；终态下的手工选择随后保持不变。
    const details = detailsRef.current;
    if (details !== null) details.open = visibleStatus === "running";
    if (visibleStatus === "running") followLatestRef.current = true;
  }, [visibleStatus]);

  useEffect(() => {
    // text 只作为增量触发器；用户已向上阅读时不抢夺滚动位置。
    void text;
    const content = contentRef.current;
    if (
      content !== null &&
      visibleStatus === "running" &&
      detailsRef.current?.open === true &&
      followLatestRef.current
    ) {
      content.scrollTop = content.scrollHeight;
    }
  }, [text, visibleStatus]);

  return (
    <details
      ref={detailsRef}
      className={`run-thinking is-${visibleStatus}`}
      open={visibleStatus === "running"}
    >
      <summary id={summaryId} aria-controls={contentId}>
        <ChevronRight className="run-thinking-chevron" size={14} aria-hidden="true" />
        {isLive ? (
          <LoaderCircle className="run-thinking-spinner spin" size={14} aria-hidden="true" />
        ) : (
          <span className="run-thinking-indicator" aria-hidden="true">
            {wasInterrupted ? "!" : "✓"}
          </span>
        )}
        <span className="run-thinking-copy">
          <strong aria-live="polite">{statusText}</strong>
          <small>
            <span className="when-collapsed">{isLive ? "展开实时内容" : "展开查看"}</span>
            <span className="when-expanded">{isLive ? "实时更新中" : "收起"}</span>
          </small>
        </span>
      </summary>
      <section
        ref={contentRef}
        id={contentId}
        className="run-thinking-content"
        aria-labelledby={summaryId}
        aria-busy={isLive}
        aria-live="off"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 限高滚动区必须可由键盘聚焦后滚动。
        tabIndex={0}
        onScroll={(event) => {
          const content = event.currentTarget;
          followLatestRef.current =
            content.scrollHeight - content.scrollTop - content.clientHeight <= 24;
        }}
      >
        <AssistantMarkdown text={text} />
      </section>
    </details>
  );
}

export function RunTimeline({
  run,
  events,
}: {
  readonly run: Run;
  readonly events: readonly RunEvent[];
}) {
  const progress = buildRunProgress(events);
  const recoveryRequired = run.executionStatus === "recovery_required";
  const isRunning = !recoveryRequired && timedRunStatuses.has(run.status);
  const isQueued = run.status === "queued";
  const isWaiting = run.status === "waiting";
  const showActivity = isRunning || isQueued;
  const elapsed = useElapsedSeconds(run);
  const isFailure = recoveryRequired || run.status === "failed" || run.status === "cancelled";
  const summary = recoveryRequired
    ? "执行已中断"
    : run.status === "cancelled"
      ? "已取消"
      : run.status === "failed"
        ? "执行失败"
        : isWaiting
          ? "等待你的输入"
          : isRunning
            ? progress.currentAction
            : isQueued
              ? "排队中"
              : run.status === "succeeded"
                ? "已完成"
                : "就绪";
  return (
    <section
      className={`run-progress ${showActivity ? "is-active" : ""} ${isFailure ? "is-failed" : ""}`}
      aria-label="运行进度"
      aria-live="polite"
    >
      <div className="run-progress-summary">
        <div className="run-progress-primary">
          {showActivity ? (
            <LoaderCircle className="spin" size={16} aria-hidden="true" />
          ) : (
            <ChevronRight size={16} aria-hidden="true" />
          )}
          <div>
            <strong>{summary}</strong>
            {isRunning && <span>已运行 {elapsedLabel(elapsed)}</span>}
          </div>
        </div>
      </div>
    </section>
  );
}

export function RunTranscript({
  run,
  events,
}: {
  readonly run: Run;
  readonly events: readonly RunEvent[];
}) {
  const progress = buildRunProgress(events);
  if (
    progress.thinking === undefined &&
    progress.finalMessage === undefined &&
    progress.waitingQuestion === undefined
  )
    return null;
  return (
    <section className="assistant-transcript" aria-label="Agent 正文">
      {(progress.thinking !== undefined || progress.finalMessage !== undefined) && (
        <AssistantMessage
          text={progress.finalMessage ?? ""}
          contentBefore={
            progress.thinking === undefined ? undefined : (
              <RunThinkingPanel
                text={progress.thinking.text}
                status={progress.thinking.status}
                run={run}
              />
            )
          }
        />
      )}
      {progress.waitingQuestion !== undefined && (
        <AssistantMessage label="需要你的输入" text={progress.waitingQuestion} />
      )}
    </section>
  );
}

export function ThreadTranscript({
  messages,
  pendingInputs = [],
  currentRun,
  currentRunEvents = [],
}: {
  readonly messages: readonly ThreadContextMessage[];
  readonly pendingInputs?: readonly PendingThreadInputView[];
  readonly currentRun?: Run;
  readonly currentRunEvents?: readonly RunEvent[];
}) {
  if (messages.length === 0 && pendingInputs.length === 0) return null;
  const currentProgress = currentRun === undefined ? undefined : buildRunProgress(currentRunEvents);
  return (
    <section className="assistant-transcript" aria-label="Thread 连续对话">
      {messages.map((message) =>
        message.role === "user" ? (
          <article className="message user-request" key={message.sequence}>
            <div className="message-card">
              <span className="message-label">你的请求</span>
              <p>{message.text}</p>
            </div>
          </article>
        ) : message.role === "assistant" ? (
          <AssistantMessage
            key={message.sequence}
            text={message.text}
            contentBefore={
              currentRun !== undefined &&
              message.runId === currentRun.id &&
              currentProgress?.thinking !== undefined ? (
                <RunThinkingPanel
                  text={currentProgress.thinking.text}
                  status={currentProgress.thinking.status}
                  run={currentRun}
                />
              ) : undefined
            }
          />
        ) : shouldDisplayRuntimeContextMessage(message.text) ? (
          <p className="runtime-context-notice" key={message.sequence}>
            {message.text}
          </p>
        ) : null,
      )}
      {pendingInputs.map((input) => (
        <article className="message user-request is-pending" key={input.localId}>
          <div className="message-card">
            <span className="message-label">你的请求</span>
            <p>{input.text}</p>
            <small className={`conversation-input-status is-${input.disposition}`}>
              {threadInputDispositionLabel(input)}
            </small>
          </div>
        </article>
      ))}
    </section>
  );
}

export function shouldDisplayRuntimeContextMessage(text: string): boolean {
  return text.trim() !== "运行已完成。";
}

export type PendingThreadInputView = {
  readonly localId: string;
  readonly text: string;
  readonly disposition:
    | "submitting"
    | "pending_steer"
    | "steered"
    | "queued"
    | "cancelled"
    | "rejected";
  readonly queueSequence?: number;
  readonly rejectionCode?: string;
};

function threadInputDispositionLabel(input: PendingThreadInputView): string {
  switch (input.disposition) {
    case "submitting":
      return "正在发送";
    case "pending_steer":
      return "等待下一个安全点";
    case "steered":
      return "已进入当前任务";
    case "queued":
      return `已排入下一任务${input.queueSequence === undefined ? "" : ` · 第 ${input.queueSequence} 位`}`;
    case "cancelled":
      return "已取消";
    case "rejected":
      return `未应用${input.rejectionCode === undefined ? "" : ` · ${input.rejectionCode}`}`;
  }
}

export function AssistantMessage({
  text,
  label = "Agent",
  contentBefore,
}: {
  readonly text: string;
  readonly label?: string;
  readonly contentBefore?: ReactNode;
}) {
  return (
    <article className="message assistant-message" aria-label={label}>
      <span className="message-avatar" aria-hidden="true">
        A
      </span>
      <div className="message-card">
        <span className="message-label">{label}</span>
        {contentBefore}
        {text.length > 0 && <AssistantMarkdown text={text} />}
      </div>
    </article>
  );
}

/**
 * Artifact 仍归属于整次 Run；抽屉用于集中操作，内联卡片保证交付物不会脱离 Agent 正文的阅读路径。
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
          <span className="message-label">交付结果</span>
          <h2 id="inline-deliverable-title">交付文件</h2>
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
                {formatArtifactType(artifact.mediaType, artifact.name)}
                {artifact.sizeBytes === undefined
                  ? ""
                  : ` · ${formatArtifactSize(artifact.sizeBytes)}`}
              </small>
            </div>
            <fieldset className="artifact-actions">
              <legend className="sr-only">{artifact.name} 操作</legend>
              {canPreviewArtifact(artifact.mediaType) && (
                <button
                  type="button"
                  className="artifact-action-button"
                  title="预览产物"
                  aria-label={`预览 ${artifact.name}`}
                  disabled={artifact.status !== "published"}
                  onClick={() => onPreview(artifact.id)}
                >
                  <Eye size={16} />
                  <span>预览</span>
                </button>
              )}
              <button
                type="button"
                className="artifact-action-button is-primary"
                title="下载产物"
                aria-label={`下载 ${artifact.name}`}
                disabled={artifact.status !== "published"}
                onClick={() => onDownload(artifact.id)}
              >
                <Download size={16} />
                <span>下载</span>
              </button>
            </fieldset>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function formatArtifactType(mediaType: string | undefined, name: string): string {
  const normalized = mediaType?.split(";", 1)[0]?.trim().toLowerCase();
  const knownTypes: Readonly<Record<string, string>> = {
    "application/json": "JSON 文件",
    "application/pdf": "PDF 文档",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel 工作簿",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word 文档",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      "PowerPoint 演示文稿",
    "image/gif": "GIF 图片",
    "image/jpeg": "JPEG 图片",
    "image/png": "PNG 图片",
    "image/webp": "WebP 图片",
    "text/csv": "CSV 表格",
    "text/markdown": "Markdown 文档",
    "text/plain": "文本文件",
  };
  if (normalized !== undefined && knownTypes[normalized] !== undefined) {
    return knownTypes[normalized];
  }
  const extension = name.includes(".") ? name.split(".").pop()?.trim().toUpperCase() : undefined;
  return extension ? `${extension} 文件` : "文件";
}

export function formatArtifactSize(sizeBytes: number): string {
  if (sizeBytes < 1_024) return `${sizeBytes} B`;
  if (sizeBytes < 1_048_576) return `${(sizeBytes / 1_024).toFixed(sizeBytes < 10_240 ? 1 : 0)} KB`;
  return `${(sizeBytes / 1_048_576).toFixed(sizeBytes < 10_485_760 ? 1 : 0)} MB`;
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

export function ConversationComposer({
  input,
  files,
  disabled,
  onChange,
  onFilesChange,
  onSubmit,
  showQueueAction,
  onQueue,
}: {
  readonly input: string;
  readonly files: readonly File[];
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
  readonly onFilesChange: (files: readonly File[]) => void;
  readonly onSubmit: FormEventHandler<HTMLFormElement>;
  readonly showQueueAction: boolean;
  readonly onQueue: () => void;
}) {
  return (
    <form className="composer" onSubmit={onSubmit}>
      {files.length > 0 && (
        <ul className="composer-files" aria-label="待上传文件">
          {files.map((file, index) => (
            <li className="composer-file" key={composerFileKey(file)}>
              <span title={file.name}>{file.name}</span>
              <button
                type="button"
                aria-label={`移除文件 ${file.name}`}
                disabled={disabled}
                onClick={() =>
                  onFilesChange(files.filter((_candidate, ordinal) => ordinal !== index))
                }
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="sr-only" htmlFor="agent-request">
        发送给 Agent 的任务
      </label>
      <textarea
        id="agent-request"
        value={input}
        onChange={(event) => onChange(event.target.value)}
        placeholder="描述你希望 Agent 完成的任务…"
        rows={2}
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
        <label className="attachment-button" title="上传文件">
          <Paperclip size={16} aria-hidden="true" />
          <span>上传文件</span>
          <input
            type="file"
            multiple
            disabled={disabled}
            onChange={(event) => {
              const selected = Array.from(event.target.files ?? []);
              onFilesChange(
                [...files, ...selected]
                  .filter(
                    (file, index, combined) =>
                      combined.findIndex(
                        (candidate) => composerFileKey(candidate) === composerFileKey(file),
                      ) === index,
                  )
                  .slice(0, 20),
              );
              event.target.value = "";
            }}
          />
        </label>
        <span>Ctrl / ⌘ + Enter 发送</span>
        {showQueueAction && (
          <button
            type="button"
            className="queue-button"
            disabled={disabled || (!input.trim() && files.length === 0)}
            onClick={onQueue}
          >
            排队下一任务
          </button>
        )}
        <button
          type="submit"
          className="send-button"
          title="发送"
          aria-label="发送任务"
          disabled={disabled || (!input.trim() && files.length === 0)}
        >
          <Send size={16} />
          <span className="send-label">发送</span>
        </button>
      </div>
    </form>
  );
}

function composerFileKey(file: File): string {
  return `${file.name}\0${file.size}\0${file.type}\0${file.lastModified}`;
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
  continuity,
  actionLoading,
  onArchive,
  onCancel,
}: {
  readonly thread: Thread;
  readonly run: Run | undefined;
  readonly continuity?: ThreadContinuityStatus;
  /** @deprecated 右侧活动栏已移除，仅为旧调用方提供无行为的迁移兼容。 */
  readonly artifactCount?: number;
  readonly modelWireTraceCount?: number;
  readonly modelWireTraceUnavailable?: boolean;
  readonly actionLoading: boolean;
  readonly onArchive: () => void;
  readonly onCancel: () => void;
  readonly onOpenArtifacts?: () => void;
  readonly artifactTriggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const workspaceStateLabel =
    continuity?.sandboxState === "pausing"
      ? "工作区正在暂停"
      : continuity?.sandboxState === "resuming"
        ? "工作区正在恢复"
        : continuity?.sandboxState === "paused"
          ? "工作区已暂停"
          : undefined;
  return (
    <header className="conversation-header" data-run-id={run?.id}>
      <div className="conversation-title">
        <h1 title={thread.title}>{thread.title}</h1>
        <div className="run-meta">
          <RunStatusBadge status={run?.status} executionStatus={run?.executionStatus} />
          {workspaceStateLabel !== undefined && <span>{workspaceStateLabel}</span>}
          {(continuity?.queueDepth ?? 0) > 0 && <span>后续任务 {continuity?.queueDepth}</span>}
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
            <span>{run.executionStatus === "recovery_required" ? "结束本次运行" : "停止运行"}</span>
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
          <span>归档</span>
        </button>
      </div>
    </header>
  );
}

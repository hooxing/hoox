import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  Download,
  Eye,
  FileText,
  GitBranch,
  LoaderCircle,
  MessageSquarePlus,
  PanelLeftClose,
  Paperclip,
  Send,
  Square,
  Users,
  X,
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
  type HistoryFile,
  type Run,
  type RunEvent,
  type RunStatus,
  type Thread,
  type ThreadContextMessage,
  type ThreadContinuityStatus,
  type RuntimeApi,
} from "./api.js";
import {
  buildConversationBlocks,
  buildConversationSections,
  buildRunProgress,
  type ConversationBlock,
  type ToolAction,
} from "./event-view.js";
import { AssistantMarkdown } from "./markdown-view.js";

/** waiting 仍可取消，但不代表 Worker 正在执行。 */
export const cancellableRunStatuses = new Set<RunStatus>(["queued", "running", "waiting"]);
/** 仅尚会自行变化的 Run 继续短轮询；waiting 由用户下一次提交恢复。 */
export const pollingRunStatuses = new Set<RunStatus>(["queued", "running"]);
export const timedRunStatuses = new Set<RunStatus>(["running"]);
export const compactWorkspaceMedia = "(max-width: 820px)";
export const composerTextareaResize = "none";
export const userRequestCollapsedHeight = 264;
export const userRequestCollapseCharacterThreshold = 600;

export function shouldInitiallyCollapseUserRequest(text: string): boolean {
  const visualLines = text.split(/\r?\n/u).length;
  return text.length > userRequestCollapseCharacterThreshold || visualLines > 11;
}

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
  const completedTodos = progress.todo?.todos.filter((todo) => todo.status === "completed").length;
  const currentTodo = progress.todo?.todos.find((todo) => todo.status === "in_progress");
  const defaultProgressExpanded = isRunning || isQueued || isWaiting;
  const progressDisclosureKey = `${run.id}:${run.status}:${run.executionStatus ?? "normal"}`;
  const [progressDisclosure, setProgressDisclosure] = useState(() => ({
    key: progressDisclosureKey,
    open: defaultProgressExpanded,
  }));
  const progressExpanded =
    progressDisclosure.key === progressDisclosureKey
      ? progressDisclosure.open
      : defaultProgressExpanded;
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
  const summaryContent = (
    <div className="run-progress-primary">
      {progress.todo !== undefined ? (
        <ChevronRight className="run-progress-chevron" size={16} aria-hidden="true" />
      ) : showActivity ? (
        <LoaderCircle className="spin" size={16} aria-hidden="true" />
      ) : (
        <ChevronRight size={16} aria-hidden="true" />
      )}
      <div>
        <strong>{currentTodo?.content ?? summary}</strong>
        {progress.todo !== undefined ? (
          <span>
            {completedTodos}/{progress.todo.todos.length}
          </span>
        ) : (
          isRunning && <span>已运行 {elapsedLabel(elapsed)}</span>
        )}
      </div>
    </div>
  );
  const todoContent =
    progress.todo === undefined ? undefined : (
      <section className="run-todo" aria-label="任务清单">
        <div className="run-todo-heading">
          <span>任务清单</span>
          <span>
            {completedTodos}/{progress.todo.todos.length}
          </span>
        </div>
        <ol className="run-todo-list">
          {progress.todo.todos.map((todo) => (
            <li className={`is-${todo.status}`} key={todo.id}>
              {todo.status === "completed" ? (
                <Check size={14} aria-hidden="true" />
              ) : todo.status === "in_progress" ? (
                <LoaderCircle className="spin" size={14} aria-hidden="true" />
              ) : (
                <Circle size={14} aria-hidden="true" />
              )}
              <span className="sr-only">
                {todo.status === "completed"
                  ? "已完成："
                  : todo.status === "in_progress"
                    ? "执行中："
                    : "待处理："}
              </span>
              <span>{todo.content}</span>
            </li>
          ))}
        </ol>
      </section>
    );
  return (
    <section
      className={`run-progress ${showActivity ? "is-active" : ""} ${isFailure ? "is-failed" : ""}`}
      aria-label="运行进度"
      aria-live="polite"
    >
      {todoContent === undefined ? (
        <div className="run-progress-summary">{summaryContent}</div>
      ) : (
        <details
          className="run-progress-details"
          open={progressExpanded}
          onToggle={(event) =>
            setProgressDisclosure({ key: progressDisclosureKey, open: event.currentTarget.open })
          }
        >
          <summary className="run-progress-summary">{summaryContent}</summary>
          {todoContent}
        </details>
      )}
    </section>
  );
}

function terminalFallbackAnswer(
  run: Run,
  events: readonly RunEvent[],
  blocks: readonly ConversationBlock[],
): Extract<ConversationBlock, { type: "answer" }> | undefined {
  if (blocks.some((block) => block.type === "answer")) return undefined;
  const terminal =
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.executionStatus === "recovery_required";
  if (!terminal) return undefined;
  const code = [...events]
    .reverse()
    .map((event) => (event.type === "attempt_state_changed" ? event.payload : undefined))
    .map((payload) =>
      typeof payload === "object" && payload !== null && "code" in payload
        ? (payload as { readonly code?: unknown }).code
        : undefined,
    )
    .find((candidate): candidate is string => typeof candidate === "string");
  return {
    id: `runtime-terminal-fallback-${run.id}`,
    type: "answer",
    text: terminalFallbackText(run, code),
    status: "completed",
  };
}

function terminalFallbackText(run: Run, code: string | undefined): string {
  if (run.status === "cancelled" || code === "CANCELLED") {
    return "任务已取消；未完成或未提交的工作不视为成功。";
  }
  const messages: Readonly<Record<string, string>> = {
    CONTEXT_TOO_LARGE: "上下文仍然超出模型窗口，本次任务未能完成。",
    TIMEOUT: "任务运行超时，本次任务未能完成。",
    PROVIDER: "模型服务调用失败，本次任务未能完成，请稍后重试。",
    PROTOCOL: "模型响应未形成有效终态，本次任务未能完成。",
    EVENT_REJECTED: "运行事件无法可靠保存，本次任务已中断。",
    WORKER_SHUTDOWN: "执行 Worker 已停止，本次任务已中断。",
    PERSISTENCE_UNAVAILABLE: "运行状态暂时无法可靠保存，本次任务已中断。",
    FENCE_LOST: "运行执行权已转移，本次任务已中断，未确认的工作不视为成功。",
    SANDBOX_UNKNOWN: "Sandbox 状态无法确认，本次任务已中断，未确认的修改不视为成功。",
    SANDBOX_FAILED: "Sandbox 连续调用失败，本次任务未能完成。",
    WORKSPACE_CONFLICT: "工作区验证或提交发生冲突，本次修改未确认成功。",
    ARTIFACT_NOT_READY: "交付文件尚未可靠发布，本次交付未确认成功。",
    IDEMPOTENCY_CONFLICT: "运行状态发生幂等冲突，本次任务已中断。",
    INTERNAL: "系统内部处理失败，本次任务未能完成。",
  };
  return (
    (code === undefined ? undefined : messages[code]) ??
    (run.executionStatus === "recovery_required"
      ? "系统遇到无法安全继续的异常，本次任务已中断。"
      : "系统执行失败，本次任务未能完成。")
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
  const projectedBlocks = buildConversationBlocks(events);
  const fallback = terminalFallbackAnswer(run, events, projectedBlocks);
  const blocks = fallback === undefined ? projectedBlocks : [...projectedBlocks, fallback];
  if (
    progress.thinking === undefined &&
    blocks.length === 0 &&
    progress.finalMessage === undefined &&
    progress.waitingQuestion === undefined
  )
    return null;
  return (
    <section className="assistant-transcript" aria-label="Hoox 正文">
      {blocks.length > 0 && <AgentTurn run={run} blocks={blocks} />}
      {progress.waitingQuestion !== undefined && (
        <AssistantMessage label="需要你的输入" text={progress.waitingQuestion} />
      )}
    </section>
  );
}

const toolActionText: Record<ToolAction, { running: string; completed: string; failed: string }> = {
  search: { running: "正在搜索", completed: "已搜索", failed: "搜索失败" },
  read: { running: "正在读取", completed: "已读取", failed: "读取失败" },
  create: { running: "正在创建", completed: "已创建", failed: "创建失败" },
  write: { running: "正在写入", completed: "已写入", failed: "写入失败" },
  edit: { running: "正在修改", completed: "已修改", failed: "修改失败" },
  deliver: { running: "正在交付", completed: "已交付", failed: "交付失败" },
  command: { running: "正在执行命令", completed: "已执行命令", failed: "命令执行失败" },
  other: { running: "正在执行", completed: "已完成", failed: "执行失败" },
};

function ToolActivity({ block }: { readonly block: Extract<ConversationBlock, { type: "tool" }> }) {
  return (
    <div className={`activity-item tool-activity is-${block.status}`}>
      {block.status === "running" ? (
        <LoaderCircle className="spin" size={14} aria-hidden="true" />
      ) : block.status === "failed" ? (
        <X size={14} aria-hidden="true" />
      ) : (
        <Check size={14} aria-hidden="true" />
      )}
      <span>{toolActionText[block.action][block.status]}</span>
      {block.title !== undefined && <strong>· {block.title}</strong>}
    </div>
  );
}

function ThinkingActivity({
  block,
  run,
}: {
  readonly block: Extract<ConversationBlock, { type: "thinking" }>;
  readonly run: Run;
}) {
  const label = thinkingActivityLabel(block, run);
  return (
    <details className="activity-item thinking-activity">
      <summary>
        <ChevronRight className="thinking-activity-chevron" size={14} aria-hidden="true" />
        <span>{label}</span>
      </summary>
      <div className="thinking-activity-content">
        <AssistantMarkdown text={block.text} />
      </div>
    </details>
  );
}

function thinkingActivityLabel(block: Extract<ConversationBlock, { type: "thinking" }>, run: Run) {
  if (block.status === "completed") return "思考完成";
  return run.executionStatus === "recovery_required" ? "思考已中断" : "思考已结束";
}

function ActivityGroup({
  run,
  items,
}: {
  readonly run: Run;
  readonly items: readonly (
    | Extract<ConversationBlock, { type: "thinking" }>
    | Extract<ConversationBlock, { type: "tool" }>
  )[];
}) {
  const runIsLive = run.status === "running" && run.executionStatus !== "recovery_required";
  const active = runIsLive
    ? [...items].reverse().find((item) => item.status === "running")
    : undefined;
  const completed = runIsLive ? items.filter((item) => item.status !== "running") : items;
  const lastCompleted = completed.at(-1);
  const completedSummary =
    lastCompleted?.type === "thinking"
      ? thinkingActivityLabel(lastCompleted, run)
      : lastCompleted?.type === "tool"
        ? `${toolActionText[lastCompleted.action][lastCompleted.status]}${lastCompleted.title === undefined ? "" : ` · ${lastCompleted.title}`}`
        : "执行过程";
  const summary =
    active?.type === "thinking"
      ? "正在思考"
      : active?.type === "tool"
        ? `${toolActionText[active.action].running}${active.title === undefined ? "" : ` · ${active.title}`}`
        : completedSummary;
  return (
    <details className={`activity-group ${active === undefined ? "is-completed" : "is-running"}`}>
      <summary>
        {active === undefined ? (
          <ChevronRight className="activity-group-chevron" size={14} aria-hidden="true" />
        ) : (
          <LoaderCircle className="spin" size={14} aria-hidden="true" />
        )}
        <strong>{summary}</strong>
      </summary>
      {completed.length > 0 && (
        <div className="activity-group-content">
          {completed.map((item) =>
            item.type === "thinking" ? (
              <ThinkingActivity key={item.id} block={item} run={run} />
            ) : (
              <ToolActivity key={item.id} block={item} />
            ),
          )}
        </div>
      )}
    </details>
  );
}

function AgentTurn({
  run,
  blocks,
}: {
  readonly run: Run;
  readonly blocks: readonly ConversationBlock[];
}) {
  const sections = buildConversationSections(blocks);
  return (
    <article className="message assistant-message agent-turn" aria-label="Hoox">
      <span className="message-avatar" aria-hidden="true">
        H
      </span>
      <div className="message-card">
        <span className="message-label">Hoox</span>
        <div className="agent-turn-blocks">
          {sections.map((section) =>
            section.type === "activity" ? (
              <ActivityGroup key={section.id} run={run} items={section.items} />
            ) : section.type === "answer" ? (
              <div className="agent-answer-block" key={section.id}>
                <AssistantMarkdown text={section.text} />
              </div>
            ) : (
              <ToolActivity key={section.id} block={section} />
            ),
          )}
        </div>
      </div>
    </article>
  );
}

function UserRequestMessage({
  text,
  pendingInput,
}: {
  readonly text: string;
  readonly pendingInput?: PendingThreadInputView;
}) {
  const contentRef = useRef<HTMLParagraphElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(() =>
    shouldInitiallyCollapseUserRequest(text),
  );
  const [expanded, setExpanded] = useState(false);

  // Thread 用户输入一经创建不可改写；宽度变化由观察器重新测量，避免每次展开状态变化都重建观察器。
  useEffect(() => {
    const content = contentRef.current;
    if (content === null) return;
    const updateOverflow = () => {
      setIsOverflowing(content.scrollHeight > userRequestCollapsedHeight + 1);
    };
    updateOverflow();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const collapsed = isOverflowing && !expanded;
  return (
    <article className={`message user-request${pendingInput === undefined ? "" : " is-pending"}`}>
      <div className="message-card">
        <p ref={contentRef} className={`user-request-content${collapsed ? " is-collapsed" : ""}`}>
          {text}
        </p>
        {isOverflowing && (
          <button
            type="button"
            className="user-request-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "收起" : "展开"}
            {expanded ? (
              <ChevronUp size={15} aria-hidden="true" />
            ) : (
              <ChevronDown size={15} aria-hidden="true" />
            )}
          </button>
        )}
        {pendingInput !== undefined && (
          <small className={`conversation-input-status is-${pendingInput.disposition}`}>
            {threadInputDispositionLabel(pendingInput)}
          </small>
        )}
      </div>
    </article>
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
  const currentBlocks = currentRun === undefined ? [] : buildConversationBlocks(currentRunEvents);
  const renderedAgentTurns = new Set<string>();
  return (
    <section className="assistant-transcript" aria-label="Thread 连续对话">
      {messages.map((message) =>
        message.role === "user" ? (
          <UserRequestMessage text={message.text} key={message.sequence} />
        ) : message.role === "assistant" ? (
          (() => {
            const turnKey = message.runId ?? `message-${message.sequence}`;
            if (renderedAgentTurns.has(turnKey)) return null;
            renderedAgentTurns.add(turnKey);
            if (currentRun !== undefined && message.runId === currentRun.id) {
              const blocks = currentBlocks.some((block) => block.type === "answer")
                ? currentBlocks
                : [
                    ...currentBlocks,
                    {
                      id: `persisted-${message.sequence}`,
                      type: "answer" as const,
                      text: message.text,
                      status: "completed" as const,
                    },
                  ];
              return <AgentTurn key={message.sequence} run={currentRun} blocks={blocks} />;
            }
            const text =
              message.runId === undefined
                ? message.text
                : messages
                    .filter(
                      (candidate) =>
                        candidate.role === "assistant" && candidate.runId === message.runId,
                    )
                    .map((candidate) => candidate.text)
                    .join("\n\n");
            return <AssistantMessage key={message.sequence} text={text} />;
          })()
        ) : shouldDisplayRuntimeContextMessage(message.text) ? (
          <p className="runtime-context-notice" key={message.sequence}>
            {message.text}
          </p>
        ) : null,
      )}
      {pendingInputs.map((input) => (
        <UserRequestMessage text={input.text} pendingInput={input} key={input.localId} />
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
  label = "Hoox",
  contentBefore,
}: {
  readonly text: string;
  readonly label?: string;
  readonly contentBefore?: ReactNode;
}) {
  return (
    <article className="message assistant-message" aria-label={label}>
      <span className="message-avatar" aria-hidden="true">
        H
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
        <p>描述希望 Hoox 完成的任务。执行过程和可交付产物会在这里持续更新。</p>
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
  selectedHistoryFiles = [],
  onHistoryFilesChange,
  historyFileApi,
}: {
  readonly input: string;
  readonly files: readonly File[];
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
  readonly onFilesChange: (files: readonly File[]) => void;
  readonly onSubmit: FormEventHandler<HTMLFormElement>;
  readonly showQueueAction: boolean;
  readonly onQueue: () => void;
  readonly selectedHistoryFiles?: readonly HistoryFile[];
  readonly onHistoryFilesChange?: (files: readonly HistoryFile[]) => void;
  readonly historyFileApi?: Pick<RuntimeApi, "listHistoryFiles">;
}) {
  const [mentionFiles, setMentionFiles] = useState<readonly HistoryFile[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const mention = activeHistoryMention(input);
  const mentionQuery = mention?.query;

  useEffect(() => {
    if (historyFileApi === undefined || mentionQuery === undefined) {
      setMentionFiles([]);
      setMentionLoading(false);
      setMentionActiveIndex(0);
      return;
    }
    let cancelled = false;
    setMentionLoading(true);
    const timer = window.setTimeout(() => {
      void historyFileApi
        .listHistoryFiles({ query: mentionQuery, limit: 8 })
        .then((page) => {
          if (cancelled) return;
          const seen = new Set<string>();
          const files = page.items
            .flatMap((task) => task.files)
            .filter((file) => {
              const key = composerHistoryFileKey(file);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .slice(0, 8);
          setMentionFiles(files);
          setMentionActiveIndex(0);
        })
        .catch(() => {
          if (!cancelled) {
            setMentionFiles([]);
            setMentionActiveIndex(0);
          }
        })
        .finally(() => {
          if (!cancelled) setMentionLoading(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [historyFileApi, mentionQuery]);

  const selectMention = (file: HistoryFile) => {
    if (mention === undefined || onHistoryFilesChange === undefined) return;
    const exists = selectedHistoryFiles.some(
      (selected) => composerHistoryFileKey(selected) === composerHistoryFileKey(file),
    );
    if (!exists && selectedHistoryFiles.length + files.length < 20)
      onHistoryFilesChange([...selectedHistoryFiles, file]);
    onChange(removeActiveHistoryMention(input, mention));
    setMentionFiles([]);
    setMentionActiveIndex(0);
  };

  const hasInput = input.trim().length > 0 || files.length > 0 || selectedHistoryFiles.length > 0;
  return (
    <form className="composer" onSubmit={onSubmit}>
      {(files.length > 0 || selectedHistoryFiles.length > 0) && (
        <ul className="composer-files" aria-label="待发送文件">
          {selectedHistoryFiles.map((file, index) => (
            <li className="composer-file is-history" key={composerHistoryFileKey(file)}>
              <span title={file.name}>{file.name}</span>
              <button
                type="button"
                aria-label={`移除历史文件 ${file.entryName}`}
                disabled={disabled}
                onClick={() =>
                  onHistoryFilesChange?.(
                    selectedHistoryFiles.filter((_candidate, ordinal) => ordinal !== index),
                  )
                }
              >
                <X size={13} />
              </button>
            </li>
          ))}
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
      {mention !== undefined &&
        historyFileApi !== undefined &&
        (mentionLoading || mentionFiles.length > 0) && (
          <div className="history-mention-menu" role="listbox" aria-label="选择历史文件">
            {mentionLoading && mentionFiles.length === 0 ? (
              <span>
                <LoaderCircle className="spin" size={15} /> 正在搜索云盘
              </span>
            ) : (
              mentionFiles.map((file, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === mentionActiveIndex}
                  className={index === mentionActiveIndex ? "is-active" : undefined}
                  key={composerHistoryFileKey(file)}
                  onMouseEnter={() => setMentionActiveIndex(index)}
                  onClick={() => selectMention(file)}
                >
                  <FileText size={16} />
                  <span>
                    <strong>{file.name}</strong>
                    <small>{file.taskName}</small>
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      <label className="sr-only" htmlFor="agent-request">
        发送给 Hoox 的任务
      </label>
      <textarea
        id="agent-request"
        value={input}
        onChange={(event) => onChange(event.target.value)}
        placeholder="描述任务，输入 @ 可选择云盘文件…"
        rows={2}
        disabled={disabled}
        style={{ resize: composerTextareaResize }}
        onKeyDown={(event) => {
          if (mention !== undefined && mentionFiles.length > 0) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const direction = event.key === "ArrowDown" ? 1 : -1;
              setMentionActiveIndex(
                (current) => (current + direction + mentionFiles.length) % mentionFiles.length,
              );
              return;
            }
            if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
              event.preventDefault();
              const selected = mentionFiles[mentionActiveIndex];
              if (selected !== undefined) selectMention(selected);
              return;
            }
          }
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
            disabled={disabled || !hasInput}
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
          disabled={disabled || !hasInput}
        >
          <Send size={16} />
          <span className="send-label">发送</span>
        </button>
      </div>
    </form>
  );
}

export function removeActiveHistoryMention(
  input: string,
  mention: { readonly start: number; readonly end: number },
): string {
  const before = input.slice(0, mention.start).trimEnd();
  const after = input.slice(mention.end).trimStart();
  return before.length > 0 && after.length > 0 ? `${before} ${after}` : before || after;
}

export function activeHistoryMention(
  input: string,
): { readonly start: number; readonly end: number; readonly query: string } | undefined {
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(input);
  if (match === null) return undefined;
  const query = match[1] ?? "";
  const atOffset = match[0].lastIndexOf("@");
  return { start: match.index + atOffset, end: input.length, query };
}

function composerHistoryFileKey(file: Pick<HistoryFile, "resourceId" | "versionId">): string {
  return `${file.resourceId}\0${file.versionId}`;
}

function composerFileKey(file: File): string {
  return `${file.name}\0${file.size}\0${file.type}\0${file.lastModified}`;
}

export function ThreadNavigation({
  children,
  ariaLabel = "会话列表",
}: {
  readonly children: ReactNode;
  readonly ariaLabel?: string;
}) {
  return (
    <nav className="thread-list" aria-label={ariaLabel}>
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
            H
          </span>
          <span className="brand-copy">
            <strong>Hoox</strong>
            <span className="brand-tagline">你说，它做。</span>
          </span>
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
  onFork,
  onPublishToTeam,
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
  readonly onFork?: () => void;
  readonly onPublishToTeam?: () => void;
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
        {onFork !== undefined && (
          <button type="button" className="quiet-button" onClick={onFork} disabled={actionLoading}>
            <GitBranch size={15} />
            <span>新建分支</span>
          </button>
        )}
        {onPublishToTeam !== undefined && (
          <button
            type="button"
            className="quiet-button"
            onClick={onPublishToTeam}
            disabled={actionLoading}
          >
            <Users size={15} />
            <span>发布到团队</span>
          </button>
        )}
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

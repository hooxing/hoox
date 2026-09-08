import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  Download,
  Eye,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
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
import { filePreviewKind, readFileReferences } from "@hoox/protocol/file-references";
import { MessageFileReferences } from "./file-reference-view.js";
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
  type RuntimeApi,
  type Thread,
  type ThreadContextAttachment,
  type ThreadContextMessage,
  type ThreadContinuityStatus,
} from "./api.js";
import { HOOX_HORIZONTAL_PATH } from "./brand.js";
import {
  buildConversationBlocks,
  createConversationProjector,
  buildConversationSections,
  buildRunProgress,
  type ConversationBlock,
  type ToolAction,
} from "./event-view.js";
import { AssistantMarkdown } from "./markdown-view.js";

/** 追加时只折叠新事件；补页、Attempt 切换或已有事件替换时才重建投影。 */
function useConversationBlocks(events: readonly RunEvent[]) {
  const cache = useRef({
    events: [] as readonly RunEvent[],
    projector: createConversationProjector(),
    blocks: [] as readonly ConversationBlock[],
  });
  const current = cache.current;
  if (current.events !== events) {
    if (
      events.length < current.events.length ||
      !current.events.every((event, index) => events[index] === event)
    ) {
      current.events = [];
      current.projector = createConversationProjector();
    }
    current.blocks = current.projector.append(events.slice(current.events.length));
    current.events = events;
  }
  return current.blocks;
}

function CurrentAgentTurn({
  run,
  events,
  messages = [],
}: {
  readonly run: Run;
  readonly events: readonly RunEvent[];
  readonly messages?: readonly ThreadContextMessage[];
}) {
  const projected = useConversationBlocks(events);
  const fallback = terminalFallbackAnswer(run, events, projected);
  const persistedText = messages.map((message) => message.text).join("\n\n");
  const blocks =
    projected.some((block) => block.type === "answer") || persistedText.length === 0
      ? fallback === undefined
        ? projected
        : [...projected, fallback]
      : [
          ...projected,
          {
            id: `persisted-${run.id}`,
            type: "answer" as const,
            text: persistedText,
            status: "completed" as const,
          },
        ];
  const question = buildRunProgress(events).waitingQuestion;
  return (
    <>
      {blocks.length > 0 && <AgentTurn run={run} blocks={blocks} />}
      {question !== undefined && <AssistantMessage label="需要你的输入" text={question} />}
    </>
  );
}

/** waiting 仍可取消，但不代表 Worker 正在执行。 */
export const cancellableRunStatuses = new Set<RunStatus>(["queued", "running", "waiting"]);
/** 仅尚会自行变化的 Run 继续短轮询；waiting 由用户下一次提交恢复。 */
export const pollingRunStatuses = new Set<RunStatus>(["queued", "running"]);
export const timedRunStatuses = new Set<RunStatus>(["running"]);
export const compactWorkspaceMedia = "(max-width: 820px)";
export const composerTextareaResize = "none";
export const userRequestCollapsedHeight = 264;
export const userRequestCollapseCharacterThreshold = 600;
const composerFileLimit = 20;

type ComposerFileKind = "archive" | "audio" | "code" | "document" | "image" | "sheet" | "video";

function composerFileKind(name: string, mediaType: string): ComposerFileKind {
  const normalizedName = name.toLowerCase();
  const normalizedMediaType = mediaType.toLowerCase();
  if (normalizedMediaType.startsWith("image/")) return "image";
  if (normalizedMediaType.startsWith("audio/")) return "audio";
  if (normalizedMediaType.startsWith("video/")) return "video";
  if (
    normalizedMediaType.includes("spreadsheet") ||
    normalizedMediaType.includes("excel") ||
    /\.(?:csv|ods|xls|xlsx)$/u.test(normalizedName)
  )
    return "sheet";
  if (
    normalizedMediaType.includes("zip") ||
    normalizedMediaType.includes("compressed") ||
    /\.(?:7z|bz2|gz|rar|tar|tgz|zip)$/u.test(normalizedName)
  )
    return "archive";
  if (
    normalizedMediaType.includes("json") ||
    normalizedMediaType.includes("javascript") ||
    normalizedMediaType.includes("typescript") ||
    normalizedMediaType.includes("xml") ||
    /\.(?:c|cc|cpp|css|go|h|html|java|js|jsx|json|md|php|py|rb|rs|sh|sql|ts|tsx|vue|xml|yaml|yml)$/u.test(
      normalizedName,
    )
  )
    return "code";
  return "document";
}

function ComposerFileIcon({
  kind,
  size = 20,
}: {
  readonly kind: ComposerFileKind;
  readonly size?: number;
}) {
  const properties = { size, "aria-hidden": true as const };
  if (kind === "image") return <FileImage {...properties} />;
  if (kind === "audio") return <FileAudio {...properties} />;
  if (kind === "video") return <FileVideo {...properties} />;
  if (kind === "sheet") return <FileSpreadsheet {...properties} />;
  if (kind === "archive") return <FileArchive {...properties} />;
  if (kind === "code") return <FileCode2 {...properties} />;
  return <FileText {...properties} />;
}

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

function RunStatusIcon({ status }: { readonly status: RunStatus | "ready" | "interrupted" }) {
  const properties = { size: 12, "aria-hidden": true as const };
  if (status === "running") return <LoaderCircle className="spin" {...properties} />;
  if (status === "succeeded") return <Check {...properties} />;
  if (status === "failed" || status === "cancelled" || status === "interrupted") {
    return <X {...properties} />;
  }
  if (status === "waiting") return <Square {...properties} />;
  return <Circle {...properties} />;
}

export function RunStatusBadge({
  status,
  executionStatus,
}: {
  readonly status: RunStatus | undefined;
  readonly executionStatus?: Run["executionStatus"];
}) {
  if (status === undefined) {
    return (
      <span className="run-status is-ready">
        <RunStatusIcon status="ready" />
        就绪
      </span>
    );
  }
  if (executionStatus === "recovery_required") {
    return (
      <span className="run-status is-recovery-required">
        <RunStatusIcon status="interrupted" />
        执行已中断
      </span>
    );
  }
  return (
    <span className={`run-status is-${status}`}>
      <RunStatusIcon status={status} />
      {statusLabel[status]}
    </span>
  );
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
  const projectedBlocks = useConversationBlocks(events);
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
        <AssistantMarkdown
          text={block.text}
          streaming={block.status === "running" && run.status === "running"}
        />
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
  const onlyItem = active === undefined && items.length === 1 ? items[0] : undefined;
  if (onlyItem?.type === "thinking") {
    return <ThinkingActivity block={onlyItem} run={run} />;
  }
  if (onlyItem?.type === "tool") {
    return <ToolActivity block={onlyItem} />;
  }
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
  onProcessExpand,
  processLoading = false,
  processLoadFailed = false,
}: {
  readonly run: Run;
  readonly blocks: readonly ConversationBlock[];
  readonly onProcessExpand?: () => void;
  readonly processLoading?: boolean;
  readonly processLoadFailed?: boolean;
}) {
  const markerIndex = blocks.findLastIndex((block) => block.type === "finalization");
  const marker = markerIndex < 0 ? undefined : blocks[markerIndex];
  const runIsLive = run.status === "running" && run.executionStatus !== "recovery_required";
  const finalizationActive =
    marker?.type === "finalization" &&
    (marker.status === "committed" || (marker.status === "started" && runIsLive));
  const processBlocks = finalizationActive
    ? blocks.slice(0, markerIndex).filter((block) => block.type !== "finalization")
    : [];
  const answerBlocks = finalizationActive
    ? blocks.slice(markerIndex + 1).filter((block) => block.type !== "finalization")
    : blocks.filter((block) => block.type !== "finalization");
  const renderBlocks = (items: readonly ConversationBlock[]) =>
    buildConversationSections(items).map((section) =>
      section.type === "activity" ? (
        <ActivityGroup key={section.id} run={run} items={section.items} />
      ) : section.type === "answer" ? (
        <div className="agent-answer-block" key={section.id}>
          <AssistantMarkdown
            text={section.text}
            streaming={section.status === "streaming" && runIsLive}
          />
        </div>
      ) : (
        <ToolActivity key={section.id} block={section} />
      ),
    );
  return (
    <article className="message assistant-message agent-turn" aria-label="Hoox">
      <span className="message-avatar" aria-hidden="true">
        H
      </span>
      <div className="message-card">
        <span className="message-label">Hoox</span>
        <div className="agent-turn-blocks">
          {finalizationActive && processBlocks.length > 0 && (
            <details
              className="final-answer-process"
              onToggle={(event) => {
                if (event.currentTarget.open) onProcessExpand?.();
              }}
            >
              <summary>
                <ChevronRight
                  className="final-answer-process-chevron"
                  size={14}
                  aria-hidden="true"
                />
                <strong>{processLoading ? "正在加载执行过程" : "查看执行过程"}</strong>
              </summary>
              <div className="final-answer-process-content">
                {renderBlocks(processBlocks)}
                {processLoadFailed && (
                  <small className="final-answer-process-error">
                    过程详情加载失败，当前显示持久化摘要。
                  </small>
                )}
              </div>
            </details>
          )}
          {renderBlocks(answerBlocks)}
          {finalizationActive && answerBlocks.length === 0 && marker.status === "started" && (
            <div className="final-answer-placeholder">
              <LoaderCircle className="spin" size={14} aria-hidden="true" />
              <span>正在整理最终答复…</span>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

type AssistantThreadContextMessage = ThreadContextMessage & { readonly role: "assistant" };

type AssistantTranscriptSegment = {
  readonly kind: "assistant";
  readonly runId: string;
  readonly messages: AssistantThreadContextMessage[];
  readonly after?: string;
  before?: string;
};

type ThreadTranscriptItem =
  | AssistantTranscriptSegment
  | { readonly kind: "message"; readonly message: ThreadContextMessage };

function buildThreadTranscriptItems(
  messages: readonly ThreadContextMessage[],
): readonly ThreadTranscriptItem[] {
  const items: ThreadTranscriptItem[] = [];
  let lastUserAt: string | undefined;
  let latestAssistantSegment: AssistantTranscriptSegment | undefined;
  for (const message of messages) {
    if (message.role === "assistant" && message.runId !== undefined) {
      const tail = items.at(-1);
      if (tail?.kind === "assistant" && tail.runId === message.runId) {
        tail.messages.push(message as AssistantThreadContextMessage);
        latestAssistantSegment = tail;
        continue;
      }
      const segment: AssistantTranscriptSegment = {
        kind: "assistant",
        runId: message.runId,
        messages: [message as AssistantThreadContextMessage],
        ...(lastUserAt === undefined ? {} : { after: lastUserAt }),
      };
      items.push(segment);
      latestAssistantSegment = segment;
      continue;
    }
    items.push({ kind: "message", message });
    if (message.role === "user") {
      if (latestAssistantSegment !== undefined) latestAssistantSegment.before = message.createdAt;
      lastUserAt = message.createdAt;
      latestAssistantSegment = undefined;
    }
  }
  return items;
}

function segmentedRunIds(
  items: readonly ThreadTranscriptItem[],
  messages: readonly ThreadContextMessage[],
): ReadonlySet<string> {
  const counts = new Map<string, number>();
  const segmented = new Set<string>();
  for (const item of items) {
    if (item.kind !== "assistant") continue;
    const count = (counts.get(item.runId) ?? 0) + 1;
    counts.set(item.runId, count);
    if (count > 1) segmented.add(item.runId);
  }
  const seenAssistantRuns = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.runId !== undefined) {
      seenAssistantRuns.add(message.runId);
    } else if (
      message.role === "user" &&
      message.runId !== undefined &&
      seenAssistantRuns.has(message.runId)
    ) {
      segmented.add(message.runId);
    }
  }
  return segmented;
}

function eventsInTranscriptInterval(
  events: readonly RunEvent[],
  after: string | undefined,
  before: string | undefined,
): readonly RunEvent[] {
  // Thread Context 用户消息在 turn 安全点后持久化；时间边界禁止后续 steer 回复越过该消息。
  if (after === undefined && before === undefined) return events;
  const afterTime = after === undefined ? undefined : Date.parse(after);
  const beforeTime = before === undefined ? undefined : Date.parse(before);
  return events.filter((event) => {
    const occurredAt = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurredAt)) return false;
    if (afterTime !== undefined && Number.isFinite(afterTime) && occurredAt <= afterTime)
      return false;
    if (beforeTime !== undefined && Number.isFinite(beforeTime) && occurredAt >= beforeTime)
      return false;
    return true;
  });
}

function HistoricalAgentTurn({
  runId,
  messages,
  loadRunEvents,
}: {
  readonly runId: string;
  readonly messages: readonly AssistantThreadContextMessage[];
  readonly loadRunEvents?: (runId: string) => Promise<readonly RunEvent[]>;
  readonly loadAttachmentUrl?: (attachment: ThreadContextAttachment) => Promise<string>;
}) {
  const [loadedEvents, setLoadedEvents] = useState<readonly RunEvent[] | undefined>();
  const [loadState, setLoadState] = useState<"idle" | "loading" | "failed">("idle");
  const finalMessages = messages.filter((message) => message.phase === "final_answer");
  if (finalMessages.length === 0) {
    return <AssistantMessage text={messages.map((message) => message.text).join("\n\n")} />;
  }
  const fallbackBlocks: ConversationBlock[] = [
    ...messages
      .filter((message) => message.phase !== "final_answer")
      .map((message) => ({
        id: `persisted-process-${message.sequence}`,
        type: "answer" as const,
        text: message.text,
        status: "completed" as const,
      })),
    {
      id: `persisted-finalization-${runId}`,
      type: "finalization" as const,
      callId: `persisted-${runId}`,
      status: "committed" as const,
    },
    ...finalMessages.map((message) => ({
      id: `persisted-final-${message.sequence}`,
      type: "answer" as const,
      text: message.text,
      status: "completed" as const,
    })),
  ];
  const projected = loadedEvents === undefined ? undefined : buildConversationBlocks(loadedEvents);
  const blocks =
    projected?.some((block) => block.type === "finalization" && block.status === "committed") ===
    true
      ? projected
      : fallbackBlocks;
  const loadProcess = () => {
    if (loadRunEvents === undefined || loadedEvents !== undefined || loadState !== "idle") return;
    setLoadState("loading");
    void loadRunEvents(runId).then(
      (events) => {
        setLoadedEvents(events);
        setLoadState("idle");
      },
      () => setLoadState("failed"),
    );
  };
  const run: Run = {
    id: runId,
    threadId: "historical",
    status: "succeeded",
    createdAt: messages[0]?.createdAt ?? "",
    updatedAt: messages.at(-1)?.createdAt ?? "",
  };
  return (
    <AgentTurn
      run={run}
      blocks={blocks}
      onProcessExpand={loadProcess}
      processLoading={loadState === "loading"}
      processLoadFailed={loadState === "failed"}
    />
  );
}

function canPreviewUserAttachment(attachment: ThreadContextAttachment): boolean {
  return new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]).has(attachment.mediaType);
}

function UserRequestAttachment({
  attachment,
  loadAttachmentUrl,
}: {
  readonly attachment: ThreadContextAttachment;
  readonly loadAttachmentUrl?: (attachment: ThreadContextAttachment) => Promise<string>;
}) {
  const previewable = canPreviewUserAttachment(attachment);
  const attachmentIdentity = `${attachment.resourceId}:${attachment.versionId}`;
  const attachmentRef = useRef(attachment);
  attachmentRef.current = attachment;
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!previewable || loadAttachmentUrl === undefined) return;
    let active = true;
    setUrl(undefined);
    setFailed(false);
    // Run 轮询会重建消息投影对象；预览只随不可变的 ResourceVersion 身份变化，避免重复清空图片。
    void loadAttachmentUrl(attachmentRef.current).then(
      (resolved) => {
        const currentIdentity = `${attachmentRef.current.resourceId}:${attachmentRef.current.versionId}`;
        if (active && currentIdentity === attachmentIdentity) setUrl(resolved);
      },
      () => {
        const currentIdentity = `${attachmentRef.current.resourceId}:${attachmentRef.current.versionId}`;
        if (active && currentIdentity === attachmentIdentity) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [attachmentIdentity, loadAttachmentUrl, previewable]);

  return (
    <li className={`user-request-attachment${previewable ? " is-image" : ""}`}>
      {url === undefined ? (
        <div
          className="user-request-attachment-placeholder"
          role="img"
          aria-label={attachment.name}
        >
          {previewable && !failed ? (
            <LoaderCircle className="spin" size={18} aria-hidden="true" />
          ) : (
            <FileText size={18} aria-hidden="true" />
          )}
        </div>
      ) : (
        <a href={url} target="_blank" rel="noreferrer" aria-label={`查看附件 ${attachment.name}`}>
          <img src={url} alt={attachment.name} />
        </a>
      )}
      <span className="user-request-attachment-meta">
        <strong title={attachment.name}>{attachment.name}</strong>
        <small>{formatArtifactSize(attachment.sizeBytes)}</small>
      </span>
    </li>
  );
}

function UserRequestMessage({
  text,
  attachments = [],
  loadAttachmentUrl,
  pendingInput,
}: {
  readonly text: string;
  readonly attachments?: readonly ThreadContextAttachment[];
  readonly loadAttachmentUrl?: (attachment: ThreadContextAttachment) => Promise<string>;
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
          {readFileReferences(text).text}
        </p>
        <MessageFileReferences text={text} />
        {attachments.length > 0 && (
          <ul className="user-request-attachments" aria-label="消息附件">
            {attachments.map((attachment) => (
              <UserRequestAttachment
                attachment={attachment}
                {...(loadAttachmentUrl === undefined ? {} : { loadAttachmentUrl })}
                key={`${attachment.resourceId}:${attachment.versionId}`}
              />
            ))}
          </ul>
        )}
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
  loadRunEvents,
  loadAttachmentUrl,
}: {
  readonly messages: readonly ThreadContextMessage[];
  readonly pendingInputs?: readonly PendingThreadInputView[];
  readonly currentRun?: Run;
  readonly currentRunEvents?: readonly RunEvent[];
  readonly loadRunEvents?: (runId: string) => Promise<readonly RunEvent[]>;
  readonly loadAttachmentUrl?: (attachment: ThreadContextAttachment) => Promise<string>;
}) {
  if (messages.length === 0 && pendingInputs.length === 0 && currentRun === undefined) return null;
  const transcriptItems = buildThreadTranscriptItems(messages);
  const segmentedRuns = segmentedRunIds(transcriptItems, messages);
  const currentRunTail =
    currentRun === undefined
      ? undefined
      : [...messages]
          .reverse()
          .find(
            (message) =>
              message.runId === currentRun.id &&
              (message.role === "user" || message.role === "assistant"),
          );
  const hasCurrentRunTail =
    currentRun !== undefined && currentRunTail?.role === "user" && segmentedRuns.has(currentRun.id);
  const tailEvents = hasCurrentRunTail
    ? eventsInTranscriptInterval(currentRunEvents, currentRunTail.createdAt, undefined)
    : [];
  const content = transcriptItems.map((item) =>
    item.kind === "message" && item.message.role === "user" ? (
      <UserRequestMessage
        text={item.message.text}
        {...(item.message.attachments === undefined
          ? {}
          : { attachments: item.message.attachments })}
        {...(loadAttachmentUrl === undefined ? {} : { loadAttachmentUrl })}
        key={item.message.sequence}
      />
    ) : item.kind === "assistant" ? (
      (() => {
        const firstMessage = item.messages[0];
        if (firstMessage === undefined) return null;
        const segmented = segmentedRuns.has(item.runId);
        if (currentRun !== undefined && item.runId === currentRun.id) {
          const segmentEvents = segmented
            ? eventsInTranscriptInterval(currentRunEvents, item.after, item.before)
            : currentRunEvents;
          return (
            <CurrentAgentTurn
              key={
                segmented
                  ? `current-${currentRun.id}:${firstMessage.sequence}`
                  : `current-${currentRun.id}`
              }
              run={currentRun}
              events={segmentEvents}
              messages={item.messages}
            />
          );
        }
        const loadSegmentEvents =
          loadRunEvents === undefined
            ? undefined
            : segmented
              ? async (runId: string) =>
                  eventsInTranscriptInterval(await loadRunEvents(runId), item.after, item.before)
              : loadRunEvents;
        return (
          <HistoricalAgentTurn
            key={firstMessage.sequence}
            runId={item.runId}
            messages={item.messages}
            {...(loadSegmentEvents === undefined ? {} : { loadRunEvents: loadSegmentEvents })}
          />
        );
      })()
    ) : item.kind === "message" && item.message.role === "assistant" ? (
      <AssistantMessage key={item.message.sequence} text={item.message.text} />
    ) : item.kind === "message" && shouldDisplayRuntimeContextMessage(item.message.text) ? (
      <p className="runtime-context-notice" key={item.message.sequence}>
        {item.message.text}
      </p>
    ) : null,
  );
  for (const input of pendingInputs) {
    content.push(
      <UserRequestMessage
        text={input.text}
        {...(input.attachments === undefined ? {} : { attachments: input.attachments })}
        {...(loadAttachmentUrl === undefined ? {} : { loadAttachmentUrl })}
        pendingInput={input}
        key={input.localId}
      />,
    );
  }
  if (currentRun !== undefined && hasCurrentRunTail) {
    content.push(
      <CurrentAgentTurn
        key={`current-run-tail-${currentRun.id}-${currentRunTail?.sequence ?? "unknown"}`}
        run={currentRun}
        events={tailEvents}
      />,
    );
  } else if (
    currentRun !== undefined &&
    !messages.some((message) => message.role === "assistant" && message.runId === currentRun.id)
  ) {
    content.push(
      <CurrentAgentTurn
        key={`current-${currentRun.id}`}
        run={currentRun}
        events={currentRunEvents}
      />,
    );
  }
  return (
    <section className="assistant-transcript" aria-label="Thread 连续对话">
      {content}
    </section>
  );
}

export function shouldDisplayRuntimeContextMessage(text: string): boolean {
  const normalized = text.trim();
  return normalized !== "运行已完成。" && normalized !== "本次运行未产生 Workspace revision。";
}

export type PendingThreadInputView = {
  readonly localId: string;
  readonly text: string;
  readonly attachments?: readonly ThreadContextAttachment[];
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
              {(filePreviewKind(artifact.name, artifact.mediaType) !== undefined ||
                canPreviewArtifact(artifact.mediaType)) && (
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
      <img className="welcome-logo compact" src={HOOX_HORIZONTAL_PATH} alt="" aria-hidden="true" />
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

type ComposerHistoryFileApi = Pick<RuntimeApi, "listHistoryFiles"> &
  Partial<Pick<RuntimeApi, "previewHistoryFile">>;

function appendComposerFiles(
  currentFiles: readonly File[],
  addedFiles: readonly File[],
  reservedSlots: number,
): readonly File[] {
  const availableSlots = Math.max(0, composerFileLimit - reservedSlots);
  return [...currentFiles, ...addedFiles]
    .filter(
      (file, index, combined) =>
        combined.findIndex((candidate) => composerFileKey(candidate) === composerFileKey(file)) ===
        index,
    )
    .slice(0, availableSlots);
}

function clipboardFileList(clipboardData: DataTransfer): readonly File[] {
  const directFiles = Array.from(clipboardData.files);
  if (directFiles.length > 0) return directFiles;
  return Array.from(clipboardData.items ?? []).flatMap((item) => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile();
    return file === null ? [] : [file];
  });
}

function ComposerFileVisual({
  name,
  mediaType,
  previewUrl,
}: {
  readonly name: string;
  readonly mediaType: string;
  readonly previewUrl?: string | undefined;
}) {
  const kind = composerFileKind(name, mediaType);
  return (
    <span className={`composer-file-visual is-${kind}`} data-file-kind={kind}>
      {previewUrl === undefined ? (
        <ComposerFileIcon kind={kind} />
      ) : (
        <img className="composer-file-preview" src={previewUrl} alt="" />
      )}
    </span>
  );
}

function ComposerLocalFileVisual({ file }: { readonly file: File }) {
  const [previewUrl, setPreviewUrl] = useState<string>();
  useEffect(() => {
    if (composerFileKind(file.name, file.type) !== "image") {
      setPreviewUrl(undefined);
      return;
    }
    if (typeof URL.createObjectURL !== "function") return;
    const nextPreviewUrl = URL.createObjectURL(file);
    setPreviewUrl(nextPreviewUrl);
    return () => {
      if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(nextPreviewUrl);
    };
  }, [file]);
  return <ComposerFileVisual name={file.name} mediaType={file.type} previewUrl={previewUrl} />;
}

function ComposerHistoryFileVisual({
  file,
  loadPreview,
}: {
  readonly file: HistoryFile;
  readonly loadPreview?: RuntimeApi["previewHistoryFile"] | undefined;
}) {
  const [previewUrl, setPreviewUrl] = useState<string>();
  useEffect(() => {
    setPreviewUrl(undefined);
    if (composerFileKind(file.name, file.mediaType) !== "image" || loadPreview === undefined)
      return;
    let cancelled = false;
    void loadPreview(file)
      .then((url) => {
        if (!cancelled) setPreviewUrl(url);
      })
      .catch(() => {
        if (!cancelled) setPreviewUrl(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [file, loadPreview]);
  return <ComposerFileVisual name={file.name} mediaType={file.mediaType} previewUrl={previewUrl} />;
}

export function ConversationComposer({
  references,
  referenceCount = 0,
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
  readonly referenceCount?: number;
  readonly references?: ReactNode;
  readonly onQueue: () => void;
  readonly selectedHistoryFiles?: readonly HistoryFile[];
  readonly onHistoryFilesChange?: (files: readonly HistoryFile[]) => void;
  readonly historyFileApi?: ComposerHistoryFileApi;
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

  const hasInput =
    input.trim().length > 0 ||
    files.length > 0 ||
    selectedHistoryFiles.length > 0 ||
    referenceCount > 0;
  return (
    <form
      className="composer"
      onSubmit={onSubmit}
      onPaste={(event) => {
        const pastedFiles = clipboardFileList(event.clipboardData);
        if (pastedFiles.length === 0) return;
        event.preventDefault();
        onFilesChange(appendComposerFiles(files, pastedFiles, selectedHistoryFiles.length));
      }}
    >
      {references}
      {(files.length > 0 || selectedHistoryFiles.length > 0) && (
        <ul className="composer-files" aria-label="待发送文件">
          {selectedHistoryFiles.map((file, index) => (
            <li
              className={`composer-file is-history ${
                composerFileKind(file.name, file.mediaType) === "image" ? "is-image" : ""
              }`}
              key={composerHistoryFileKey(file)}
            >
              <ComposerHistoryFileVisual
                file={file}
                loadPreview={historyFileApi?.previewHistoryFile}
              />
              <span className="composer-file-name" title={file.name}>
                {file.name}
              </span>
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
            <li
              className={`composer-file ${
                composerFileKind(file.name, file.type) === "image" ? "is-image" : ""
              }`}
              key={composerFileKey(file)}
            >
              <ComposerLocalFileVisual file={file} />
              <span className="composer-file-name" title={file.name}>
                {file.name}
              </span>
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
        placeholder="描述任务，可粘贴图片或文件，输入 @ 选择云盘文件…"
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
        <label className="attachment-button" title="上传文件，也可直接粘贴">
          <Paperclip size={16} aria-hidden="true" />
          <span>上传或粘贴</span>
          <input
            type="file"
            multiple
            disabled={disabled}
            onChange={(event) => {
              const selected = Array.from(event.target.files ?? []);
              onFilesChange(appendComposerFiles(files, selected, selectedHistoryFiles.length));
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
          <img className="brand-logo" src={HOOX_HORIZONTAL_PATH} alt="Hoox" />
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
  readonly actionLoading: boolean;
  readonly onArchive: () => void;
  readonly onCancel: () => void;
  readonly onFork?: () => void;
  readonly onPublishToTeam?: () => void;
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

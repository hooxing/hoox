import { LoaderCircle, PanelLeftOpen, RotateCw } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, RuntimeApi, type ArtifactPreview, type Thread } from "./api.js";
import { recoverLatestRunForNavigation, WorkspaceNavigation } from "./navigation.js";
import { CurrentRunPoll, drainEventPages } from "./polling.js";
import { openResolvedUrl, PopupBlockedError } from "./popup.js";
import { initialWorkspaceState, workspaceReducer } from "./state.js";
import "./styles.css";
import {
  ActivityPanel,
  activeRunStatuses,
  ConversationComposer,
  compactWorkspaceMedia,
  EmptyConversation,
  NavigationSidebar,
  RunRecoveryLoading,
  RunTimeline,
  shouldOpenActivityPanel,
  ThreadCreate,
  ThreadHeader,
  ThreadNavigation,
} from "./workspace-view.js";

const api = new RuntimeApi();

/** 首条请求在浏览器侧生成稳定标题，既满足现有必填协议，也不把取名工作交给用户。 */
export function deriveThreadTitle(query: string): string {
  const cleaned = query
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/[`*_#>[\]()]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned.length === 0) return "新任务";
  const limit = 26;
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}
type WorkspaceApi = Pick<
  RuntimeApi,
  | "archiveThread"
  | "cancelRun"
  | "createRun"
  | "createThread"
  | "downloadArtifact"
  | "getRun"
  | "listArtifacts"
  | "listEvents"
  | "listLatestRuns"
  | "listThreads"
  | "previewArtifact"
>;

type RecoveryUiState = {
  readonly threadId: string;
  readonly selectionGeneration: number;
  readonly requestVersion: number;
  readonly status: "loading" | "error";
  readonly error?: ApiError;
};

/** Thread 列表由服务端稳定排序；刷新时选择其中第一个活跃会话。 */
export function chooseInitialThread(threads: readonly Thread[]): string | undefined {
  return threads.find((thread) => thread.status === "active")?.id;
}

export function App({ apiClient = api }: { readonly apiClient?: WorkspaceApi }) {
  const initialCompact = window.matchMedia(compactWorkspaceMedia).matches;
  const [state, dispatch] = useReducer(workspaceReducer, initialWorkspaceState);
  const [input, setInput] = useState("");
  const [currentRequest, setCurrentRequest] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<ApiError | undefined>();
  const [textPreview, setTextPreview] = useState<ArtifactPreview | undefined>();
  const [recoveryUi, setRecoveryUi] = useState<RecoveryUiState | undefined>();
  const [recoveryNonce, setRecoveryNonce] = useState(0);
  const [isCompact, setIsCompact] = useState(initialCompact);
  const [activityOpen, setActivityOpen] = useState(() => shouldOpenActivityPanel(initialCompact));
  const [navigationOpen, setNavigationOpen] = useState(false);
  const eventAfterRef = useRef(-1);
  const eventAttemptRef = useRef<string | undefined>(undefined);
  const currentRunPollRef = useRef(new CurrentRunPoll());
  const navigationRef = useRef(new WorkspaceNavigation());
  const mobileNavigationToggleRef = useRef<HTMLButtonElement>(null);
  const sendInFlightRef = useRef(false);
  const initialSelectionAppliedRef = useRef(false);

  const selectThread = useCallback((threadId: string | undefined) => {
    navigationRef.current.navigate(threadId);
    currentRunPollRef.current.invalidate();
    dispatch({ type: "select", threadId });
    setCurrentRequest(undefined);
    setError(undefined);
    setNavigationOpen(false);
  }, []);

  useEffect(() => {
    const media = window.matchMedia(compactWorkspaceMedia);
    const updateLayout = (event: MediaQueryListEvent) => {
      setIsCompact(event.matches);
      if (event.matches) {
        setActivityOpen(false);
        setNavigationOpen(false);
      }
    };
    media.addEventListener("change", updateLayout);
    return () => media.removeEventListener("change", updateLayout);
  }, []);

  useEffect(() => {
    eventAfterRef.current = state.events.at(-1)?.sequence ?? -1;
    eventAttemptRef.current = state.eventAttemptId;
  }, [state.eventAttemptId, state.events]);

  const refreshThreads = useCallback(async () => {
    const expectedNavigation = navigationRef.current.capture();
    setLoading(true);
    try {
      const threads = await apiClient.listThreads();
      dispatch({ type: "threads", threads });
      if (!initialSelectionAppliedRef.current) {
        initialSelectionAppliedRef.current = true;
        const initialThreadId = chooseInitialThread(threads);
        if (
          initialThreadId !== undefined &&
          expectedNavigation.selectedThreadId === undefined &&
          navigationRef.current.isCurrent(expectedNavigation)
        ) {
          selectThread(initialThreadId);
        }
      }
      if (navigationRef.current.isCurrent(expectedNavigation)) setError(undefined);
    } catch (reason) {
      if (navigationRef.current.isCurrent(expectedNavigation)) {
        setError(reason instanceof ApiError ? reason : new ApiError("加载线程失败", 0, true));
      }
    } finally {
      setLoading(false);
    }
  }, [apiClient, selectThread]);

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  useEffect(() => {
    const threadId = state.selectedThreadId;
    if (threadId === undefined) {
      setRecoveryUi(undefined);
      return;
    }
    const expectedNavigation = navigationRef.current.capture();
    const selectionGeneration = state.selectionGeneration;
    let stopped = false;
    setRecoveryUi({
      threadId,
      selectionGeneration,
      requestVersion: recoveryNonce,
      status: "loading",
    });

    void recoverLatestRunForNavigation(navigationRef.current, expectedNavigation, () =>
      apiClient.listLatestRuns(threadId, 1),
    )
      .then((runs) => {
        if (stopped || runs === undefined) return;
        dispatch({
          type: "recoverLatestRun",
          threadId,
          selectionGeneration,
          run: runs[0],
        });
        setRecoveryUi((current) =>
          current?.threadId === threadId && current.selectionGeneration === selectionGeneration
            ? undefined
            : current,
        );
      })
      .catch((reason: unknown) => {
        if (stopped || !navigationRef.current.isCurrent(expectedNavigation)) return;
        setRecoveryUi({
          threadId,
          selectionGeneration,
          requestVersion: recoveryNonce,
          status: "error",
          error: reason instanceof ApiError ? reason : new ApiError("恢复最新运行失败", 0, true),
        });
      });

    return () => {
      stopped = true;
    };
  }, [apiClient, recoveryNonce, state.selectedThreadId, state.selectionGeneration]);

  useEffect(() => {
    const threadId = state.selectedThreadId;
    const runId = state.run?.id;
    if (runId === undefined || threadId === undefined) return;
    const pollGeneration = currentRunPollRef.current.activate(threadId, runId);
    let stopped = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      if (!currentRunPollRef.current.isCurrent(pollGeneration)) return;
      try {
        const latest = await apiClient.getRun(threadId, runId);
        const [eventPage, artifacts] = await Promise.all([
          drainEventPages(
            (after, limit) => apiClient.listEvents(threadId, runId, after, limit),
            eventAfterRef.current,
            eventAttemptRef.current,
          ),
          apiClient.listArtifacts(threadId, runId),
        ]);
        if (!stopped && currentRunPollRef.current.isCurrent(pollGeneration)) {
          eventAttemptRef.current = eventPage.attemptId;
          eventAfterRef.current = eventPage.nextAfter;
          dispatch({ type: "run", run: latest });
          dispatch({ type: "events", page: eventPage });
          dispatch({ type: "artifacts", artifacts });
          // 单次完成后再调度，状态更新不会重新创建计时器或导致紧密轮询。
          if (eventPage.hasMore || activeRunStatuses.has(latest.status)) {
            timer = window.setTimeout(() => void poll(), 1200);
          }
        }
      } catch (reason) {
        if (!stopped && currentRunPollRef.current.isCurrent(pollGeneration)) {
          setError(reason instanceof ApiError ? reason : new ApiError("轮询运行状态失败", 0, true));
          timer = window.setTimeout(() => void poll(), 1200);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      currentRunPollRef.current.invalidate(pollGeneration);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [apiClient, state.run?.id, state.selectedThreadId]);

  useEffect(() => {
    if (state.artifacts.length > 0) setActivityOpen(true);
  }, [state.artifacts.length]);

  const createConversation = () => selectThread(undefined);
  const send = async () => {
    if (!input.trim() || actionLoading || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    const expectedNavigation = navigationRef.current.capture();
    setActionLoading(true);
    try {
      const request = input.trim();
      let threadId = state.selectedThreadId;
      if (threadId === undefined) {
        const thread = await apiClient.createThread(deriveThreadTitle(request));
        dispatch({ type: "threadCreated", thread });
        if (!navigationRef.current.isCurrent(expectedNavigation)) return;
        navigationRef.current.navigate(thread.id);
        currentRunPollRef.current.invalidate();
        dispatch({ type: "select", threadId: thread.id });
        threadId = thread.id;
      }
      const runNavigation = navigationRef.current.capture();
      const run = await apiClient.createRun(threadId, request);
      if (!navigationRef.current.isCurrent(runNavigation)) return;
      // 新 Run 已成为当前事实时同步推进导航代次，使同 Thread 在途恢复响应立即失效。
      navigationRef.current.navigate(threadId);
      setRecoveryUi(undefined);
      // 新 Run 不能继承上一 Run 的 Attempt 或 sequence 游标。
      currentRunPollRef.current.activate(threadId, run.id);
      eventAfterRef.current = -1;
      eventAttemptRef.current = undefined;
      dispatch({ type: "startRun", run });
      setCurrentRequest(request);
      setInput("");
      setError(undefined);
    } catch (reason) {
      if (navigationRef.current.isCurrent(expectedNavigation)) setError(reason as ApiError);
    } finally {
      sendInFlightRef.current = false;
      setActionLoading(false);
    }
  };
  const archive = async () => {
    if (!state.selectedThreadId) return;
    const archivedThreadId = state.selectedThreadId;
    const expectedNavigation = navigationRef.current.capture();
    setActionLoading(true);
    try {
      await apiClient.archiveThread(archivedThreadId);
      dispatch({ type: "threadArchived", threadId: archivedThreadId });
      if (
        navigationRef.current.isCurrent(expectedNavigation) ||
        navigationRef.current.isSelected(archivedThreadId)
      ) {
        selectThread(undefined);
      }
    } catch (reason) {
      if (navigationRef.current.isCurrent(expectedNavigation)) setError(reason as ApiError);
    } finally {
      setActionLoading(false);
    }
  };
  const cancel = async () => {
    if (!state.run || !state.selectedThreadId) return;
    const cancelledRun = state.run;
    const expectedNavigation = navigationRef.current.capture();
    setActionLoading(true);
    try {
      const run = await apiClient.cancelRun(state.selectedThreadId, cancelledRun.id);
      if (navigationRef.current.isCurrent(expectedNavigation) && run.id === cancelledRun.id) {
        dispatch({ type: "run", run });
      }
    } catch (reason) {
      if (navigationRef.current.isCurrent(expectedNavigation)) setError(reason as ApiError);
    } finally {
      setActionLoading(false);
    }
  };
  const openArtifact = async (resolveUrl: () => Promise<string>, fallbackMessage: string) => {
    try {
      await openResolvedUrl(() => window.open("about:blank", "_blank"), resolveUrl);
    } catch (reason) {
      if (reason instanceof PopupBlockedError) {
        setError(new ApiError(reason.message, 0, false));
      } else {
        setError(reason instanceof ApiError ? reason : new ApiError(fallbackMessage, 0, true));
      }
    }
  };
  const download = async (artifactId: string) => {
    if (!state.selectedThreadId || !state.run) return;
    const threadId = state.selectedThreadId;
    const runId = state.run.id;
    await openArtifact(
      () => apiClient.downloadArtifact(threadId, runId, artifactId),
      "获取下载地址失败",
    );
  };
  const preview = async (artifactId: string) => {
    if (!state.selectedThreadId || !state.run) return;
    const threadId = state.selectedThreadId;
    const runId = state.run.id;
    try {
      const resolved = await apiClient.previewArtifact(threadId, runId, artifactId);
      if (resolved.kind === "text") {
        setTextPreview(resolved);
      } else {
        await openArtifact(() => Promise.resolve(resolved.url), "获取预览地址失败");
      }
    } catch (reason) {
      setError(reason instanceof ApiError ? reason : new ApiError("获取预览地址失败", 0, true));
    }
  };

  const selected = state.threads.find((thread) => thread.id === state.selectedThreadId);
  const currentRecovery =
    recoveryUi !== undefined &&
    recoveryUi.threadId === state.selectedThreadId &&
    recoveryUi.selectionGeneration === state.selectionGeneration
      ? recoveryUi
      : undefined;
  const visibleError = currentRecovery?.status === "error" ? currentRecovery.error : error;
  return (
    <main className={`workspace ${navigationOpen ? "navigation-open" : ""}`}>
      <NavigationSidebar
        isCompact={isCompact}
        isOpen={navigationOpen}
        returnFocusRef={mobileNavigationToggleRef}
        onClose={() => setNavigationOpen(false)}
      >
        <p className="identity-note">本地开发身份 · dev-user-a</p>
        <ThreadCreate actionLoading={actionLoading} onCreate={createConversation} />
        <div className="thread-heading">
          <span>会话</span>
          <span>{state.threads.length}</span>
        </div>
        <ThreadNavigation>
          {loading ? (
            <div className="empty compact">
              <LoaderCircle className="spin" size={18} />
              正在加载会话
            </div>
          ) : state.threads.length === 0 ? (
            <div className="empty compact">创建第一个会话以开始工作。</div>
          ) : (
            state.threads.map((thread) => (
              <button
                type="button"
                className={thread.id === state.selectedThreadId ? "thread selected" : "thread"}
                key={thread.id}
                onClick={() => selectThread(thread.id)}
              >
                <span>{thread.title}</span>
                <small>
                  {thread.status === "archived"
                    ? "已归档"
                    : new Date(thread.updatedAt).toLocaleString()}
                </small>
              </button>
            ))
          )}
        </ThreadNavigation>
      </NavigationSidebar>
      <section className="content" aria-label="对话工作区">
        <button
          ref={mobileNavigationToggleRef}
          className="mobile-nav-toggle icon-button"
          type="button"
          onClick={() => setNavigationOpen(true)}
          aria-label="打开会话导航"
        >
          <PanelLeftOpen size={18} />
        </button>
        {visibleError && (
          <div role="alert" className="error" aria-live="assertive">
            <span>
              <strong>操作未完成。</strong>
              {visibleError.message}
            </span>
            {visibleError.retryable && (
              <button
                type="button"
                className="icon-button"
                onClick={() => {
                  if (currentRecovery?.status === "error") {
                    setRecoveryNonce((nonce) => nonce + 1);
                  } else {
                    void refreshThreads();
                  }
                }}
                title="重试"
                aria-label="重试加载"
              >
                <RotateCw size={16} />
              </button>
            )}
          </div>
        )}
        {!selected ? (
          <div className="empty primary">
            <span className="welcome-mark" aria-hidden="true">
              ✦
            </span>
            <h1>准备好协作了吗？</h1>
            <p>描述任务后会自动创建会话，并用首条请求作为标题。</p>
          </div>
        ) : (
          <>
            <ThreadHeader
              thread={selected}
              run={state.run}
              actionLoading={actionLoading}
              onArchive={() => void archive()}
              onCancel={() => void cancel()}
            />
            <section className="run-area" aria-live="polite">
              {state.run && currentRequest && (
                <div className="message user-request">
                  <span className="message-avatar" aria-hidden="true">
                    你
                  </span>
                  <div className="message-card">
                    <span className="message-label">你的请求</span>
                    <p>{currentRequest}</p>
                  </div>
                </div>
              )}
              {state.run ? (
                <RunTimeline run={state.run} events={state.events} />
              ) : currentRecovery?.status === "loading" ? (
                <RunRecoveryLoading />
              ) : (
                <EmptyConversation />
              )}
            </section>
          </>
        )}
        <ConversationComposer
          input={input}
          disabled={actionLoading}
          onChange={setInput}
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        />
      </section>
      <ActivityPanel
        isOpen={activityOpen}
        artifacts={state.artifacts}
        onToggle={() => setActivityOpen((open) => !open)}
        onPreview={(artifactId) => void preview(artifactId)}
        onDownload={(artifactId) => void download(artifactId)}
      />
      {textPreview?.kind === "text" && (
        <dialog className="artifact-text-preview" open aria-label="纯文本交付物预览">
          <header>
            <strong>交付物预览</strong>
            <button type="button" className="icon-button" onClick={() => setTextPreview(undefined)}>
              关闭
            </button>
          </header>
          <pre>{textPreview.text}</pre>
        </dialog>
      )}
    </main>
  );
}

const rootElement = document.getElementById("root");
if (rootElement !== null) createRoot(rootElement).render(<App />);

import {
  LoaderCircle,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCw,
} from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, RuntimeApi } from "./api.js";
import { WorkspaceNavigation } from "./navigation.js";
import { CurrentRunPoll, drainEventPages } from "./polling.js";
import { openResolvedUrl, PopupBlockedError } from "./popup.js";
import { initialWorkspaceState, workspaceReducer } from "./state.js";
import "./styles.css";
import {
  ActivityPanel,
  activeRunStatuses,
  ConversationComposer,
  EmptyConversation,
  RunTimeline,
  ThreadHeader,
  ThreadNavigation,
} from "./workspace-view.js";

const api = new RuntimeApi();
function App() {
  const [state, dispatch] = useReducer(workspaceReducer, initialWorkspaceState);
  const [title, setTitle] = useState("");
  const [input, setInput] = useState("");
  const [currentRequest, setCurrentRequest] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<ApiError | undefined>();
  const [activityOpen, setActivityOpen] = useState(true);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const eventAfterRef = useRef(-1);
  const eventAttemptRef = useRef<string | undefined>(undefined);
  const currentRunPollRef = useRef(new CurrentRunPoll());
  const navigationRef = useRef(new WorkspaceNavigation());

  useEffect(() => {
    eventAfterRef.current = state.events.at(-1)?.sequence ?? -1;
    eventAttemptRef.current = state.eventAttemptId;
  }, [state.eventAttemptId, state.events]);

  const refreshThreads = useCallback(async () => {
    setLoading(true);
    try {
      dispatch({ type: "threads", threads: await api.listThreads() });
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason : new ApiError("加载线程失败", 0, true));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

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
        const latest = await api.getRun(threadId, runId);
        const [eventPage, artifacts] = await Promise.all([
          drainEventPages(
            (after, limit) => api.listEvents(threadId, runId, after, limit),
            eventAfterRef.current,
            eventAttemptRef.current,
          ),
          api.listArtifacts(threadId, runId),
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
  }, [state.run?.id, state.selectedThreadId]);

  const createThread = async () => {
    if (!title.trim()) return;
    const expectedNavigation = navigationRef.current.capture();
    setActionLoading(true);
    try {
      const thread = await api.createThread(title.trim());
      dispatch({ type: "threadCreated", thread });
      if (navigationRef.current.isCurrent(expectedNavigation)) {
        navigationRef.current.navigate(thread.id);
        currentRunPollRef.current.invalidate();
        dispatch({ type: "select", threadId: thread.id });
        setCurrentRequest(undefined);
        setError(undefined);
        setNavigationOpen(false);
      }
      setTitle("");
    } catch (reason) {
      if (navigationRef.current.isCurrent(expectedNavigation)) setError(reason as ApiError);
    } finally {
      setActionLoading(false);
    }
  };
  const send = async () => {
    if (!state.selectedThreadId || !input.trim()) return;
    const expectedNavigation = navigationRef.current.capture();
    setActionLoading(true);
    try {
      const request = input.trim();
      const run = await api.createRun(state.selectedThreadId, request);
      if (!navigationRef.current.isCurrent(expectedNavigation)) return;
      // 新 Run 不能继承上一 Run 的 Attempt 或 sequence 游标。
      currentRunPollRef.current.activate(state.selectedThreadId, run.id);
      eventAfterRef.current = -1;
      eventAttemptRef.current = undefined;
      dispatch({ type: "startRun", run });
      setCurrentRequest(request);
      setInput("");
      setError(undefined);
    } catch (reason) {
      if (navigationRef.current.isCurrent(expectedNavigation)) setError(reason as ApiError);
    } finally {
      setActionLoading(false);
    }
  };
  const archive = async () => {
    if (!state.selectedThreadId) return;
    const archivedThreadId = state.selectedThreadId;
    const expectedNavigation = navigationRef.current.capture();
    setActionLoading(true);
    try {
      await api.archiveThread(archivedThreadId);
      dispatch({ type: "threadArchived", threadId: archivedThreadId });
      if (
        navigationRef.current.isCurrent(expectedNavigation) ||
        navigationRef.current.isSelected(archivedThreadId)
      ) {
        navigationRef.current.navigate(undefined);
        currentRunPollRef.current.invalidate();
        dispatch({ type: "select", threadId: undefined });
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
      const run = await api.cancelRun(state.selectedThreadId, cancelledRun.id);
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
    await openArtifact(() => api.downloadArtifact(threadId, runId, artifactId), "获取下载地址失败");
  };
  const preview = async (artifactId: string) => {
    if (!state.selectedThreadId || !state.run) return;
    const threadId = state.selectedThreadId;
    const runId = state.run.id;
    await openArtifact(() => api.previewArtifact(threadId, runId, artifactId), "获取预览地址失败");
  };

  const selected = state.threads.find((thread) => thread.id === state.selectedThreadId);
  return (
    <main className={`workspace ${navigationOpen ? "navigation-open" : ""}`}>
      <aside className="sidebar" aria-label="会话导航">
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
            onClick={() => setNavigationOpen(false)}
            aria-label="关闭会话导航"
          >
            <PanelLeftClose size={18} />
          </button>
        </div>
        <p className="identity-note">本地开发身份 · dev-user-a</p>
        <div className="thread-create">
          <label className="sr-only" htmlFor="thread-title">
            新建会话标题
          </label>
          <input
            id="thread-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createThread();
            }}
            placeholder="新建会话标题"
          />
          <button
            type="button"
            className="icon-button"
            title="创建会话"
            aria-label="创建会话"
            onClick={() => void createThread()}
            disabled={actionLoading || !title.trim()}
          >
            <MessageSquarePlus size={17} />
          </button>
        </div>
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
                onClick={() => {
                  navigationRef.current.navigate(thread.id);
                  currentRunPollRef.current.invalidate();
                  dispatch({ type: "select", threadId: thread.id });
                  setCurrentRequest(undefined);
                  setNavigationOpen(false);
                }}
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
      </aside>
      <section className="content" aria-label="对话工作区">
        <button
          className="mobile-nav-toggle icon-button"
          type="button"
          onClick={() => setNavigationOpen(true)}
          aria-label="打开会话导航"
        >
          <PanelLeftOpen size={18} />
        </button>
        {error && (
          <div role="alert" className="error" aria-live="assertive">
            <span>
              <strong>操作未完成。</strong>
              {error.message}
            </span>
            {error.retryable && (
              <button
                type="button"
                className="icon-button"
                onClick={() => void refreshThreads()}
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
            <p>从左侧选择一个会话，或先创建新的工作会话。</p>
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
              {state.run ? <RunTimeline events={state.events} /> : <EmptyConversation />}
            </section>
            <ConversationComposer
              input={input}
              disabled={actionLoading}
              onChange={setInput}
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            />
          </>
        )}
      </section>
      <ActivityPanel
        isOpen={activityOpen}
        events={state.events}
        artifacts={state.artifacts}
        onToggle={() => setActivityOpen((open) => !open)}
        onPreview={(artifactId) => void preview(artifactId)}
        onDownload={(artifactId) => void download(artifactId)}
      />
    </main>
  );
}

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("未找到应用挂载节点");
createRoot(rootElement).render(<App />);

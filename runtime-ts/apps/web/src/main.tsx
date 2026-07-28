import {
  Archive,
  Download,
  LoaderCircle,
  MessageSquarePlus,
  RotateCw,
  Send,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, type RunEvent, RuntimeApi } from "./api.js";
import { initialWorkspaceState, workspaceReducer } from "./state.js";
import "./styles.css";

const api = new RuntimeApi();
const active = new Set(["queued", "running", "waiting"]);

function eventText(event: RunEvent): string {
  const payload = event.payload;
  if (typeof payload === "string") return payload;
  if (typeof payload === "object" && payload !== null) {
    const value = payload as {
      readonly text?: unknown;
      readonly content?: unknown;
      readonly message?: unknown;
      readonly name?: unknown;
    };
    for (const candidate of [value.text, value.content, value.message, value.name]) {
      if (typeof candidate === "string") return candidate;
    }
    return JSON.stringify(payload);
  }
  return String(payload ?? "");
}

function RunTimeline({ events }: { readonly events: readonly RunEvent[] }) {
  if (events.length === 0) return <div className="empty compact">等待运行事件</div>;
  return (
    <ol className="timeline">
      {events.map((event) => (
        <li key={event.eventId ?? `${event.sequence}`}>
          <span className="event-type">{event.type.replaceAll("_", " ")}</span>
          <p>{eventText(event)}</p>
        </li>
      ))}
    </ol>
  );
}

function App() {
  const [state, dispatch] = useReducer(workspaceReducer, initialWorkspaceState);
  const [title, setTitle] = useState("");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<ApiError | undefined>();

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
    const run = state.run;
    const threadId = state.selectedThreadId;
    if (run === undefined || threadId === undefined) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const latest = await api.getRun(threadId, run.id);
        const after = state.events.at(-1)?.sequence ?? -1;
        const [events, artifacts] = await Promise.all([
          api.listEvents(threadId, run.id, after),
          api.listArtifacts(threadId, run.id),
        ]);
        if (!cancelled) {
          dispatch({ type: "run", run: latest });
          dispatch({ type: "events", events });
          dispatch({ type: "artifacts", artifacts });
        }
      } catch (reason) {
        if (!cancelled)
          setError(reason instanceof ApiError ? reason : new ApiError("轮询运行状态失败", 0, true));
      }
    };
    void poll();
    if (!active.has(run.status))
      return () => {
        cancelled = true;
      };
    const id = window.setInterval(() => void poll(), 1200);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [state.events, state.run, state.selectedThreadId]);

  const createThread = async () => {
    if (!title.trim()) return;
    setActionLoading(true);
    try {
      const thread = await api.createThread(title.trim());
      dispatch({ type: "threads", threads: [thread, ...state.threads] });
      dispatch({ type: "select", threadId: thread.id });
      setTitle("");
      setError(undefined);
    } catch (reason) {
      setError(reason as ApiError);
    } finally {
      setActionLoading(false);
    }
  };
  const send = async () => {
    if (!state.selectedThreadId || !input.trim()) return;
    setActionLoading(true);
    try {
      dispatch({ type: "run", run: await api.createRun(state.selectedThreadId, input.trim()) });
      setInput("");
      setError(undefined);
    } catch (reason) {
      setError(reason as ApiError);
    } finally {
      setActionLoading(false);
    }
  };
  const archive = async () => {
    if (!state.selectedThreadId) return;
    setActionLoading(true);
    try {
      await api.archiveThread(state.selectedThreadId);
      dispatch({
        type: "threads",
        threads: state.threads.filter((thread) => thread.id !== state.selectedThreadId),
      });
      dispatch({ type: "select", threadId: "" });
    } catch (reason) {
      setError(reason as ApiError);
    } finally {
      setActionLoading(false);
    }
  };
  const cancel = async () => {
    if (!state.run || !state.selectedThreadId) return;
    setActionLoading(true);
    try {
      dispatch({ type: "run", run: await api.cancelRun(state.selectedThreadId, state.run.id) });
    } catch (reason) {
      setError(reason as ApiError);
    } finally {
      setActionLoading(false);
    }
  };

  const selected = state.threads.find((thread) => thread.id === state.selectedThreadId);
  return (
    <main className="workspace">
      <aside className="sidebar">
        <div className="brand">
          <span>Agent 工作台</span>
          <small>本地开发身份: dev-user-a</small>
        </div>
        <div className="thread-create">
          <input
            aria-label="线程标题"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="新线程标题"
          />
          <button
            type="button"
            title="创建线程"
            onClick={() => void createThread()}
            disabled={actionLoading || !title.trim()}
          >
            <MessageSquarePlus size={17} />
          </button>
        </div>
        <div className="thread-list">
          {loading ? (
            <div className="empty">
              <LoaderCircle className="spin" size={18} />
              正在加载
            </div>
          ) : state.threads.length === 0 ? (
            <div className="empty">尚无线程</div>
          ) : (
            state.threads.map((thread) => (
              <button
                type="button"
                className={thread.id === state.selectedThreadId ? "thread selected" : "thread"}
                key={thread.id}
                onClick={() => dispatch({ type: "select", threadId: thread.id })}
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
        </div>
      </aside>
      <section className="content">
        {error && (
          <div role="alert" className="error">
            <span>{error.message}</span>
            {error.retryable && (
              <button type="button" onClick={() => void refreshThreads()} title="重试">
                <RotateCw size={16} />
              </button>
            )}
          </div>
        )}
        {!selected ? (
          <div className="empty primary">选择一个线程，或创建新的工作线程</div>
        ) : (
          <>
            <header>
              <div>
                <h1>{selected.title}</h1>
                <span className="status">{state.run?.status ?? "就绪"}</span>
              </div>
              <button
                type="button"
                title="归档线程"
                onClick={() => void archive()}
                disabled={actionLoading}
              >
                <Archive size={18} />
              </button>
            </header>
            <section className="run-area">
              {state.run && (
                <div className="run-head">
                  <span>运行 {state.run.id}</span>
                  {active.has(state.run.status) && (
                    <button
                      type="button"
                      title="取消运行"
                      onClick={() => void cancel()}
                      disabled={actionLoading}
                    >
                      <Square size={15} />
                    </button>
                  )}
                </div>
              )}
              <RunTimeline events={state.events} />
            </section>
            <section className="artifacts">
              <h2>产物</h2>
              {state.artifacts.length === 0 ? (
                <div className="empty compact">此运行尚未生成产物</div>
              ) : (
                <ul>
                  {state.artifacts.map((artifact) => (
                    <li key={artifact.id}>
                      <div>
                        <strong>{artifact.name}</strong>
                        <small>
                          {artifact.status}
                          {artifact.mediaType ? ` · ${artifact.mediaType}` : ""}
                        </small>
                      </div>
                      <button
                        type="button"
                        title="下载产物"
                        disabled={artifact.status !== "published"}
                        onClick={() =>
                          void api
                            .downloadArtifact(artifact.id)
                            .then((url) => window.open(url, "_blank", "noopener"))
                        }
                      >
                        <Download size={16} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <textarea
                aria-label="发送消息"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="输入消息"
                rows={3}
              />
              <button type="submit" title="发送消息" disabled={actionLoading || !input.trim()}>
                <Send size={18} />
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("未找到应用挂载节点");
createRoot(rootElement).render(<App />);

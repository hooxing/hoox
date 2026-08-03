import { LoaderCircle, PanelLeftOpen, Puzzle, RotateCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ApiError,
  type ArtifactPreview,
  type Run,
  type RunStatus,
  RuntimeApi,
  type Thread,
  type ThreadInputReceipt,
  type UploadedResource,
} from "./api.js";
import { recoverLatestRunForNavigation, WorkspaceNavigation } from "./navigation.js";
import { CurrentRunPoll, drainEventPages } from "./polling.js";
import { openResolvedUrl, PopupBlockedError } from "./popup.js";
import { initialWorkspaceState, workspaceReducer } from "./state.js";
import { SkillCenterDialog, type SkillCenterApi } from "./skill-center.js";
import "./styles.css";
import {
  ConversationComposer,
  compactWorkspaceMedia,
  EmptyConversation,
  InlineArtifactDelivery,
  NavigationSidebar,
  pollingRunStatuses,
  RunRecoveryLoading,
  RunTimeline,
  RunTranscript,
  ThreadCreate,
  ThreadHeader,
  ThreadNavigation,
  ThreadTranscript,
  type PendingThreadInputView,
} from "./workspace-view.js";

const api = new RuntimeApi();

type PendingConversationInput = PendingThreadInputView & {
  readonly expectedUserOccurrence: number;
  readonly receipt?: ThreadInputReceipt;
};

export function nextExpectedUserOccurrence(
  messages: readonly { readonly role: string; readonly text: string }[],
  pending: readonly {
    readonly text: string;
    readonly disposition: PendingThreadInputView["disposition"];
    readonly expectedUserOccurrence: number;
  }[],
  text: string,
): number {
  const persisted = messages.filter(
    (message) => message.role === "user" && message.text === text,
  ).length;
  const activeDispositions = new Set<PendingThreadInputView["disposition"]>([
    "submitting",
    "pending_steer",
    "steered",
    "queued",
  ]);
  return (
    pending.reduce(
      (highest, message) =>
        message.text === text &&
        activeDispositions.has(message.disposition) &&
        message.expectedUserOccurrence > persisted
          ? Math.max(highest, message.expectedUserOccurrence)
          : highest,
      persisted,
    ) + 1
  );
}

/** 首条请求在浏览器侧生成稳定标题，既满足现有必填协议，也不把取名工作交给用户。 */
export function deriveThreadTitle(query: string): string {
  const cleaned = query
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/[`*_#>[\]()]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned.length === 0) return "新任务";
  return compactThreadTitle(cleaned, 18);
}

export function compactThreadTitle(title: string, limit = 16): string {
  const normalized = title.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  return characters.length > limit ? `${characters.slice(0, limit).join("")}…` : normalized;
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
  | "listModelWireTraces"
  | "listThreads"
  | "previewArtifact"
  | "uploadResource"
> & {
  readonly listThreadContext?: RuntimeApi["listThreadContext"];
  readonly getThreadContinuity?: RuntimeApi["getThreadContinuity"];
  readonly submitThreadInput?: RuntimeApi["submitThreadInput"];
  readonly getThreadInputReceipt?: RuntimeApi["getThreadInputReceipt"];
} & Partial<SkillCenterApi>;

function resolveSkillCenterApi(client: WorkspaceApi): SkillCenterApi | undefined {
  const { listSkills, listInstalledSkills, installSkill, setSkillEnabled, uninstallSkill } = client;
  if (
    listSkills === undefined ||
    listInstalledSkills === undefined ||
    installSkill === undefined ||
    setSkillEnabled === undefined ||
    uninstallSkill === undefined
  ) {
    return undefined;
  }
  return {
    listSkills: listSkills.bind(client),
    listInstalledSkills: listInstalledSkills.bind(client),
    installSkill: installSkill.bind(client),
    setSkillEnabled: setSkillEnabled.bind(client),
    uninstallSkill: uninstallSkill.bind(client),
  };
}

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

/** waiting 已由 Worker 持久化为用户输入边界，不能继续短轮询。 */
export function shouldContinueRunPolling(
  hasMoreEvents: boolean,
  status: RunStatus,
  sandboxState?: "running" | "pausing" | "paused" | "resuming" | "terminated" | "unknown",
  executionStatus?: Run["executionStatus"],
): boolean {
  // durable recovery_required 已证明没有 Worker 继续执行；事件、诊断或 Sandbox 瞬时态都不能重启无界轮询。
  if (executionStatus === "recovery_required") return false;
  return (
    hasMoreEvents ||
    pollingRunStatuses.has(status) ||
    sandboxState === "pausing" ||
    sandboxState === "resuming"
  );
}

export function shouldFollowLatest(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = 96,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

export function App({ apiClient = api }: { readonly apiClient?: WorkspaceApi }) {
  const initialCompact = window.matchMedia(compactWorkspaceMedia).matches;
  const [state, dispatch] = useReducer(workspaceReducer, initialWorkspaceState);
  const [input, setInput] = useState("");
  const [uploadFiles, setUploadFiles] = useState<readonly File[]>([]);
  const [pendingInputs, setPendingInputs] = useState<readonly PendingConversationInput[]>([]);
  const [continuity, setContinuity] =
    useState<Awaited<ReturnType<RuntimeApi["getThreadContinuity"]>>>();
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<ApiError | undefined>();
  const [textPreview, setTextPreview] = useState<ArtifactPreview | undefined>();
  const [recoveryUi, setRecoveryUi] = useState<RecoveryUiState | undefined>();
  const [recoveryNonce, setRecoveryNonce] = useState(0);
  const [isCompact, setIsCompact] = useState(initialCompact);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [skillCenterOpen, setSkillCenterOpen] = useState(false);
  const eventAfterRef = useRef(-1);
  const eventAttemptRef = useRef<string | undefined>(undefined);
  const modelWireTracePaginationAdvancedRef = useRef(false);
  const modelWireTraceTailCursorRef = useRef<string | undefined>(undefined);
  const currentRunPollRef = useRef(new CurrentRunPoll());
  const runExecutionStatusRef = useRef<Run["executionStatus"]>(undefined);
  const navigationRef = useRef(new WorkspaceNavigation());
  const mobileNavigationToggleRef = useRef<HTMLButtonElement>(null);
  const runAreaRef = useRef<HTMLElement>(null);
  const followLatestRef = useRef(true);
  const followedThreadRef = useRef<string | undefined>(undefined);
  const sendInFlightRef = useRef(false);
  const uploadIdempotencyKeysRef = useRef(new WeakMap<File, string>());
  const initialSelectionAppliedRef = useRef(false);
  runExecutionStatusRef.current = state.run?.executionStatus;
  const skillCenterApi = useMemo(() => resolveSkillCenterApi(apiClient), [apiClient]);

  const selectThread = useCallback((threadId: string | undefined) => {
    navigationRef.current.navigate(threadId);
    currentRunPollRef.current.invalidate();
    dispatch({ type: "select", threadId });
    setPendingInputs([]);
    setError(undefined);
    setNavigationOpen(false);
  }, []);

  useEffect(() => {
    const media = window.matchMedia(compactWorkspaceMedia);
    const updateLayout = (event: MediaQueryListEvent) => {
      setIsCompact(event.matches);
      if (event.matches) setNavigationOpen(false);
    };
    media.addEventListener("change", updateLayout);
    return () => media.removeEventListener("change", updateLayout);
  }, []);

  useEffect(() => {
    eventAfterRef.current = state.events.at(-1)?.sequence ?? -1;
    eventAttemptRef.current = state.eventAttemptId;
  }, [state.eventAttemptId, state.events]);

  useEffect(() => {
    modelWireTracePaginationAdvancedRef.current = state.modelWireTracePaginationAdvanced;
    modelWireTraceTailCursorRef.current = state.modelWireTraceTailFollowing
      ? state.modelWireTraceNextCursor
      : undefined;
  }, [
    state.modelWireTraceNextCursor,
    state.modelWireTracePaginationAdvanced,
    state.modelWireTraceTailFollowing,
  ]);

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
    if (threadId === undefined || apiClient.listThreadContext === undefined) {
      dispatch({ type: "threadContext", items: undefined });
      return;
    }
    const expected = navigationRef.current.capture();
    let stopped = false;
    void apiClient
      .listThreadContext(threadId)
      .then((items) => {
        if (!stopped && navigationRef.current.isCurrent(expected)) {
          dispatch({ type: "threadContext", items });
        }
      })
      .catch(() => {
        if (!stopped && navigationRef.current.isCurrent(expected)) {
          dispatch({ type: "threadContext", items: undefined });
        }
      });
    return () => {
      stopped = true;
    };
  }, [apiClient, state.selectedThreadId]);

  useEffect(() => {
    const threadId = state.selectedThreadId;
    if (threadId === undefined || apiClient.getThreadContinuity === undefined) {
      setContinuity(undefined);
      return;
    }
    const expected = navigationRef.current.capture();
    let stopped = false;
    void apiClient
      .getThreadContinuity(threadId)
      .then((status) => {
        if (!stopped && navigationRef.current.isCurrent(expected)) setContinuity(status);
      })
      .catch(() => {
        if (!stopped && navigationRef.current.isCurrent(expected)) setContinuity(undefined);
      });
    return () => {
      stopped = true;
    };
  }, [apiClient, state.selectedThreadId]);

  useEffect(() => {
    const threadId = state.selectedThreadId;
    const runId = state.run?.id;
    if (runId === undefined || threadId === undefined) return;
    const pollGeneration = currentRunPollRef.current.activate(threadId, runId);
    let stopped = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      if (!currentRunPollRef.current.isCurrent(pollGeneration)) return;
      let recoveryRequired = runExecutionStatusRef.current === "recovery_required";
      try {
        const latest = await apiClient.getRun(threadId, runId);
        recoveryRequired = latest.executionStatus === "recovery_required";
        const tailCursor = modelWireTraceTailCursorRef.current;
        const [
          eventPage,
          artifacts,
          modelWireTraces,
          modelWireTraceTail,
          threadContext,
          continuityStatus,
        ] = await Promise.all([
          drainEventPages(
            (after, limit) => apiClient.listEvents(threadId, runId, after, limit),
            eventAfterRef.current,
            eventAttemptRef.current,
          ),
          apiClient.listArtifacts(threadId, runId),
          apiClient
            .listModelWireTraces(threadId, runId)
            .catch(() => ({ items: [], hasMore: false, unavailable: true })),
          tailCursor === undefined
            ? Promise.resolve(undefined)
            : apiClient.listModelWireTraces(threadId, runId, tailCursor).catch(() => undefined),
          apiClient.listThreadContext?.(threadId).catch(() => undefined) ??
            Promise.resolve(undefined),
          apiClient.getThreadContinuity?.(threadId).catch(() => undefined) ??
            Promise.resolve(undefined),
        ]);
        if (!stopped && currentRunPollRef.current.isCurrent(pollGeneration)) {
          eventAttemptRef.current = eventPage.attemptId;
          eventAfterRef.current = eventPage.nextAfter;
          dispatch({ type: "run", run: latest });
          dispatch({ type: "events", page: eventPage });
          dispatch({ type: "artifacts", artifacts });
          if (apiClient.listThreadContext !== undefined) {
            dispatch({ type: "threadContext", items: threadContext });
          }
          if (apiClient.getThreadContinuity !== undefined) setContinuity(continuityStatus);
          dispatch({ type: "modelWireTraces", page: modelWireTraces, mode: "refreshHead" });
          if (modelWireTraceTail !== undefined) {
            dispatch({ type: "modelWireTraces", page: modelWireTraceTail, mode: "append" });
          }
          if (
            !eventPage.hasMore &&
            (latest.status === "succeeded" ||
              latest.status === "failed" ||
              latest.status === "cancelled")
          ) {
            const [nextRun] = await apiClient.listLatestRuns(threadId, 1);
            if (
              nextRun !== undefined &&
              nextRun.id !== runId &&
              !stopped &&
              currentRunPollRef.current.isCurrent(pollGeneration)
            ) {
              // follow-up 被激活后继续追踪新 Run；对话历史本身不切换、不清空。
              currentRunPollRef.current.invalidate(pollGeneration);
              eventAfterRef.current = -1;
              eventAttemptRef.current = undefined;
              dispatch({ type: "startRun", run: nextRun });
              return;
            }
          }
          // 终态也必须追完已抵达尾页后的跨页新增诊断；waiting 仍不因普通 Run 状态保持短轮询。
          if (
            !recoveryRequired &&
            (shouldContinueRunPolling(
              eventPage.hasMore,
              latest.status,
              continuityStatus?.sandboxState,
              latest.executionStatus,
            ) ||
              modelWireTraceTail?.hasMore === true ||
              (modelWireTraces.hasMore && !modelWireTracePaginationAdvancedRef.current))
          ) {
            timer = window.setTimeout(() => void poll(), 1200);
          }
        }
      } catch (reason) {
        if (!stopped && currentRunPollRef.current.isCurrent(pollGeneration)) {
          setError(reason instanceof ApiError ? reason : new ApiError("轮询运行状态失败", 0, true));
          if (!recoveryRequired) timer = window.setTimeout(() => void poll(), 1200);
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
    const pendingReceipts = pendingInputs
      .map((item) => item.receipt)
      .filter(
        (receipt): receipt is ThreadInputReceipt =>
          receipt?.disposition === "pending_steer" && !receipt.receiptId.startsWith("legacy-"),
      );
    if (
      pendingReceipts.length === 0 ||
      state.selectedThreadId === undefined ||
      apiClient.getThreadInputReceipt === undefined
    )
      return;
    const threadId = state.selectedThreadId;
    const getThreadInputReceipt = apiClient.getThreadInputReceipt;
    let stopped = false;
    const timer = window.setInterval(() => {
      void Promise.all(
        pendingReceipts.map((receipt) => getThreadInputReceipt(threadId, receipt.receiptId)),
      )
        .then((receipts) => {
          if (stopped) return;
          const byId = new Map(receipts.map((receipt) => [receipt.receiptId, receipt]));
          setPendingInputs((current) =>
            current.map((item) => {
              const receipt = item.receipt && byId.get(item.receipt.receiptId);
              return receipt === undefined
                ? item
                : {
                    ...item,
                    receipt,
                    disposition: receipt.disposition,
                    ...(receipt.queueSequence === undefined
                      ? {}
                      : { queueSequence: receipt.queueSequence }),
                    ...(receipt.rejectionCode === undefined
                      ? {}
                      : { rejectionCode: receipt.rejectionCode }),
                  };
            }),
          );
        })
        .catch(() => undefined);
    }, 1_200);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [apiClient, pendingInputs, state.selectedThreadId]);

  const createConversation = () => selectThread(undefined);
  const send = async (mode: "auto" | "follow_up" = "auto") => {
    if ((!input.trim() && uploadFiles.length === 0) || actionLoading || sendInFlightRef.current)
      return;
    sendInFlightRef.current = true;
    const expectedNavigation = navigationRef.current.capture();
    setActionLoading(true);
    try {
      const request = input.trim() || "请处理本轮上传的文件。";
      const expectedUserOccurrence = nextExpectedUserOccurrence(
        state.threadContext ?? [],
        pendingInputs,
        request,
      );
      const localId = crypto.randomUUID();
      const uploaded: readonly UploadedResource[] = await Promise.all(
        uploadFiles.map((file) => {
          let idempotencyKey = uploadIdempotencyKeysRef.current.get(file);
          if (idempotencyKey === undefined) {
            idempotencyKey = crypto.randomUUID();
            uploadIdempotencyKeysRef.current.set(file, idempotencyKey);
          }
          return apiClient.uploadResource(file, idempotencyKey);
        }),
      );
      let threadId = state.selectedThreadId;
      if (threadId === undefined) {
        const thread = await apiClient.createThread(deriveThreadTitle(request));
        dispatch({ type: "threadCreated", thread });
        if (!navigationRef.current.isCurrent(expectedNavigation)) return;
        navigationRef.current.navigate(thread.id);
        currentRunPollRef.current.invalidate();
        dispatch({ type: "select", threadId: thread.id });
        setPendingInputs([]);
        threadId = thread.id;
      }
      const runNavigation = navigationRef.current.capture();
      const receipt =
        apiClient.submitThreadInput === undefined
          ? undefined
          : await apiClient.submitThreadInput(
              threadId,
              request,
              mode,
              state.run?.status === "running" ? state.run.id : undefined,
              uploaded,
            );
      const run =
        receipt === undefined
          ? await apiClient.createRun(threadId, request)
          : (receipt.queuedRun ??
            (receipt.queuedRunId === undefined
              ? undefined
              : await apiClient.getRun(threadId, receipt.queuedRunId)));
      if (!navigationRef.current.isCurrent(runNavigation)) return;
      setPendingInputs((current) => [
        ...current,
        {
          localId,
          text: request,
          expectedUserOccurrence,
          disposition: receipt?.disposition ?? "queued",
          ...(receipt === undefined ? {} : { receipt }),
          ...(receipt?.queueSequence === undefined ? {} : { queueSequence: receipt.queueSequence }),
          ...(receipt?.rejectionCode === undefined ? {} : { rejectionCode: receipt.rejectionCode }),
        },
      ]);
      if (run === undefined || state.run?.status === "running") {
        setInput("");
        setUploadFiles([]);
        setError(undefined);
        return;
      }
      // 新 Run 已成为当前事实时同步推进导航代次，使同 Thread 在途恢复响应立即失效。
      navigationRef.current.navigate(threadId);
      setRecoveryUi(undefined);
      // 新 Run 不能继承上一 Run 的 Attempt 或 sequence 游标。
      currentRunPollRef.current.activate(threadId, run.id);
      eventAfterRef.current = -1;
      eventAttemptRef.current = undefined;
      dispatch({ type: "startRun", run });
      setInput("");
      setUploadFiles([]);
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
  const currentRunHasAssistantContext =
    state.run !== undefined &&
    state.threadContext?.some((item) => item.runId === state.run?.id && item.role === "assistant");
  const persistedUserOccurrences = new Map<string, number>();
  for (const message of state.threadContext ?? []) {
    if (message.role !== "user") continue;
    persistedUserOccurrences.set(
      message.text,
      (persistedUserOccurrences.get(message.text) ?? 0) + 1,
    );
  }
  const visiblePendingInputs = pendingInputs.filter(
    (message) => (persistedUserOccurrences.get(message.text) ?? 0) < message.expectedUserOccurrence,
  );
  const renderedContentVersion = [
    state.artifacts.length,
    state.events.length,
    state.run?.updatedAt ?? "",
    state.threadContext?.length ?? 0,
    visiblePendingInputs.length,
  ].join(":");
  useLayoutEffect(() => {
    const runArea = runAreaRef.current;
    if (runArea === null) return;
    // 内容版本只负责触发本次布局同步；滚动是否跟随仍由用户当前位置决定。
    void renderedContentVersion;
    if (followedThreadRef.current !== state.selectedThreadId) {
      followedThreadRef.current = state.selectedThreadId;
      followLatestRef.current = true;
    }
    if (followLatestRef.current) runArea.scrollTop = runArea.scrollHeight;
  }, [renderedContentVersion, state.selectedThreadId]);
  return (
    <main className={`workspace ${navigationOpen ? "navigation-open" : ""}`}>
      <NavigationSidebar
        isCompact={isCompact}
        isOpen={navigationOpen}
        returnFocusRef={mobileNavigationToggleRef}
        onClose={() => setNavigationOpen(false)}
      >
        <ThreadCreate actionLoading={actionLoading} onCreate={createConversation} />
        {skillCenterApi !== undefined && (
          <button
            type="button"
            className="skill-center-entry"
            onClick={() => {
              setSkillCenterOpen(true);
              setNavigationOpen(false);
            }}
          >
            <Puzzle size={17} />
            技能中心
          </button>
        )}
        <div className="thread-heading">
          <span>任务</span>
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
                aria-label={`${thread.title}${thread.status === "archived" ? "，已归档" : ""}`}
              >
                <span title={thread.title}>{compactThreadTitle(thread.title)}</span>
                {thread.status === "archived" && <small>已归档</small>}
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
              {...(continuity === undefined ? {} : { continuity })}
              actionLoading={actionLoading}
              onArchive={() => void archive()}
              onCancel={() => void cancel()}
            />
            <section
              ref={runAreaRef}
              className="run-area"
              aria-live="polite"
              onScroll={(event) => {
                const area = event.currentTarget;
                followLatestRef.current = shouldFollowLatest(
                  area.scrollHeight,
                  area.scrollTop,
                  area.clientHeight,
                );
              }}
            >
              <ThreadTranscript
                messages={state.threadContext ?? []}
                pendingInputs={visiblePendingInputs}
                {...(state.run === undefined
                  ? {}
                  : { currentRun: state.run, currentRunEvents: state.events })}
              />
              {state.run ? (
                <>
                  {!currentRunHasAssistantContext && (
                    <RunTranscript run={state.run} events={state.events} />
                  )}
                  <InlineArtifactDelivery
                    artifacts={state.artifacts}
                    onPreview={(artifactId) => void preview(artifactId)}
                    onDownload={(artifactId) => void download(artifactId)}
                  />
                </>
              ) : currentRecovery?.status === "loading" ? (
                <RunRecoveryLoading />
              ) : (
                <EmptyConversation />
              )}
            </section>
            {state.run && (
              <div className="run-progress-dock">
                <RunTimeline run={state.run} events={state.events} />
              </div>
            )}
          </>
        )}
        <ConversationComposer
          input={input}
          files={uploadFiles}
          disabled={actionLoading}
          onChange={setInput}
          onFilesChange={setUploadFiles}
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
          showQueueAction={
            state.run?.status === "running" && state.run.executionStatus !== "recovery_required"
          }
          onQueue={() => void send("follow_up")}
        />
      </section>
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
      {skillCenterOpen && skillCenterApi !== undefined && (
        <SkillCenterDialog api={skillCenterApi} onClose={() => setSkillCenterOpen(false)} />
      )}
    </main>
  );
}

const rootElement = document.getElementById("root");
if (rootElement !== null) createRoot(rootElement).render(<App />);

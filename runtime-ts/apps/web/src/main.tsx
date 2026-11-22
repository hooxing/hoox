import {
  CalendarClock,
  Cloud,
  LoaderCircle,
  Pencil,
  PanelLeftOpen,
  Puzzle,
  RotateCw,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import "./file-preview.css";
import {
  appendFileReferences,
  MAX_FILE_REFERENCES,
  type FileSource,
  type FileSelection,
  type FileReference,
} from "@hoox/protocol/file-references";
import { FilePreviewPanel, type PreviewTarget } from "./file-preview-panel.js";
import {
  DraftFileReferences,
  FilePreviewContext,
  useFileReferenceDraft,
} from "./file-reference-view.js";
import {
  ApiError,
  type ArtifactPreview,
  type HistoryFile,
  type Run,
  type RunStatus,
  RuntimeApi,
  type TeamSummary,
  type Thread,
  type ThreadInputReceipt,
  type AvailableAgent,
  type UploadedResource,
} from "./api.js";
import {
  AccountAccess,
  AccountMenu,
  type AccountProfile,
  type AccountSession,
  clearAccountSession,
  persistAccountSession,
  readAccountSession,
} from "./account-access.js";
import { type AutomationCenterApi, AutomationCenterDialog } from "./automation-center.js";
import { HOOX_HORIZONTAL_PATH } from "./brand.js";
import { type CloudDriveApi, CloudDriveDialog } from "./cloud-drive.js";
import { clearAccountDrafts, useConversationDraft } from "./conversation-draft.js";
import { recoverLatestRunForNavigation, WorkspaceNavigation } from "./navigation.js";
import { CurrentRunPoll, drainEventPages, loadAllRunEvents } from "./polling.js";
import { followRunOutput } from "./run-output.js";
import { openResolvedUrl, PopupBlockedError } from "./popup.js";
import { type PersonalizationApi, PersonalizationDialog } from "./personalization.js";
import { type SkillCenterApi, SkillCenterDialog } from "./skill-center.js";
import { initialWorkspaceState, workspaceReducer } from "./state.js";
import {
  TeamCenterDialog,
  TeamManagementDialog,
  TeamSwitcher,
  type TeamWorkspaceApi,
} from "./team-workspace.js";
import "@hoox/ui-theme/theme.css";
import "./styles.css";
import {
  ConversationComposer,
  compactWorkspaceMedia,
  EmptyConversation,
  InlineArtifactDelivery,
  NavigationSidebar,
  NewThreadAgentWelcome,
  type PendingThreadInputView,
  pollingRunStatuses,
  RunRecoveryLoading,
  RunTimeline,
  ThreadCreate,
  ThreadHeader,
  ThreadNavigation,
  ThreadTranscript,
} from "./workspace-view.js";

import { useActionDialog } from "./action-dialog.js";

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
  | "listThreads"
  | "previewArtifact"
  | "uploadResource"
> & {
  readonly readArtifactContent?: RuntimeApi["readArtifactContent"];
  readonly streamEvents?: RuntimeApi["streamEvents"];
  readonly listThreadContext?: RuntimeApi["listThreadContext"];
  readonly previewHistoryFile?: RuntimeApi["previewHistoryFile"];
  readonly getThread?: RuntimeApi["getThread"];
  readonly getThreadContinuity?: RuntimeApi["getThreadContinuity"];
  readonly submitThreadInput?: RuntimeApi["submitThreadInput"];
  readonly getThreadInputReceipt?: RuntimeApi["getThreadInputReceipt"];
  readonly listAvailableAgents?: RuntimeApi["listAvailableAgents"];
} & Partial<SkillCenterApi & CloudDriveApi & AutomationCenterApi>;

type TeamAwareWorkspaceApi = WorkspaceApi &
  Partial<PersonalizationApi> &
  Partial<
    TeamWorkspaceApi &
      Pick<
        RuntimeApi,
        | "forkThread"
        | "downloadHistoryFileForTenant"
        | "getTenantId"
        | "importTeamFile"
        | "listHistoryFilesForTenant"
        | "listThreadsForTenant"
        | "archiveThreadForTenant"
        | "renamePersonalThread"
        | "renamePersonalThreadForTenant"
        | "setTenantId"
      >
  > &
  Partial<
    Pick<
      RuntimeApi,
      | "beginSocialSignIn"
      | "exchangeIdentitySession"
      | "getIdentityConfiguration"
      | "loginAccount"
      | "logoutAccount"
      | "registerAccount"
      | "resendEmailVerificationOtp"
      | "sendPhoneOtp"
      | "setAccessToken"
      | "signInWithEmail"
      | "signUpWithEmail"
      | "verifyEmailOtp"
      | "verifyPhoneOtp"
    >
  >;

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

function resolveAutomationCenterApi(client: WorkspaceApi): AutomationCenterApi | undefined {
  const { listScheduledTasks, createScheduledTask, updateScheduledTask } = client;
  if (
    listScheduledTasks === undefined ||
    createScheduledTask === undefined ||
    updateScheduledTask === undefined
  ) {
    return undefined;
  }
  return {
    listScheduledTasks: listScheduledTasks.bind(client),
    createScheduledTask: createScheduledTask.bind(client),
    updateScheduledTask: updateScheduledTask.bind(client),
  };
}

function resolveCloudDriveApi(client: WorkspaceApi): CloudDriveApi | undefined {
  const { listHistoryFiles, downloadHistoryFile } = client;
  if (listHistoryFiles === undefined || downloadHistoryFile === undefined) return undefined;
  return {
    listHistoryFiles: listHistoryFiles.bind(client),
    downloadHistoryFile: downloadHistoryFile.bind(client),
  };
}

function resolveTeamWorkspaceApi(client: TeamAwareWorkspaceApi): TeamWorkspaceApi | undefined {
  const {
    listTeams,
    createTeam,
    listTeamMembers,
    addTeamMember,
    changeTeamMemberRole,
    removeTeamMember,
    dissolveTeam,
    getTeamPersonalization,
    updateTeamPersonalization,
  } = client;
  if (
    listTeams === undefined ||
    createTeam === undefined ||
    listTeamMembers === undefined ||
    addTeamMember === undefined ||
    changeTeamMemberRole === undefined ||
    removeTeamMember === undefined ||
    dissolveTeam === undefined
  ) {
    return undefined;
  }
  return {
    listTeams: listTeams.bind(client),
    createTeam: createTeam.bind(client),
    listTeamMembers: listTeamMembers.bind(client),
    addTeamMember: addTeamMember.bind(client),
    changeTeamMemberRole: changeTeamMemberRole.bind(client),
    removeTeamMember: removeTeamMember.bind(client),
    dissolveTeam: dissolveTeam.bind(client),
    ...(getTeamPersonalization === undefined
      ? {}
      : { getTeamPersonalization: getTeamPersonalization.bind(client) }),
    ...(updateTeamPersonalization === undefined
      ? {}
      : { updateTeamPersonalization: updateTeamPersonalization.bind(client) }),
  };
}

function resolvePersonalizationApi(client: TeamAwareWorkspaceApi): PersonalizationApi | undefined {
  const { getPersonalPersonalization, updatePersonalPersonalization } = client;
  if (getPersonalPersonalization === undefined || updatePersonalPersonalization === undefined) {
    return undefined;
  }
  return {
    getPersonalPersonalization: getPersonalPersonalization.bind(client),
    updatePersonalPersonalization: updatePersonalPersonalization.bind(client),
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

function AuthenticatedWorkspace({
  apiClient,
  accountProfile,
  onSignOut,
}: {
  readonly apiClient: TeamAwareWorkspaceApi;
  readonly accountProfile: AccountProfile;
  readonly onSignOut: () => void;
}) {
  const initialCompact = window.matchMedia(compactWorkspaceMedia).matches;
  const [state, dispatch] = useReducer(workspaceReducer, initialWorkspaceState);
  const [uploadFiles, setUploadFiles] = useState<readonly File[]>([]);
  const [historyFiles, setHistoryFiles] = useState<readonly HistoryFile[]>([]);
  const [pendingInputs, setPendingInputs] = useState<readonly PendingConversationInput[]>([]);
  const [continuity, setContinuity] =
    useState<Awaited<ReturnType<RuntimeApi["getThreadContinuity"]>>>();
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<ApiError | undefined>();
  const [textPreview, setTextPreview] = useState<ArtifactPreview | undefined>();
  const [filePreview, setFilePreview] = useState<PreviewTarget>();
  const [recoveryUi, setRecoveryUi] = useState<RecoveryUiState | undefined>();
  const [recoveryNonce, setRecoveryNonce] = useState(0);
  const [isCompact, setIsCompact] = useState(initialCompact);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [skillCenterOpen, setSkillCenterOpen] = useState(false);
  const [automationCenterOpen, setAutomationCenterOpen] = useState(false);
  const [cloudDriveOpen, setCloudDriveOpen] = useState(false);
  const [personalizationOpen, setPersonalizationOpen] = useState(false);
  const [teams, setTeams] = useState<readonly TeamSummary[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [activeTeamId, setActiveTeamId] = useState<string>();
  const { input, setInput, moveInputTo, clearSentInput, draftPersistenceFailed } =
    useConversationDraft(accountProfile.id, activeTeamId, state.selectedThreadId);
  const referenceDraft = useFileReferenceDraft(
    accountProfile.id,
    activeTeamId,
    state.selectedThreadId,
  );
  const snapshotUploads = useRef(new Map<string, UploadedResource>());
  const readPreviewContent = useMemo(
    () => apiClient.readArtifactContent?.bind(apiClient),
    [apiClient],
  );
  const previewContext = useMemo(
    () => ({
      open(source: FileSource, selection?: FileSelection) {
        setFilePreview({ source, ...(selection === undefined ? {} : { selection }) });
      },
    }),
    [],
  );
  const { ask, dialog } = useActionDialog();
  const [selectedTeamId, setSelectedTeamId] = useState<string>();
  const [personalThreads, setPersonalThreads] = useState<readonly Thread[]>([]);
  const [teamThreads, setTeamThreads] = useState<readonly Thread[]>([]);
  const [availableAgents, setAvailableAgents] = useState<readonly AvailableAgent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("agent_default");
  const [personalThreadsLoading, setPersonalThreadsLoading] = useState(false);
  const [teamThreadsLoading, setTeamThreadsLoading] = useState(false);
  const [cloudTeamId, setCloudTeamId] = useState<string>();
  const [teamCenterOpen, setTeamCenterOpen] = useState(false);
  const [teamManagementOpen, setTeamManagementOpen] = useState(false);
  const eventAfterRef = useRef(-1);
  const eventAttemptRef = useRef<string | undefined>(undefined);
  const currentRunPollRef = useRef(new CurrentRunPoll());
  const runExecutionStatusRef = useRef<Run["executionStatus"]>(undefined);
  const navigationRef = useRef(new WorkspaceNavigation());
  const mobileNavigationToggleRef = useRef<HTMLButtonElement>(null);
  const runAreaRef = useRef<HTMLElement>(null);
  const runContentRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const followedThreadRef = useRef<string | undefined>(undefined);
  const sendInFlightRef = useRef(false);
  const uploadIdempotencyKeysRef = useRef(new WeakMap<File, string>());
  const initialSelectionAppliedRef = useRef(false);
  runExecutionStatusRef.current = state.run?.executionStatus;
  const skillCenterApi = useMemo(() => resolveSkillCenterApi(apiClient), [apiClient]);
  const automationCenterApi = useMemo(() => resolveAutomationCenterApi(apiClient), [apiClient]);
  const cloudDriveApi = useMemo(() => resolveCloudDriveApi(apiClient), [apiClient]);
  const teamWorkspaceApi = useMemo(() => resolveTeamWorkspaceApi(apiClient), [apiClient]);
  const personalizationApi = useMemo(() => resolvePersonalizationApi(apiClient), [apiClient]);
  const attachmentPreviewLoader = useMemo(
    () => apiClient.previewHistoryFile?.bind(apiClient),
    [apiClient],
  );
  const activeTeam = teams.find((team) => team.id === activeTeamId);
  const selectedTeam = teams.find((team) => team.id === selectedTeamId) ?? teams[0];
  const visiblePersonalThreads = personalThreads.filter((thread) => thread.status === "active");
  const managedTeam = teams.find((team) => team.id === selectedTeamId);
  const personalCloudDriveApi = useMemo<CloudDriveApi | undefined>(() => {
    if (
      apiClient.listHistoryFilesForTenant !== undefined &&
      apiClient.downloadHistoryFileForTenant !== undefined
    ) {
      return {
        listHistoryFiles: (options) =>
          apiClient.listHistoryFilesForTenant?.(undefined, options) as ReturnType<
            CloudDriveApi["listHistoryFiles"]
          >,
        downloadHistoryFile: (file) =>
          apiClient.downloadHistoryFileForTenant?.(undefined, file) as Promise<string>,
      };
    }
    return activeTeamId === undefined ? cloudDriveApi : undefined;
  }, [activeTeamId, apiClient, cloudDriveApi]);
  const teamCloudDriveSources = useMemo(() => {
    if (
      apiClient.listHistoryFilesForTenant === undefined ||
      apiClient.downloadHistoryFileForTenant === undefined
    ) {
      return [];
    }
    return teams.map((team) => ({
      id: team.id,
      name: team.displayName,
      selectable: activeTeamId === undefined || activeTeamId === team.id,
      api: {
        listHistoryFiles: (options: Parameters<CloudDriveApi["listHistoryFiles"]>[0]) =>
          apiClient.listHistoryFilesForTenant?.(team.id, options) as ReturnType<
            CloudDriveApi["listHistoryFiles"]
          >,
        downloadHistoryFile: (file: Parameters<CloudDriveApi["downloadHistoryFile"]>[0]) =>
          apiClient.downloadHistoryFileForTenant?.(team.id, file) as Promise<string>,
      },
    }));
  }, [activeTeamId, apiClient, teams]);

  const selectThread = useCallback((threadId: string | undefined) => {
    navigationRef.current.navigate(threadId);
    currentRunPollRef.current.invalidate();
    dispatch({ type: "select", threadId });
    setPendingInputs([]);
    setHistoryFiles([]);
    setFilePreview(undefined);
    snapshotUploads.current.clear();
    setError(undefined);
    setNavigationOpen(false);
  }, []);

  const switchWorkspace = useCallback(
    (teamId: string | undefined, threadId?: string) => {
      apiClient.setTenantId?.(teamId);
      setActiveTeamId(teamId);
      if (teamId !== undefined) setCloudTeamId(teamId);
      // 同一空间内新建空会话只清除选择，不清空已加载的导航投影；否则重复点击会让团队任务永久消失。
      if (activeTeamId !== teamId) dispatch({ type: "threads", threads: [] });
      // 用户显式进入新会话时必须保持空白，不能被刷新逻辑自动选回已有任务。
      initialSelectionAppliedRef.current = true;
      selectThread(threadId);
    },
    [activeTeamId, apiClient, selectThread],
  );

  const selectWorkspaceThread = useCallback(
    (teamId: string | undefined, threadId: string) => {
      if (activeTeamId === teamId) selectThread(threadId);
      else switchWorkspace(teamId, threadId);
    },
    [activeTeamId, selectThread, switchWorkspace],
  );

  useEffect(() => {
    const media = window.matchMedia(compactWorkspaceMedia);
    const updateLayout = (event: MediaQueryListEvent) => {
      setIsCompact(event.matches);
      if (event.matches) setNavigationOpen(false);
    };
    media.addEventListener("change", updateLayout);
    return () => media.removeEventListener("change", updateLayout);
  }, []);

  const refreshTeams = useCallback(async () => {
    if (teamWorkspaceApi === undefined) return;
    setTeamsLoading(true);
    try {
      const items = await teamWorkspaceApi.listTeams();
      setTeams(items);
      // 团队目录属于个人身份；退出、解散或测试库重建后，旧活动 Tenant 必须立即失效，
      // 否则后续全局请求会继续携带不可恢复的 X-Tenant-ID。
      if (activeTeamId !== undefined && !items.some((team) => team.id === activeTeamId)) {
        apiClient.setTenantId?.(undefined);
        setActiveTeamId(undefined);
      }
      setSelectedTeamId((current) =>
        current !== undefined && items.some((team) => team.id === current) ? current : items[0]?.id,
      );
      setCloudTeamId((current) =>
        current !== undefined && items.some((team) => team.id === current) ? current : items[0]?.id,
      );
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason : new ApiError("加载团队失败", 0, true));
    } finally {
      setTeamsLoading(false);
    }
  }, [activeTeamId, apiClient, teamWorkspaceApi]);

  useEffect(() => {
    void refreshTeams();
  }, [refreshTeams]);

  useEffect(() => {
    if (apiClient.listThreadsForTenant === undefined) return;
    let stopped = false;
    setPersonalThreadsLoading(true);
    void apiClient
      .listThreadsForTenant(undefined)
      .then((threads) => {
        if (!stopped) setPersonalThreads(threads);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stopped) setPersonalThreadsLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [apiClient]);

  useEffect(() => {
    if (apiClient.listThreadsForTenant === undefined || selectedTeam === undefined) {
      setTeamThreads([]);
      setTeamThreadsLoading(false);
      return;
    }
    let stopped = false;
    setTeamThreadsLoading(true);
    void apiClient
      .listThreadsForTenant(selectedTeam.id)
      .then((threads) => {
        if (!stopped) setTeamThreads(threads);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stopped) setTeamThreadsLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [apiClient, selectedTeam]);

  useEffect(() => {
    if (apiClient.listAvailableAgents === undefined) return;
    let stopped = false;
    void apiClient
      .listAvailableAgents(activeTeamId)
      .then((agents) => {
        if (stopped) return;
        setAvailableAgents(agents);
        setSelectedAgentId((current) =>
          agents.some((agent) => agent.id === current)
            ? current
            : (agents.find((agent) => agent.id === "agent_default")?.id ??
              agents[0]?.id ??
              "agent_default"),
        );
      })
      .catch(() => {
        if (!stopped) setAvailableAgents([]);
      });
    return () => {
      stopped = true;
    };
  }, [activeTeamId, apiClient]);

  useEffect(() => {
    eventAfterRef.current = state.events.at(-1)?.sequence ?? -1;
    eventAttemptRef.current = state.eventAttemptId;
  }, [state.eventAttemptId, state.events]);

  const refreshThreads = useCallback(async () => {
    const requestedTeamId = activeTeamId;
    const expectedNavigation = navigationRef.current.capture();
    setLoading(true);
    try {
      const threads =
        apiClient.listThreadsForTenant === undefined
          ? await apiClient.listThreads()
          : await apiClient.listThreadsForTenant(requestedTeamId);
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
  }, [activeTeamId, apiClient, selectThread]);

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  useEffect(() => {
    if (activeTeamId === undefined) {
      setPersonalThreads(state.threads);
    } else if (activeTeamId === selectedTeam?.id) {
      setTeamThreads(state.threads);
    }
  }, [activeTeamId, selectedTeam?.id, state.threads]);

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
    if (threadId === undefined || pollingRunStatuses.has(state.run?.status ?? "succeeded")) return;
    const expectedNavigation = navigationRef.current.capture();
    let stopped = false;
    let timer: number | undefined;
    const discoverExternalRun = async () => {
      try {
        if (document.visibilityState !== "hidden") {
          const [latest] = await apiClient.listLatestRuns(threadId, 1);
          if (
            !stopped &&
            navigationRef.current.isCurrent(expectedNavigation) &&
            latest !== undefined &&
            latest.id !== state.run?.id
          ) {
            eventAfterRef.current = -1;
            eventAttemptRef.current = undefined;
            dispatch({ type: "startRun", run: latest });
            return;
          }
        }
      } catch {
        // 外部 Run 发现是后台增强；短暂失败不能覆盖当前对话或打断用户输入。
      }
      if (!stopped) timer = window.setTimeout(() => void discoverExternalRun(), 2_500);
    };
    timer = window.setTimeout(() => void discoverExternalRun(), 2_500);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [apiClient, state.run?.id, state.run?.status, state.selectedThreadId]);

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
    const outputController = new AbortController();
    let outputSettled = apiClient.streamEvents === undefined;
    let polling = false;
    let refreshRequested = false;
    const poll = async (): Promise<void> => {
      if (!currentRunPollRef.current.isCurrent(pollGeneration)) return;
      if (timer !== undefined) window.clearTimeout(timer);
      if (polling) {
        refreshRequested = true;
        return;
      }
      polling = true;
      let recoveryRequired = runExecutionStatusRef.current === "recovery_required";
      try {
        const latest = await apiClient.getRun(threadId, runId);
        recoveryRequired = latest.executionStatus === "recovery_required";
        const [eventPage, artifacts, threadContext, continuityStatus, threadSnapshot] =
          await Promise.all([
            apiClient.streamEvents === undefined
              ? drainEventPages(
                  (after, limit) => apiClient.listEvents(threadId, runId, after, limit),
                  eventAfterRef.current,
                  eventAttemptRef.current,
                )
              : Promise.resolve(undefined),
            apiClient.listArtifacts(threadId, runId),
            apiClient.listThreadContext?.(threadId).catch(() => undefined) ??
              Promise.resolve(undefined),
            apiClient.getThreadContinuity?.(threadId).catch(() => undefined) ??
              Promise.resolve(undefined),
            apiClient.getThread?.(threadId).catch(() => undefined) ?? Promise.resolve(undefined),
          ]);
        if (!stopped && currentRunPollRef.current.isCurrent(pollGeneration)) {
          if (eventPage !== undefined) {
            eventAttemptRef.current = eventPage.attemptId;
            eventAfterRef.current = eventPage.nextAfter;
            dispatch({ type: "events", page: eventPage });
          }
          dispatch({ type: "run", run: latest });
          if (threadSnapshot !== undefined) {
            dispatch({ type: "threadUpdated", thread: threadSnapshot });
          }
          dispatch({ type: "artifacts", artifacts });
          if (apiClient.listThreadContext !== undefined) {
            dispatch({ type: "threadContext", items: threadContext });
          }
          if (apiClient.getThreadContinuity !== undefined) setContinuity(continuityStatus);
          if (
            (apiClient.streamEvents === undefined ? !eventPage?.hasMore : outputSettled) &&
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
          if (
            !recoveryRequired &&
            shouldContinueRunPolling(
              eventPage?.hasMore ?? false,
              latest.status,
              continuityStatus?.sandboxState,
              latest.executionStatus,
            )
          ) {
            timer = window.setTimeout(
              () => void poll(),
              apiClient.streamEvents === undefined ? 1200 : 5_000,
            );
          }
        }
      } catch (reason) {
        if (!stopped && currentRunPollRef.current.isCurrent(pollGeneration)) {
          setError(reason instanceof ApiError ? reason : new ApiError("轮询运行状态失败", 0, true));
          if (!recoveryRequired) timer = window.setTimeout(() => void poll(), 1200);
        }
      } finally {
        polling = false;
        if (refreshRequested && !stopped) {
          refreshRequested = false;
          if (timer !== undefined) window.clearTimeout(timer);
          timer = window.setTimeout(() => void poll(), 0);
        }
      }
    };
    if (apiClient.streamEvents !== undefined) {
      let observedStatus: string | undefined;
      void followRunOutput({
        api: {
          streamEvents: apiClient.streamEvents.bind(apiClient),
          listEvents: apiClient.listEvents.bind(apiClient),
          getRun: apiClient.getRun.bind(apiClient),
        },
        threadId,
        runId,
        signal: outputController.signal,
        onPage: (page) => {
          if (stopped || !currentRunPollRef.current.isCurrent(pollGeneration)) return;
          if (eventAttemptRef.current !== page.attemptId) eventAfterRef.current = -1;
          eventAttemptRef.current = page.attemptId;
          eventAfterRef.current = page.items.at(-1)?.sequence ?? eventAfterRef.current;
          dispatch({ type: "events", page });
          if (
            page.items.some(
              (event) =>
                event.type === "message.completed" ||
                event.type === "tool.completed" ||
                event.type === "final_answer.committed",
            )
          )
            void poll();
        },
        onRun: (run) => {
          if (stopped || !currentRunPollRef.current.isCurrent(pollGeneration)) return;
          dispatch({ type: "run", run });
          const status = `${run.status}:${run.executionStatus ?? ""}`;
          if (observedStatus !== undefined && observedStatus !== status) void poll();
          observedStatus = status;
        },
        onSettled: () => {
          outputSettled = true;
          if (!stopped) void poll();
        },
        onError: (error) => {
          if (!stopped) setError(error);
        },
      });
    }
    void poll();
    return () => {
      stopped = true;
      outputController.abort();
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

  const createConversation = () => {
    if (activeTeamId !== undefined) switchWorkspace(undefined);
    else selectThread(undefined);
  };
  const createTeam = async (displayName: string) => {
    if (teamWorkspaceApi === undefined) return;
    apiClient.setTenantId?.(undefined);
    try {
      const team = await teamWorkspaceApi.createTeam(displayName);
      setTeams((current) => [...current.filter((item) => item.id !== team.id), team]);
      setSelectedTeamId(team.id);
      setCloudTeamId(team.id);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason : new ApiError("创建团队失败", 0, true));
      throw reason;
    } finally {
      apiClient.setTenantId?.(activeTeamId);
    }
  };
  const send = async (mode: "auto" | "follow_up" = "auto") => {
    if (
      (!input.trim() &&
        uploadFiles.length === 0 &&
        historyFiles.length === 0 &&
        referenceDraft.items.length === 0) ||
      actionLoading ||
      sendInFlightRef.current
    )
      return;
    sendInFlightRef.current = true;
    const expectedNavigation = navigationRef.current.capture();
    setActionLoading(true);
    try {
      const request = input.trim() || "请处理本轮提供的文件。";
      if (referenceDraft.items.length > 0 && apiClient.submitThreadInput === undefined)
        throw new ApiError("当前服务不支持文件引用，请更新服务后重试。", 422, false);
      const fileReferences: FileReference[] = [];
      const snapshotAttachments: UploadedResource[] = [];
      for (const draft of referenceDraft.items) {
        let snapshot = snapshotUploads.current.get(draft.id);
        if (draft.snapshotDataUrl && snapshot === undefined) {
          const encoded = draft.snapshotDataUrl.split(",")[1] ?? "";
          const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
          snapshot = await apiClient.uploadResource(
            new File([bytes], `引用区域-${draft.id}.png`, { type: "image/png" }),
            draft.id,
          );
          if (!navigationRef.current.isCurrent(expectedNavigation)) return;
          snapshotUploads.current.set(draft.id, snapshot);
        }
        if (snapshot) snapshotAttachments.push(snapshot);
        fileReferences.push({
          ...draft.reference,
          ...(snapshot
            ? { snapshot: { resourceId: snapshot.resourceId, versionId: snapshot.versionId } }
            : {}),
        });
      }
      const expectedUserOccurrence = nextExpectedUserOccurrence(
        state.threadContext ?? [],
        pendingInputs,
        appendFileReferences(request, fileReferences),
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
      const attachments = [...uploaded, ...historyFiles, ...snapshotAttachments];
      if (!navigationRef.current.isCurrent(expectedNavigation)) return;
      if (
        attachments.length +
          new Set(fileReferences.map((reference) => reference.source.versionId)).size >
        20
      )
        throw new ApiError("文件与引用合计超过 20 个附件，请减少后发送。", 400, false);
      let threadId = state.selectedThreadId;
      if (threadId === undefined) {
        const thread = await apiClient.createThread(deriveThreadTitle(request), selectedAgentId);
        dispatch({ type: "threadCreated", thread });
        if (!navigationRef.current.isCurrent(expectedNavigation)) return;
        moveInputTo(thread.id);
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
              attachments,
              ...(fileReferences.length === 0 ? [] : ([fileReferences] as const)),
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
          text: appendFileReferences(request, fileReferences),
          attachments,
          expectedUserOccurrence,
          disposition: receipt?.disposition ?? "queued",
          ...(receipt === undefined ? {} : { receipt }),
          ...(receipt?.queueSequence === undefined ? {} : { queueSequence: receipt.queueSequence }),
          ...(receipt?.rejectionCode === undefined ? {} : { rejectionCode: receipt.rejectionCode }),
        },
      ]);
      if (receipt?.disposition === "rejected") return;
      referenceDraft.setItems([]);
      snapshotUploads.current.clear();
      if (run === undefined || state.run?.status === "running") {
        clearSentInput(threadId);
        setUploadFiles([]);
        setHistoryFiles([]);
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
      clearSentInput(threadId);
      setUploadFiles([]);
      setHistoryFiles([]);
      setError(undefined);
    } catch (reason) {
      if (navigationRef.current.isCurrent(expectedNavigation)) setError(reason as ApiError);
    } finally {
      sendInFlightRef.current = false;
      setActionLoading(false);
    }
  };
  const renamePersonalTask = async (thread: Thread) => {
    const requestedTitle = await ask({
      title: "重命名个人任务",
      confirmLabel: "保存",
      field: { label: "任务名称", initialValue: thread.title },
    });
    if (requestedTitle === null) return;
    const title = requestedTitle.trim();
    if (title.length === 0) {
      setError(new ApiError("任务名称不能为空", 400, false));
      return;
    }
    const rename = apiClient.renamePersonalThreadForTenant;
    if (rename === undefined) return;
    setActionLoading(true);
    try {
      const renamed = await rename.call(apiClient, thread.id, title, undefined);
      setPersonalThreads((current) =>
        current.map((item) => (item.id === renamed.id ? renamed : item)),
      );
      if (activeTeamId === undefined) dispatch({ type: "threadUpdated", thread: renamed });
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason : new ApiError("重命名任务失败", 0, true));
    } finally {
      setActionLoading(false);
    }
  };

  const deletePersonalTask = async (thread: Thread) => {
    if (
      (await ask({
        title: "删除个人任务",
        description: `删除“${thread.title}”？任务将从个人任务列表移除。`,
        confirmLabel: "删除",
        danger: true,
      })) === null
    )
      return;
    const archiveForTenant = apiClient.archiveThreadForTenant;
    if (archiveForTenant === undefined) return;
    setActionLoading(true);
    try {
      await archiveForTenant.call(apiClient, thread.id, undefined);
      setPersonalThreads((current) => current.filter((item) => item.id !== thread.id));
      if (activeTeamId === undefined) {
        dispatch({ type: "threadArchived", threadId: thread.id });
        if (state.selectedThreadId === thread.id) selectThread(undefined);
      }
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason : new ApiError("删除任务失败", 0, true));
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
  const fork = async (targetTeamId?: string) => {
    if (state.selectedThreadId === undefined || apiClient.forkThread === undefined) return;
    const sourceThreadId = state.selectedThreadId;
    setActionLoading(true);
    try {
      const child = await apiClient.forkThread(sourceThreadId, targetTeamId);
      if (targetTeamId !== undefined && targetTeamId !== activeTeamId) {
        switchWorkspace(targetTeamId);
      }
      dispatch({ type: "threadCreated", thread: child });
      selectThread(child.id);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason : new ApiError("创建任务分支失败", 0, true));
    } finally {
      setActionLoading(false);
    }
  };
  const publishToTeam = async () => {
    if (teams.length === 0) {
      setError(new ApiError("请先创建或加入一个团队", 422, false));
      return;
    }
    const selectedId =
      teams.length === 1
        ? teams[0]?.id
        : await ask({
            title: "发布到团队",
            confirmLabel: "发布",
            field: {
              label: "目标团队",
              initialValue: teams[0]?.id ?? "",
              choices: teams.map((team) => ({ value: team.id, label: team.displayName })),
            },
          });
    const target = teams.find((team) => team.id === selectedId);
    if (target === undefined) return;
    void fork(target.id);
  };
  const selectPersonalCloudFile = useCallback(
    (file: HistoryFile) =>
      setHistoryFiles((current) =>
        current.some(
          (item) => item.resourceId === file.resourceId && item.versionId === file.versionId,
        ) || current.length + uploadFiles.length >= 20
          ? current
          : [...current, file],
      ),
    [uploadFiles.length],
  );
  const selectTeamCloudFile = useCallback(
    async (teamId: string, file: HistoryFile) => {
      if (activeTeamId === teamId) {
        setHistoryFiles((current) =>
          current.some(
            (item) => item.resourceId === file.resourceId && item.versionId === file.versionId,
          ) || current.length + uploadFiles.length >= 20
            ? current
            : [...current, file],
        );
        return;
      }
      if (activeTeamId !== undefined || apiClient.importTeamFile === undefined) return;
      setActionLoading(true);
      try {
        const imported = await apiClient.importTeamFile(teamId, file);
        const personalSnapshot: HistoryFile = {
          ...file,
          resourceId: imported.resourceId,
          versionId: imported.versionId,
          name: imported.name,
          path: imported.path,
          mediaType: imported.mediaType,
          sizeBytes: imported.sizeBytes,
        };
        setHistoryFiles((current) => [...current, personalSnapshot]);
      } catch (reason) {
        setError(reason instanceof ApiError ? reason : new ApiError("导入团队文件失败", 0, true));
      } finally {
        setActionLoading(false);
      }
    },
    [activeTeamId, apiClient, uploadFiles.length],
  );
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
    const artifact = state.artifacts.find((item) => item.id === artifactId);
    if (readPreviewContent && artifact?.resourceVersionId) {
      previewContext.open({
        threadId,
        runId,
        artifactId,
        versionId: artifact.resourceVersionId,
        name: artifact.name,
        ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
      });
      return;
    }
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
  const selectedAgentName = availableAgents.find(
    (agent) => agent.id === selected?.agentDefinitionId,
  )?.displayName;
  const currentRecovery =
    recoveryUi !== undefined &&
    recoveryUi.threadId === state.selectedThreadId &&
    recoveryUi.selectionGeneration === state.selectionGeneration
      ? recoveryUi
      : undefined;
  const visibleError = currentRecovery?.status === "error" ? currentRecovery.error : error;
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
    const bottom = Math.max(0, runArea.scrollHeight - runArea.clientHeight);
    if (followLatestRef.current && Math.abs(runArea.scrollTop - bottom) > 1)
      runArea.scrollTop = bottom;
  }, [renderedContentVersion, state.selectedThreadId]);
  useLayoutEffect(() => {
    if (state.selectedThreadId === undefined) return;
    const area = runAreaRef.current;
    const content = runContentRef.current;
    if (area === null || content === null || typeof ResizeObserver === "undefined") return;
    // 图片解码、折叠展开也可能改变高度，但不能把正在回看的用户拉回底部。
    const observer = new ResizeObserver(() => {
      const bottom = Math.max(0, area.scrollHeight - area.clientHeight);
      if (followLatestRef.current && Math.abs(area.scrollTop - bottom) > 1) area.scrollTop = bottom;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [state.selectedThreadId]);
  return (
    <FilePreviewContext.Provider value={previewContext}>
      <main
        className={`workspace ${navigationOpen ? "navigation-open" : ""} ${filePreview ? "has-file-preview" : ""}`}
      >
        {dialog}
        <NavigationSidebar
          isCompact={isCompact}
          isOpen={navigationOpen}
          returnFocusRef={mobileNavigationToggleRef}
          onClose={() => setNavigationOpen(false)}
        >
          <ThreadCreate actionLoading={actionLoading} onCreate={createConversation} />
          {personalizationApi !== undefined && (
            <button
              type="button"
              className="personalization-entry"
              onClick={() => {
                setPersonalizationOpen(true);
                setNavigationOpen(false);
              }}
            >
              <SlidersHorizontal size={17} />
              个性化
            </button>
          )}
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
              {activeTeam === undefined ? "技能中心" : "团队技能"}
            </button>
          )}
          {automationCenterApi !== undefined && (
            <button
              type="button"
              className="automation-entry"
              onClick={() => {
                setAutomationCenterOpen(true);
                setNavigationOpen(false);
              }}
            >
              <CalendarClock size={17} />
              定时任务
            </button>
          )}
          {cloudDriveApi !== undefined && (
            <button
              type="button"
              className="cloud-drive-entry"
              onClick={() => {
                setCloudDriveOpen(true);
                setNavigationOpen(false);
              }}
            >
              <Cloud size={17} />
              云盘
            </button>
          )}
          {teamWorkspaceApi !== undefined && teams.length > 0 && (
            <TeamSwitcher
              teams={teams}
              {...(selectedTeam === undefined ? {} : { selectedTeamId: selectedTeam.id })}
              loading={teamsLoading}
              onSwitch={(teamId) => {
                setSelectedTeamId(teamId);
                setCloudTeamId(teamId);
              }}
              onNewTeamThread={() => {
                if (selectedTeam !== undefined) switchWorkspace(selectedTeam.id);
              }}
              onOpenTeamCenter={() => setTeamCenterOpen(true)}
              taskCount={teamThreads.length}
            >
              <ThreadNavigation ariaLabel="团队任务列表">
                {teamThreadsLoading ? (
                  <div className="empty compact">
                    <LoaderCircle className="spin" size={18} />
                    正在加载团队任务
                  </div>
                ) : teamThreads.length === 0 ? (
                  <div className="empty compact">还没有团队任务。</div>
                ) : (
                  teamThreads.map((thread) => (
                    <button
                      type="button"
                      className={
                        activeTeamId === selectedTeam?.id && thread.id === state.selectedThreadId
                          ? "thread selected"
                          : "thread"
                      }
                      key={thread.id}
                      onClick={() => selectWorkspaceThread(selectedTeam?.id, thread.id)}
                      aria-label={`${thread.title}${thread.status === "archived" ? "，已归档" : ""}`}
                    >
                      <span title={thread.title}>{compactThreadTitle(thread.title)}</span>
                      {availableAgents.find((agent) => agent.id === thread.agentDefinitionId) && (
                        <small>
                          {
                            availableAgents.find((agent) => agent.id === thread.agentDefinitionId)
                              ?.displayName
                          }
                        </small>
                      )}
                      {thread.status === "archived" && <small>已归档</small>}
                    </button>
                  ))
                )}
              </ThreadNavigation>
            </TeamSwitcher>
          )}
          <div className="thread-heading">
            <span>个人任务</span>
            <span>{visiblePersonalThreads.length}</span>
          </div>
          <ThreadNavigation ariaLabel="个人任务列表">
            {personalThreadsLoading || (activeTeamId === undefined && loading) ? (
              <div className="empty compact">
                <LoaderCircle className="spin" size={18} />
                正在加载会话
              </div>
            ) : visiblePersonalThreads.length === 0 ? (
              <div className="empty compact">创建第一个会话以开始工作。</div>
            ) : (
              visiblePersonalThreads.map((thread) => (
                <div className="personal-thread-row" key={thread.id}>
                  <button
                    type="button"
                    className={
                      activeTeamId === undefined && thread.id === state.selectedThreadId
                        ? "thread selected"
                        : "thread"
                    }
                    onClick={() => selectWorkspaceThread(undefined, thread.id)}
                    aria-label={thread.title}
                  >
                    <span title={thread.title}>{compactThreadTitle(thread.title)}</span>
                    {availableAgents.find((agent) => agent.id === thread.agentDefinitionId) && (
                      <small>
                        {
                          availableAgents.find((agent) => agent.id === thread.agentDefinitionId)
                            ?.displayName
                        }
                      </small>
                    )}
                  </button>
                  {apiClient.renamePersonalThreadForTenant !== undefined &&
                    apiClient.archiveThreadForTenant !== undefined && (
                      <div className="personal-thread-actions">
                        <button
                          type="button"
                          title="重命名任务"
                          aria-label={`重命名个人任务“${thread.title}”`}
                          disabled={actionLoading}
                          onClick={() => void renamePersonalTask(thread)}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          className="danger"
                          title="删除任务"
                          aria-label={`删除个人任务“${thread.title}”`}
                          disabled={actionLoading}
                          onClick={() => void deletePersonalTask(thread)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    )}
                </div>
              ))
            )}
          </ThreadNavigation>
          <AccountMenu
            profile={accountProfile}
            {...(selectedTeam === undefined ? {} : { activeTeamName: selectedTeam.displayName })}
            canManageActiveTeam={
              selectedTeam !== undefined &&
              (selectedTeam.role === "owner" || selectedTeam.role === "admin")
            }
            {...(teamWorkspaceApi === undefined
              ? {}
              : {
                  onOpenTeamCenter: () => {
                    setTeamCenterOpen(true);
                    if (isCompact) setNavigationOpen(false);
                  },
                  ...(selectedTeam === undefined
                    ? {}
                    : {
                        onOpenTeamManagement: () => {
                          setTeamManagementOpen(true);
                          if (isCompact) setNavigationOpen(false);
                        },
                      }),
                })}
            onSignOut={onSignOut}
          />
        </NavigationSidebar>
        <section className="content" aria-label="对话工作区">
          <button
            ref={mobileNavigationToggleRef}
            className="mobile-nav-toggle icon-button"
            type="button"
            onClick={() => setNavigationOpen(true)}
            aria-label="打开会话导航"
            hidden={navigationOpen}
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
              <img className="welcome-logo" src={HOOX_HORIZONTAL_PATH} alt="" aria-hidden="true" />
              <h1>准备好协作了吗？</h1>
              <p>描述任务后会自动创建会话，并用首条请求作为标题。</p>
              <NewThreadAgentWelcome
                agents={availableAgents}
                selectedAgentId={selectedAgentId}
                onSelect={setSelectedAgentId}
                onSuggestedQuestion={setInput}
              />
            </div>
          ) : (
            <>
              <ThreadHeader
                thread={selected}
                {...(selectedAgentName === undefined ? {} : { agentName: selectedAgentName })}
                run={state.run}
                {...(continuity === undefined ? {} : { continuity })}
                actionLoading={actionLoading}
                onArchive={() => void archive()}
                onCancel={() => void cancel()}
                {...(apiClient.forkThread === undefined
                  ? {}
                  : activeTeam === undefined
                    ? teams.length > 0
                      ? { onPublishToTeam: publishToTeam }
                      : {}
                    : { onFork: () => void fork() })}
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
                <div ref={runContentRef} className="run-content">
                  <ThreadTranscript
                    messages={state.threadContext ?? []}
                    pendingInputs={visiblePendingInputs}
                    loadRunEvents={(runId) =>
                      loadAllRunEvents((after, limit) =>
                        apiClient.listEvents(selected.id, runId, after, limit),
                      )
                    }
                    {...(attachmentPreviewLoader === undefined
                      ? {}
                      : { loadAttachmentUrl: attachmentPreviewLoader })}
                    {...(state.run === undefined
                      ? {}
                      : { currentRun: state.run, currentRunEvents: state.events })}
                  />
                  {state.run ? (
                    <InlineArtifactDelivery
                      artifacts={state.artifacts}
                      onPreview={(artifactId) => void preview(artifactId)}
                      onDownload={(artifactId) => void download(artifactId)}
                    />
                  ) : currentRecovery?.status === "loading" ? (
                    <RunRecoveryLoading />
                  ) : (
                    <EmptyConversation />
                  )}
                </div>
              </section>
              {state.run && (
                <div className="run-progress-dock">
                  <RunTimeline run={state.run} events={state.events} />
                </div>
              )}
            </>
          )}
          {(draftPersistenceFailed || referenceDraft.persistenceFailed) && (
            <p role="alert">浏览器无法保存草稿，请在刷新前发送或备份未发送的文字和引用。</p>
          )}
          <ConversationComposer
            references={
              <DraftFileReferences
                items={referenceDraft.items}
                disabled={actionLoading}
                onRemove={(id) =>
                  referenceDraft.setItems(referenceDraft.items.filter((item) => item.id !== id))
                }
              />
            }
            referenceCount={referenceDraft.items.length}
            input={input}
            files={uploadFiles}
            selectedHistoryFiles={historyFiles}
            onHistoryFilesChange={setHistoryFiles}
            {...(apiClient.listHistoryFiles === undefined
              ? {}
              : {
                  historyFileApi: {
                    listHistoryFiles: apiClient.listHistoryFiles.bind(apiClient),
                    ...(attachmentPreviewLoader === undefined
                      ? {}
                      : { previewHistoryFile: attachmentPreviewLoader }),
                  },
                })}
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
        {filePreview && readPreviewContent && (
          <FilePreviewPanel
            key={`${activeTeamId ?? "personal"}:${filePreview.source.artifactId}:${JSON.stringify(filePreview.selection)}`}
            target={filePreview}
            readContent={readPreviewContent}
            disabled={actionLoading || referenceDraft.items.length >= MAX_FILE_REFERENCES}
            onClose={() => setFilePreview(undefined)}
            onDownload={() =>
              void openArtifact(
                () =>
                  apiClient.downloadArtifact(
                    filePreview.source.threadId,
                    filePreview.source.runId,
                    filePreview.source.artifactId,
                  ),
                "下载文件失败",
              )
            }
            onReference={(reference) => {
              if (referenceDraft.items.length >= MAX_FILE_REFERENCES) return;
              referenceDraft.setItems([...referenceDraft.items, reference]);
            }}
            reply={
              <details>
                <summary>填写修改要求 · {referenceDraft.items.length} 处引用</summary>
                <DraftFileReferences
                  items={referenceDraft.items}
                  disabled={actionLoading}
                  onRemove={(id) =>
                    referenceDraft.setItems(referenceDraft.items.filter((item) => item.id !== id))
                  }
                />
                <textarea
                  aria-label="预览中的修改要求"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="说明希望如何修改所选内容…"
                  disabled={actionLoading}
                />
                <button
                  type="button"
                  disabled={actionLoading || (!input.trim() && referenceDraft.items.length === 0)}
                  onClick={() => void send()}
                >
                  发送修改要求
                </button>
              </details>
            }
          />
        )}
        {textPreview?.kind === "text" && (
          <dialog className="artifact-text-preview" open aria-label="纯文本交付物预览">
            <header>
              <strong>交付物预览</strong>
              <button
                type="button"
                className="icon-button"
                onClick={() => setTextPreview(undefined)}
              >
                关闭
              </button>
            </header>
            <pre>{textPreview.text}</pre>
          </dialog>
        )}
        {skillCenterOpen && skillCenterApi !== undefined && (
          <SkillCenterDialog
            api={skillCenterApi}
            {...(activeTeam === undefined
              ? {}
              : { scopeName: activeTeam.displayName, readOnly: activeTeam.role === "member" })}
            onClose={() => setSkillCenterOpen(false)}
          />
        )}
        {automationCenterOpen && automationCenterApi !== undefined && (
          <AutomationCenterDialog
            api={automationCenterApi}
            threads={state.threads}
            {...(state.selectedThreadId === undefined
              ? {}
              : { initialThreadId: state.selectedThreadId })}
            onClose={() => setAutomationCenterOpen(false)}
          />
        )}
        {personalizationOpen && personalizationApi !== undefined && (
          <PersonalizationDialog
            api={personalizationApi}
            hasTeams={teams.length > 0}
            onClose={() => setPersonalizationOpen(false)}
          />
        )}
        {cloudDriveOpen && personalCloudDriveApi !== undefined && (
          <CloudDriveDialog
            api={personalCloudDriveApi}
            selectedFiles={historyFiles}
            {...(activeTeamId === undefined
              ? {
                  onSelectFile: selectPersonalCloudFile,
                }
              : {})}
            teams={teamCloudDriveSources}
            {...(cloudTeamId === undefined ? {} : { selectedTeamId: cloudTeamId })}
            onSwitchTeam={setCloudTeamId}
            onSelectTeamFile={selectTeamCloudFile}
            onClose={() => setCloudDriveOpen(false)}
          />
        )}
        {teamCenterOpen && teamWorkspaceApi !== undefined && (
          <TeamCenterDialog
            userId={accountProfile.id}
            teams={teams}
            {...(selectedTeam === undefined ? {} : { selectedTeamId: selectedTeam.id })}
            loading={teamsLoading}
            onSelectTeam={(teamId) => {
              setSelectedTeamId(teamId);
              setCloudTeamId(teamId);
            }}
            onCreate={createTeam}
            onRefresh={refreshTeams}
            onManage={(teamId) => {
              setSelectedTeamId(teamId);
              setTeamCenterOpen(false);
              setTeamManagementOpen(true);
            }}
            onClose={() => setTeamCenterOpen(false)}
          />
        )}
        {teamManagementOpen && managedTeam !== undefined && teamWorkspaceApi !== undefined && (
          <TeamManagementDialog
            api={teamWorkspaceApi}
            team={managedTeam}
            onDissolved={() => {
              setTeamManagementOpen(false);
              setTeams((current) => {
                const remaining = current.filter((team) => team.id !== managedTeam.id);
                setSelectedTeamId(remaining[0]?.id);
                return remaining;
              });
              if (activeTeamId === managedTeam.id) switchWorkspace(undefined);
            }}
            onClose={() => setTeamManagementOpen(false)}
          />
        )}
      </main>
    </FilePreviewContext.Provider>
  );
}

export function App({ apiClient = api }: { readonly apiClient?: TeamAwareWorkspaceApi }) {
  const [accountSession, setAccountSession] = useState<AccountSession | undefined>(() =>
    readAccountSession(window.localStorage),
  );
  const [identityRecoveryPending, setIdentityRecoveryPending] = useState(
    accountSession === undefined && apiClient.exchangeIdentitySession !== undefined,
  );
  useEffect(() => {
    if (accountSession !== undefined || apiClient.exchangeIdentitySession === undefined) {
      setIdentityRecoveryPending(false);
      return;
    }
    let active = true;
    void apiClient
      .exchangeIdentitySession()
      .then((session) => {
        if (active) {
          persistAccountSession(window.localStorage, session);
          setAccountSession(session);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setIdentityRecoveryPending(false);
      });
    return () => {
      active = false;
    };
  }, [accountSession, apiClient]);
  useLayoutEffect(() => {
    apiClient.setAccessToken?.(accountSession?.accessToken);
  }, [accountSession?.accessToken, apiClient]);

  if (accountSession === undefined && identityRecoveryPending) {
    return (
      <main className="account-access-shell">
        <p className="empty-state large">正在恢复登录状态…</p>
      </main>
    );
  }

  if (accountSession === undefined) {
    return (
      <AccountAccess
        api={{
          ...(apiClient.getIdentityConfiguration === undefined
            ? {}
            : { getIdentityConfiguration: apiClient.getIdentityConfiguration.bind(apiClient) }),
          ...(apiClient.signUpWithEmail === undefined
            ? {}
            : { signUpWithEmail: apiClient.signUpWithEmail.bind(apiClient) }),
          ...(apiClient.signInWithEmail === undefined
            ? {}
            : { signInWithEmail: apiClient.signInWithEmail.bind(apiClient) }),
          ...(apiClient.resendEmailVerificationOtp === undefined
            ? {}
            : {
                resendEmailVerificationOtp: apiClient.resendEmailVerificationOtp.bind(apiClient),
              }),
          ...(apiClient.verifyEmailOtp === undefined
            ? {}
            : { verifyEmailOtp: apiClient.verifyEmailOtp.bind(apiClient) }),
          ...(apiClient.beginSocialSignIn === undefined
            ? {}
            : { beginSocialSignIn: apiClient.beginSocialSignIn.bind(apiClient) }),
          ...(apiClient.sendPhoneOtp === undefined
            ? {}
            : { sendPhoneOtp: apiClient.sendPhoneOtp.bind(apiClient) }),
          ...(apiClient.verifyPhoneOtp === undefined
            ? {}
            : { verifyPhoneOtp: apiClient.verifyPhoneOtp.bind(apiClient) }),
          registerAccount: (input) => {
            if (apiClient.registerAccount === undefined) {
              return Promise.reject(new Error("ACCOUNT_API_UNAVAILABLE"));
            }
            return apiClient.registerAccount(input);
          },
          loginAccount: (input) => {
            if (apiClient.loginAccount === undefined) {
              return Promise.reject(new Error("ACCOUNT_API_UNAVAILABLE"));
            }
            return apiClient.loginAccount(input);
          },
        }}
        onAuthenticated={setAccountSession}
      />
    );
  }

  return (
    <AuthenticatedWorkspace
      apiClient={apiClient}
      accountProfile={accountSession.profile}
      onSignOut={() => {
        const logout = apiClient.logoutAccount?.();
        clearAccountSession(window.localStorage);
        clearAccountDrafts(accountSession.profile.id);
        apiClient.setAccessToken?.(undefined);
        setAccountSession(undefined);
        void logout?.catch(() => undefined);
      }}
    />
  );
}

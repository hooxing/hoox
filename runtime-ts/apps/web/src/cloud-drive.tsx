import { FileTypeIcon } from "./file-type-icon.js";
import { ChevronDown, ChevronRight, Download, LoaderCircle, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ApiError, type HistoryFile, type HistoryFilePage, type RuntimeApi } from "./api.js";
import { openResolvedUrl } from "./popup.js";
import { formatArtifactSize, formatArtifactType } from "./workspace-view.js";

export type CloudDriveApi = Pick<RuntimeApi, "listHistoryFiles" | "downloadHistoryFile">;

export type TeamCloudDriveSource = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly api: CloudDriveApi;
  readonly selectable?: boolean;
}>;

type CloudDriveSearchScope = "all" | "personal" | "teams" | `team:${string}`;

type CloudDriveSearchSource = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly api: CloudDriveApi;
  readonly onSelectFile?: (file: HistoryFile) => void;
}>;

export function CloudDriveDialog({
  api,
  teams = [],
  selectedTeamId,
  selectedFiles = [],
  onSelectFile,
  onSelectTeamFile,
  onSwitchTeam,
  onClose,
}: {
  readonly api: CloudDriveApi;
  readonly teams?: readonly TeamCloudDriveSource[];
  readonly selectedTeamId?: string;
  readonly selectedFiles?: readonly HistoryFile[];
  readonly onSelectFile?: (file: HistoryFile) => void;
  readonly onSelectTeamFile?: (teamId: string, file: HistoryFile) => void;
  readonly onSwitchTeam?: (teamId: string) => void;
  readonly onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"personal" | "team">("personal");
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [searchScope, setSearchScope] = useState<CloudDriveSearchScope>("all");
  const hasTeams = teams.length > 0;
  const selectedTeam = teams.find((team) => team.id === selectedTeamId) ?? teams[0];
  const searchSources = useMemo<readonly CloudDriveSearchSource[]>(
    () => [
      {
        id: "personal",
        name: "个人云盘",
        api,
        ...(onSelectFile === undefined ? {} : { onSelectFile }),
      },
      ...teams.map((team) => ({
        id: `team:${team.id}`,
        name: `${team.name}云盘`,
        api: team.api,
        ...(team.selectable !== true || onSelectTeamFile === undefined
          ? {}
          : { onSelectFile: (file: HistoryFile) => onSelectTeamFile(team.id, file) }),
      })),
    ],
    [api, onSelectFile, onSelectTeamFile, teams],
  );
  const scopedSearchSources = useMemo(() => {
    if (searchScope === "all") return searchSources;
    if (searchScope === "personal")
      return searchSources.filter((source) => source.id === "personal");
    if (searchScope === "teams") return searchSources.filter((source) => source.id !== "personal");
    return searchSources.filter((source) => source.id === searchScope);
  }, [searchScope, searchSources]);

  const selectTab = (tab: "personal" | "team") => {
    setActiveTab(tab);
    setQuery("");
    setSubmittedQuery("");
  };

  return (
    <div className="skill-center-backdrop">
      <section
        className="skill-center-dialog cloud-drive-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-drive-title"
      >
        <header className="skill-center-header">
          <div>
            <h2 id="cloud-drive-title">云盘</h2>
            <p>
              {hasTeams
                ? "统一搜索个人与团队文件，浏览时仍保持各空间的权限边界。"
                : "搜索和浏览个人云盘文件。"}
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭云盘">
            <X size={18} />
          </button>
        </header>
        <form
          className={`cloud-drive-global-search${hasTeams ? "" : " is-personal-only"}`}
          onSubmit={(event) => {
            event.preventDefault();
            setSubmittedQuery(query.trim());
          }}
        >
          <div className="cloud-drive-search-query">
            <Search size={17} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={hasTeams ? "搜索个人及团队文件" : "搜索个人文件"}
              aria-label={hasTeams ? "搜索个人及团队文件" : "搜索个人文件"}
            />
            <button type="submit">搜索</button>
          </div>
          {hasTeams && (
            <label className="cloud-drive-search-scope">
              <span>搜索范围</span>
              <select
                value={searchScope}
                aria-label="搜索范围"
                onChange={(event) => setSearchScope(event.target.value as CloudDriveSearchScope)}
              >
                <option value="all">全部空间</option>
                <option value="personal">仅个人云盘</option>
                <option value="teams">全部团队</option>
                {teams.map((team) => (
                  <option key={team.id} value={`team:${team.id}`}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </form>
        {hasTeams && (
          <div className="cloud-drive-tabs" role="tablist" aria-label="云盘空间">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "personal" && !submittedQuery}
              className={activeTab === "personal" && !submittedQuery ? "is-active" : undefined}
              onClick={() => selectTab("personal")}
            >
              个人云盘
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "team" && !submittedQuery}
              className={activeTab === "team" && !submittedQuery ? "is-active" : undefined}
              onClick={() => selectTab("team")}
            >
              团队云盘
            </button>
            {submittedQuery && <span>“{submittedQuery}”的搜索结果</span>}
          </div>
        )}
        <div className="cloud-drive-content">
          {submittedQuery ? (
            <CloudDriveSearchResults
              query={submittedQuery}
              sources={scopedSearchSources}
              selectedFiles={selectedFiles}
            />
          ) : activeTab === "personal" || selectedTeam === undefined ? (
            <CloudDrivePanel
              api={api}
              showSearch={false}
              ariaLabel="个人云盘历史文件"
              selectedFiles={selectedFiles}
              {...(onSelectFile === undefined ? {} : { onSelectFile })}
            />
          ) : (
            <section className="cloud-drive-team-view">
              <label className="cloud-drive-team-selector">
                <span>当前团队</span>
                <select
                  value={selectedTeam.id}
                  aria-label="选择团队"
                  onChange={(event) => onSwitchTeam?.(event.target.value)}
                >
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </label>
              <CloudDrivePanel
                api={selectedTeam.api}
                showSearch={false}
                ariaLabel={`${selectedTeam.name}云盘历史文件`}
                selectedFiles={selectedFiles}
                {...(selectedTeam.selectable !== true || onSelectTeamFile === undefined
                  ? {}
                  : {
                      onSelectFile: (file: HistoryFile) => onSelectTeamFile(selectedTeam.id, file),
                    })}
              />
            </section>
          )}
        </div>
      </section>
    </div>
  );
}

export function CloudDrivePanel({
  api,
  selectedFiles = [],
  onSelectFile,
  showSearch = true,
  ariaLabel = "云盘历史文件",
}: {
  readonly api: CloudDriveApi;
  readonly selectedFiles?: readonly HistoryFile[];
  readonly onSelectFile?: (file: HistoryFile) => void;
  readonly showSearch?: boolean;
  readonly ariaLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [page, setPage] = useState<HistoryFilePage>();
  const [tasks, setTasks] = useState<HistoryFilePage["items"]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(
    async (options: Parameters<CloudDriveApi["listHistoryFiles"]>[0], append: boolean) => {
      append ? setLoadingMore(true) : setLoading(true);
      setError(undefined);
      try {
        const incoming = await api.listHistoryFiles({ ...options, limit: 24 });
        setPage(incoming);
        setTasks((current) => (append ? mergeTasks(current, incoming.items) : incoming.items));
        if (!append) setExpanded(new Set(incoming.items.slice(0, 1).map((task) => task.threadId)));
      } catch (reason) {
        setError(reason instanceof ApiError ? reason.message : "历史文件暂时不可用");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void load({ query: submittedQuery }, false);
  }, [load, submittedQuery]);

  const groups = useMemo(() => groupTasksByMonth(tasks), [tasks]);
  const selected = useMemo(
    () => new Set(selectedFiles.map((file) => historyFileKey(file))),
    [selectedFiles],
  );

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setSubmittedQuery(query.trim());
  };

  const loadMore = () => {
    if (page?.next !== undefined) {
      void load(
        {
          query: submittedQuery,
          ...page.range,
          before: page.next,
        },
        true,
      );
      return;
    }
    if (page?.hasOlder && page.range.activeAfter !== undefined) {
      void load({ query: submittedQuery, activeBefore: page.range.activeAfter }, true);
    }
  };

  const canLoadMore =
    page?.next !== undefined || (page?.hasOlder && page.range.activeAfter !== undefined);

  return (
    <section className="cloud-drive-panel" aria-label={ariaLabel}>
      {showSearch && (
        <form className="skill-search cloud-drive-search" onSubmit={submitSearch}>
          <Search size={17} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索任务或文件"
            aria-label="搜索历史文件"
          />
          <button type="submit">搜索</button>
        </form>
      )}
      <div className="cloud-drive-summary">
        <span>
          {page?.range.activeBefore === undefined
            ? "默认显示最近六个月活跃任务"
            : "正在浏览更早任务"}
        </span>
        <span>{tasks.reduce((sum, task) => sum + task.files.length, 0)} 个文件</span>
      </div>
      {error !== undefined && (
        <div className="skill-center-error" role="alert">
          {error}
        </div>
      )}
      <div className="cloud-drive-list">
        {loading ? (
          <div className="skill-center-empty">
            <LoaderCircle className="spin" size={20} /> 正在加载历史文件
          </div>
        ) : tasks.length === 0 ? (
          <div className="skill-center-empty">
            {submittedQuery ? "没有匹配的历史文件" : "最近还没有可用文件"}
          </div>
        ) : (
          groups.map((group) => (
            <section className="cloud-drive-month" key={group.key}>
              <h3>{group.label}</h3>
              {group.tasks.map((task) => {
                const isExpanded = expanded.has(task.threadId);
                return (
                  <article className="cloud-task" key={task.threadId}>
                    <button
                      type="button"
                      className="cloud-task-header"
                      aria-expanded={isExpanded}
                      onClick={() => setExpanded(toggleSet(expanded, task.threadId))}
                    >
                      {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      <span>
                        <strong>{task.name}</strong>
                        <small>
                          {formatDate(task.lastFileAt)} · {task.fileCount} 个文件
                        </small>
                      </span>
                    </button>
                    {isExpanded && (
                      <ul className="cloud-file-list">
                        {task.files.map((file) => {
                          const isSelected = selected.has(historyFileKey(file));
                          return (
                            <li key={historyFileKey(file)}>
                              <FileTypeIcon name={file.entryName} mediaType={file.mediaType} />
                              <span className="cloud-file-meta">
                                <strong title={file.entryName}>{file.entryName}</strong>
                                <small>
                                  {formatArtifactType(file.mediaType, file.entryName)} ·{" "}
                                  {formatArtifactSize(file.sizeBytes)}
                                </small>
                              </span>
                              <button
                                type="button"
                                className="cloud-file-action"
                                aria-label={`下载 ${file.entryName}`}
                                onClick={() =>
                                  void openResolvedUrl(
                                    () => window.open("about:blank", "_blank"),
                                    () => api.downloadHistoryFile(file),
                                  ).catch(() => setError("下载历史文件失败"))
                                }
                              >
                                <Download size={15} />
                              </button>
                              {onSelectFile !== undefined && (
                                <button
                                  type="button"
                                  className="cloud-file-action is-primary"
                                  aria-label={`加入当前输入 ${file.entryName}`}
                                  disabled={isSelected}
                                  onClick={() => onSelectFile(file)}
                                >
                                  <Plus size={15} />
                                  {isSelected ? "已添加" : "添加"}
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </article>
                );
              })}
            </section>
          ))
        )}
      </div>
      {canLoadMore && (
        <button
          type="button"
          className="cloud-drive-more"
          disabled={loadingMore}
          onClick={loadMore}
        >
          {loadingMore ? "加载中…" : page?.next !== undefined ? "加载更多任务" : "加载更早任务"}
        </button>
      )}
    </section>
  );
}

function CloudDriveSearchResults({
  query,
  sources,
  selectedFiles,
}: {
  readonly query: string;
  readonly sources: readonly CloudDriveSearchSource[];
  readonly selectedFiles: readonly HistoryFile[];
}) {
  const [results, setResults] = useState<
    readonly Readonly<{
      readonly source: CloudDriveSearchSource;
      readonly page?: HistoryFilePage;
      readonly error?: string;
    }>[]
  >([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestVersionRef = useRef(0);
  const tasks = useMemo(
    () =>
      results
        .flatMap((result) =>
          (result.page?.items ?? []).map((task) => ({ source: result.source, task })),
        )
        .sort((left, right) => right.task.lastFileAt.localeCompare(left.task.lastFileAt)),
    [results],
  );
  const groups = useMemo(() => {
    const byMonth = new Map<string, typeof tasks>();
    for (const task of tasks) {
      const key = task.task.lastFileAt.slice(0, 7);
      byMonth.set(key, [...(byMonth.get(key) ?? []), task]);
    }
    return [...byMonth.entries()].map(([key, items]) => ({
      key,
      label: monthLabel(key),
      tasks: items,
    }));
  }, [tasks]);
  const selected = useMemo(
    () => new Set(selectedFiles.map((file) => historyFileKey(file))),
    [selectedFiles],
  );

  useEffect(() => {
    let stopped = false;
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    setLoadingMore(false);
    setResults([]);
    setExpanded(new Set());
    void Promise.all(
      sources.map(async (source) => {
        try {
          return {
            source,
            page: await source.api.listHistoryFiles({ query, limit: 24 }),
          };
        } catch (reason) {
          return {
            source,
            error: reason instanceof ApiError ? reason.message : "搜索暂时不可用",
          };
        }
      }),
    ).then((incoming) => {
      if (stopped || requestVersionRef.current !== requestVersion) return;
      setResults(incoming);
      setExpanded(
        new Set(
          incoming
            .flatMap((result) =>
              (result.page?.items ?? [])
                .slice(0, 1)
                .map((task) => `${result.source.id}:${task.threadId}`),
            )
            .slice(0, 3),
        ),
      );
      setLoading(false);
    });
    return () => {
      stopped = true;
    };
  }, [query, sources]);

  if (sources.length === 0) {
    return <div className="skill-center-empty">当前搜索范围没有可访问的空间。</div>;
  }
  const failed = results.filter((result) => result.error !== undefined);
  const fileCount = tasks.reduce((sum, item) => sum + item.task.files.length, 0);
  const canLoadMore = results.some(
    (result) =>
      result.page?.next !== undefined ||
      (result.page?.hasOlder === true && result.page.range.activeAfter !== undefined),
  );
  const loadMore = async () => {
    if (loadingMore) return;
    const requestVersion = requestVersionRef.current;
    setLoadingMore(true);
    const incoming = await Promise.all(
      results.map(async (result) => {
        const current = result.page;
        if (current === undefined) return result;
        const options =
          current.next !== undefined
            ? { query, ...current.range, before: current.next, limit: 24 }
            : current.hasOlder && current.range.activeAfter !== undefined
              ? { query, activeBefore: current.range.activeAfter, limit: 24 }
              : undefined;
        if (options === undefined) return result;
        try {
          const nextPage = await result.source.api.listHistoryFiles(options);
          return {
            source: result.source,
            page: {
              ...nextPage,
              items: mergeTasks(current.items, nextPage.items),
            },
          };
        } catch (reason) {
          return {
            ...result,
            error: reason instanceof ApiError ? reason.message : "加载更多结果失败",
          };
        }
      }),
    );
    if (requestVersionRef.current === requestVersion) {
      setResults(incoming);
      setLoadingMore(false);
    }
  };
  return (
    <section className="cloud-drive-search-results" aria-label="跨空间文件搜索结果">
      <div className="cloud-drive-search-summary">
        <span>已搜索 {sources.length} 个空间</span>
        <span>{fileCount} 个文件</span>
      </div>
      {failed.length > 0 && (
        <div className="skill-center-error" role="alert">
          {failed.map((result) => result.source.name).join("、")}搜索失败，其他空间结果仍可用。
        </div>
      )}
      <div className="cloud-drive-search-list">
        {loading ? (
          <div className="skill-center-empty">
            <LoaderCircle className="spin" size={20} /> 正在搜索文件
          </div>
        ) : tasks.length === 0 ? (
          <div className="skill-center-empty">所选范围内没有匹配的历史文件</div>
        ) : (
          groups.map((group) => (
            <section className="cloud-drive-month" key={group.key}>
              <h3>{group.label}</h3>
              {group.tasks.map(({ source, task }) => {
                const taskKey = `${source.id}:${task.threadId}`;
                const isExpanded = expanded.has(taskKey);
                return (
                  <article className="cloud-task" key={taskKey}>
                    <button
                      type="button"
                      className="cloud-task-header"
                      aria-expanded={isExpanded}
                      onClick={() => setExpanded(toggleSet(expanded, taskKey))}
                    >
                      {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      <span>
                        <strong>{task.name}</strong>
                        <small>
                          {source.name} · {formatDate(task.lastFileAt)} · {task.fileCount} 个文件
                        </small>
                      </span>
                    </button>
                    {isExpanded && (
                      <ul className="cloud-file-list">
                        {task.files.map((file) => {
                          const isSelected = selected.has(historyFileKey(file));
                          return (
                            <li key={`${source.id}:${historyFileKey(file)}`}>
                              <FileTypeIcon name={file.entryName} mediaType={file.mediaType} />
                              <span className="cloud-file-meta">
                                <strong title={file.entryName}>{file.entryName}</strong>
                                <small>
                                  {formatArtifactType(file.mediaType, file.entryName)} ·{" "}
                                  {formatArtifactSize(file.sizeBytes)}
                                </small>
                              </span>
                              <button
                                type="button"
                                className="cloud-file-action"
                                aria-label={`下载 ${source.name}中的${file.entryName}`}
                                onClick={() =>
                                  void openResolvedUrl(
                                    () => window.open("about:blank", "_blank"),
                                    () => source.api.downloadHistoryFile(file),
                                  )
                                }
                              >
                                <Download size={15} />
                              </button>
                              {source.onSelectFile !== undefined && (
                                <button
                                  type="button"
                                  className="cloud-file-action is-primary"
                                  aria-label={`加入当前输入 ${source.name}中的${file.entryName}`}
                                  disabled={isSelected}
                                  onClick={() => source.onSelectFile?.(file)}
                                >
                                  <Plus size={15} />
                                  {isSelected ? "已添加" : "添加"}
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </article>
                );
              })}
            </section>
          ))
        )}
      </div>
      {canLoadMore && (
        <button
          type="button"
          className="cloud-drive-more"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? "加载中…" : "加载更多搜索结果"}
        </button>
      )}
    </section>
  );
}

export function historyFileKey(file: Pick<HistoryFile, "resourceId" | "versionId">): string {
  return `${file.resourceId}\0${file.versionId}`;
}

function mergeTasks(
  current: HistoryFilePage["items"],
  incoming: HistoryFilePage["items"],
): HistoryFilePage["items"] {
  const byId = new Map(current.map((task) => [task.threadId, task]));
  for (const task of incoming) byId.set(task.threadId, task);
  return [...byId.values()].sort((left, right) => right.lastFileAt.localeCompare(left.lastFileAt));
}

function toggleSet(current: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(current);
  next.has(value) ? next.delete(value) : next.add(value);
  return next;
}

function groupTasksByMonth(tasks: HistoryFilePage["items"]) {
  const groups = new Map<string, HistoryFilePage["items"]>();
  for (const task of tasks) {
    const key = task.lastFileAt.slice(0, 7);
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return [...groups.entries()].map(([key, items]) => ({
    key,
    label: monthLabel(key),
    tasks: items,
  }));
}

function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  return `${year} 年 ${Number(month)} 月`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(
    new Date(value),
  );
}

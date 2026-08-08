import {
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  LoaderCircle,
  Plus,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, type HistoryFile, type HistoryFilePage, type RuntimeApi } from "./api.js";
import { openResolvedUrl } from "./popup.js";
import { formatArtifactSize, formatArtifactType } from "./workspace-view.js";

export type CloudDriveApi = Pick<RuntimeApi, "listHistoryFiles" | "downloadHistoryFile">;

export function CloudDriveDialog({
  api,
  selectedFiles = [],
  onSelectFile,
  onClose,
}: {
  readonly api: CloudDriveApi;
  readonly selectedFiles?: readonly HistoryFile[];
  readonly onSelectFile?: (file: HistoryFile) => void;
  readonly onClose: () => void;
}) {
  return (
    <div className="skill-center-backdrop">
      <section
        className="skill-center-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-drive-title"
      >
        <header className="skill-center-header">
          <div>
            <h2 id="cloud-drive-title">云盘</h2>
            <p>浏览并复用个人历史任务中的文件。</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭云盘">
            <X size={18} />
          </button>
        </header>
        <CloudDrivePanel
          api={api}
          selectedFiles={selectedFiles}
          {...(onSelectFile === undefined ? {} : { onSelectFile })}
        />
      </section>
    </div>
  );
}

export function CloudDrivePanel({
  api,
  selectedFiles = [],
  onSelectFile,
}: {
  readonly api: CloudDriveApi;
  readonly selectedFiles?: readonly HistoryFile[];
  readonly onSelectFile?: (file: HistoryFile) => void;
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
    <section className="cloud-drive-panel" aria-label="云盘历史文件">
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
                              <FileText size={17} aria-hidden="true" />
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

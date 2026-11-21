import {
  AppstoreOutlined,
  AuditOutlined,
  BarChartOutlined,
  BulbOutlined,
  DatabaseOutlined,
  HistoryOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import type {
  CreateSkillSubmissionRequest,
  SkillPublicationStatus,
  SkillSubmissionDto,
} from "@hoox/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MenuProps } from "antd";
import { App as AntApp, Button, ConfigProvider, Layout, Menu, Tag, Tooltip } from "antd";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  BrowserRouter,
  MemoryRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { AgentDefinitionsPage } from "./agent-definitions.js";
import { readAdminAccessToken } from "./admin-session.js";
import {
  AdminApiError,
  filesToRequests,
  resolvePackagePath,
  SkillAdminApi,
  type SkillAdminApiContract,
} from "./api.js";
import { HOOX_APP_ICON_PATH } from "./brand.js";
import {
  type AdminControlApiContract,
  AdminControlApi,
  type AgentDefinitionApiContract,
} from "./control-api.js";
import { AdminControlConsole } from "./control-console.js";
import { ExternalToolsPage } from "./external-tools.js";
import { InstallationProgress } from "./installation-progress.js";
import { RunExplorerDetail, RunExplorerList } from "./run-explorer.js";
import { RunExplorerApi, type RunExplorerApiContract } from "./run-explorer-api.js";
import { SandboxConfigurationPanel } from "./sandbox-configuration-panel.js";
import { extractSkillMetadataPrefill, SkillMetadataError } from "./skill-metadata.js";

const defaultApi = new SkillAdminApi();
const defaultRunApi = new RunExplorerApi();
const defaultManagementApi = new AdminControlApi();
const maxSubmissionFiles = 256;

export function browserRouterBasename(baseUrl: string): string | undefined {
  if (baseUrl === "/") return undefined;
  if (!baseUrl.startsWith("/") || !baseUrl.endsWith("/")) {
    throw new TypeError("后台管理 base URL 必须是以斜杠包围的绝对路径");
  }
  return baseUrl.slice(0, -1);
}

const statusLabels: Readonly<Record<SkillPublicationStatus, string>> = {
  draft: "待发布",
  submitted: "待发布",
  approved: "待发布",
  rejected: "已驳回",
  published: "已发布",
  revoked: "已下架",
};

type CreateFormState = Omit<CreateSkillSubmissionRequest, "files" | "version">;

const emptyCreateForm: CreateFormState = {
  canonicalKey: "",
  displayName: "",
  publisher: "",
  description: "",
  sourceUrl: "",
  sourceRevision: "",
  licenseSpdx: "",
};

function prepareCreateMetadata(form: CreateFormState): CreateFormState {
  const { compatibility, sourceUrl, sourceRevision, ...required } = form;
  const normalizedCompatibility = compatibility?.trim();
  const normalizedSourceUrl = sourceUrl?.trim();
  const normalizedSourceRevision = sourceRevision?.trim();
  return {
    ...required,
    ...(normalizedCompatibility === undefined || normalizedCompatibility.length === 0
      ? {}
      : { compatibility: normalizedCompatibility }),
    ...(normalizedSourceUrl === undefined || normalizedSourceUrl.length === 0
      ? {}
      : { sourceUrl: normalizedSourceUrl }),
    ...(normalizedSourceRevision === undefined || normalizedSourceRevision.length === 0
      ? {}
      : { sourceRevision: normalizedSourceRevision }),
  };
}

function presentError(reason: unknown): AdminApiError {
  return reason instanceof AdminApiError
    ? reason
    : new AdminApiError("操作未完成，请刷新后重试。", 0, true);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function displayDigest(value: string): string {
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

function safeSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function mergeSelectedFiles(
  current: readonly File[],
  incoming: readonly File[],
): readonly File[] {
  const byPath = new Map(current.map((file) => [resolvePackagePath(file), file]));
  for (const file of incoming) byPath.set(resolvePackagePath(file), file);
  return [...byPath.values()];
}

function ErrorBanner({ error, onDismiss }: { error: AdminApiError; onDismiss: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <span>
        <strong>操作未完成</strong>
        {error.message}
      </span>
      <button type="button" className="quiet-button" onClick={onDismiss}>
        关闭
      </button>
    </div>
  );
}

function SubmissionList({
  items,
  selectedId,
  loading,
  hasMore,
  onSelect,
  onLoadMore,
}: {
  readonly items: readonly SkillSubmissionDto[];
  readonly selectedId: string | undefined;
  readonly loading: boolean;
  readonly hasMore: boolean;
  readonly onSelect: (submissionId: string) => void;
  readonly onLoadMore: () => void;
}) {
  return (
    <aside className="submission-list" aria-label="发布申请列表">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">技能</span>
          <h2>技能列表</h2>
        </div>
        <span className="count">{items.length}</span>
      </div>
      {loading && items.length === 0 ? (
        <p className="empty-state">正在加载技能…</p>
      ) : items.length === 0 ? (
        <p className="empty-state">尚未上传技能。</p>
      ) : (
        <div className="submission-items">
          {items.map((submission) => (
            <button
              type="button"
              key={submission.submissionId}
              className={
                submission.submissionId === selectedId ? "submission selected" : "submission"
              }
              onClick={() => onSelect(submission.submissionId)}
            >
              <span className="submission-title">{submission.displayName}</span>
              <span className="submission-key">{submission.canonicalKey}</span>
              <span className={`status status-${submission.status}`}>
                {statusLabels[submission.status]}
              </span>
              <time>{formatDate(submission.updatedAt)}</time>
            </button>
          ))}
        </div>
      )}
      {hasMore && (
        <button type="button" className="load-more" disabled={loading} onClick={onLoadMore}>
          {loading ? "加载中…" : "加载更多"}
        </button>
      )}
    </aside>
  );
}

function CreateSubmissionForm({
  api,
  replacing,
  onCancelReplacement,
  onCreated,
  onError,
}: {
  readonly api: SkillAdminApiContract;
  readonly replacing?: SkillSubmissionDto | undefined;
  readonly onCancelReplacement: () => void;
  readonly onCreated: (submission: SkillSubmissionDto) => void;
  readonly onError: (error: AdminApiError) => void;
}) {
  const [form, setForm] = useState<CreateFormState>(() =>
    replacing === undefined
      ? emptyCreateForm
      : {
          canonicalKey: replacing.canonicalKey,
          displayName: replacing.displayName,
          publisher: replacing.publisher,
          description: replacing.description,
          compatibility: replacing.compatibility,
          sourceUrl: replacing.sourceUrl,
          sourceRevision: replacing.sourceRevision,
          licenseSpdx: replacing.licenseSpdx,
        },
  );
  const [files, setFiles] = useState<readonly File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [metadataFeedback, setMetadataFeedback] = useState<
    Readonly<{ kind: "success" | "notice"; message: string }> | undefined
  >();

  useEffect(() => {
    let active = true;
    if (files.length === 0) {
      setMetadataFeedback(undefined);
      return () => {
        active = false;
      };
    }
    void extractSkillMetadataPrefill(files)
      .then((prefill) => {
        if (!active) return;
        if (prefill.recognizedLabels.length === 0) {
          setMetadataFeedback({
            kind: "notice",
            message: "已找到 SKILL.md，但没有可自动填写的标准元数据。",
          });
          return;
        }
        setForm((current) => ({
          ...current,
          ...prefill.values,
          ...(replacing === undefined
            ? {}
            : { canonicalKey: replacing.canonicalKey, publisher: replacing.publisher }),
        }));
        setMetadataFeedback({
          kind: "success",
          message: `已从 SKILL.md 自动填写：${prefill.recognizedLabels.join("、")}。请核对后提交。${
            prefill.licenseNotice === undefined ? "" : ` ${prefill.licenseNotice}`
          }`,
        });
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setMetadataFeedback({
          kind: "notice",
          message:
            reason instanceof SkillMetadataError
              ? reason.message
              : "SKILL.md 元数据自动识别失败，请手动填写。",
        });
      });
    return () => {
      active = false;
    };
  }, [files, replacing]);

  const update = (field: keyof CreateFormState, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
  };
  const appendFiles = (incoming: FileList | null) => {
    if (incoming === null) return;
    setFiles((current) => mergeSelectedFiles(current, [...incoming]));
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (files.length === 0) {
      onError(new AdminApiError("请至少选择一个技能包文件。", 400, false));
      return;
    }
    if (files.length > maxSubmissionFiles) {
      onError(new AdminApiError(`文件数量不能超过 ${maxSubmissionFiles} 个。`, 400, false));
      return;
    }
    setSubmitting(true);
    try {
      const preparedFiles = await filesToRequests(files);
      const submission = await api.createSubmission({
        ...prepareCreateMetadata(form),
        files: [...preparedFiles],
      });
      setForm(emptyCreateForm);
      setFiles([]);
      onCreated(submission);
    } catch (reason) {
      onError(presentError(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <details className="create-panel" open={replacing === undefined ? undefined : true}>
      <summary>
        <span>
          <span className="eyebrow">{replacing === undefined ? "添加技能" : "更新技能"}</span>
          <strong>
            {replacing === undefined ? "上传技能包" : `上传更新：${replacing.displayName}`}
          </strong>
        </span>
        <span aria-hidden="true">＋</span>
      </summary>
      <form className="create-form" onSubmit={(event) => void submit(event)}>
        <div className="form-grid">
          <label>
            规范键
            <input
              required
              readOnly={replacing !== undefined}
              maxLength={128}
              pattern="[a-z0-9][a-z0-9._-]{0,127}"
              placeholder="code-review"
              value={form.canonicalKey}
              onChange={(event) => update("canonicalKey", event.target.value)}
            />
          </label>
          <label>
            显示名称
            <input
              required
              maxLength={200}
              value={form.displayName}
              onChange={(event) => update("displayName", event.target.value)}
            />
          </label>
          <label>
            发布者
            <input
              required
              maxLength={200}
              value={form.publisher}
              readOnly={replacing !== undefined}
              onChange={(event) => update("publisher", event.target.value)}
            />
          </label>
          <label className="wide-field">
            描述
            <textarea
              required
              maxLength={2048}
              rows={3}
              value={form.description}
              onChange={(event) => update("description", event.target.value)}
            />
          </label>
          <label>
            SPDX 许可证
            <input
              required
              maxLength={100}
              placeholder="MIT"
              value={form.licenseSpdx}
              onChange={(event) => update("licenseSpdx", event.target.value)}
            />
          </label>
        </div>
        <details className="advanced-metadata">
          <summary>高级溯源信息（可选）</summary>
          <p>从 Git 仓库导入时由系统记录；本地目录上传可以留空，实际文件身份由包摘要保证。</p>
          <div className="form-grid">
            <label className="wide-field">
              上游仓库地址
              <input
                type="url"
                maxLength={2048}
                placeholder="https://github.com/owner/repository"
                value={form.sourceUrl ?? ""}
                onChange={(event) => update("sourceUrl", event.target.value)}
              />
            </label>
            <label>
              上游提交/版本
              <input
                maxLength={200}
                placeholder="commit SHA 或 tag"
                value={form.sourceRevision ?? ""}
                onChange={(event) => update("sourceRevision", event.target.value)}
              />
            </label>
          </div>
        </details>
        <fieldset className="file-picker">
          <legend>技能包文件</legend>
          <p>选择多个文件或整个目录；目录上传会保留相对路径，并以 SKILL.md 作为入口。</p>
          <div className="file-picker-actions">
            <label className="file-button">
              选择多个文件
              <input type="file" multiple onChange={(event) => appendFiles(event.target.files)} />
            </label>
            <label className="file-button secondary">
              选择目录
              <input
                ref={(node) => {
                  node?.setAttribute("webkitdirectory", "");
                }}
                type="file"
                multiple
                onChange={(event) => appendFiles(event.target.files)}
              />
            </label>
            {files.length > 0 && (
              <button type="button" className="quiet-button" onClick={() => setFiles([])}>
                清空
              </button>
            )}
          </div>
          <div className="selected-files" aria-live="polite">
            {files.length === 0
              ? "尚未选择文件"
              : `已选择 ${files.length} 个文件，共 ${formatBytes(
                  files.reduce((sum, file) => sum + file.size, 0),
                )}`}
          </div>
          {metadataFeedback !== undefined && (
            <div
              className={`metadata-feedback metadata-feedback-${metadataFeedback.kind}`}
              role="status"
            >
              {metadataFeedback.message}
            </div>
          )}
          {files.length > 0 && (
            <ul className="selected-file-list">
              {files.slice(0, 8).map((file) => (
                <li key={resolvePackagePath(file)}>{resolvePackagePath(file)}</li>
              ))}
              {files.length > 8 && <li>另有 {files.length - 8} 个文件</li>}
            </ul>
          )}
        </fieldset>
        <div className="form-actions">
          <button type="submit" className="primary-button" disabled={submitting}>
            {submitting ? "正在上传并校验…" : "上传并预览"}
          </button>
          {replacing !== undefined && (
            <button
              type="button"
              className="quiet-button"
              onClick={onCancelReplacement}
              disabled={submitting}
            >
              取消更新
            </button>
          )}
        </div>
      </form>
    </details>
  );
}

function StatusActions({
  submission,
  busy,
  onPublish,
  onRevoke,
  onReplace,
}: {
  readonly submission: SkillSubmissionDto;
  readonly busy: boolean;
  readonly onPublish: () => void;
  readonly onRevoke: (publication: NonNullable<SkillSubmissionDto["currentPublished"]>) => void;
  readonly onReplace: () => void;
}) {
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const published =
    submission.currentPublished ??
    (submission.status === "published"
      ? { submissionId: submission.submissionId, versionToken: submission.versionToken }
      : undefined);
  const revokingCurrentUpload = published?.submissionId === submission.submissionId;

  return (
    <section className="action-panel" aria-label="状态操作">
      <div>
        <span className="eyebrow">发布</span>
        <h3>可执行操作</h3>
      </div>
      {["draft", "submitted", "approved"].includes(submission.status) && (
        <div className="publish-actions">
          <p>
            当前上传内容尚未发布，文件校验已通过。
            {submission.currentPublished === undefined
              ? "发布后，用户可以安装此包。"
              : "已发布内容和已有安装继续有效；发布后，新安装使用此包。"}
          </p>
          <button type="button" className="primary-button" disabled={busy} onClick={onPublish}>
            发布技能
          </button>
        </div>
      )}
      {published !== undefined && (
        <div className="review-actions">
          {confirmingRevoke ? (
            <div role="alert" aria-label="下架确认">
              <p>
                下架后将停止新安装，已安装的此包也无法继续执行。
                {revokingCurrentUpload ? "" : "当前上传内容保持未发布。"}确定下架？
              </p>
              <button
                type="button"
                className="danger-button"
                disabled={busy}
                onClick={() => onRevoke(published)}
              >
                确认下架
              </button>
              <button
                type="button"
                className="quiet-button"
                disabled={busy}
                onClick={() => setConfirmingRevoke(false)}
              >
                取消
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="danger-button"
              disabled={busy}
              onClick={() => setConfirmingRevoke(true)}
            >
              {revokingCurrentUpload ? "下架技能" : "下架当前已发布内容"}
            </button>
          )}
        </div>
      )}
      {(submission.status === "rejected" || submission.status === "revoked") && (
        <p className="terminal-note">此包已停止发布。需要重新发布时，请上传更新。</p>
      )}
      <button type="button" className="quiet-button" disabled={busy} onClick={onReplace}>
        上传更新
      </button>
      {busy && <span className="working-note">正在保存…</span>}
    </section>
  );
}

function SubmissionDetail({
  submission,
  busy,
  onPublish,
  onRevoke,
  onReplace,
}: {
  readonly submission: SkillSubmissionDto;
  readonly busy: boolean;
  readonly onPublish: () => void;
  readonly onRevoke: (publication: NonNullable<SkillSubmissionDto["currentPublished"]>) => void;
  readonly onReplace: () => void;
}) {
  const sourceUrl = safeSourceUrl(submission.sourceUrl);
  return (
    <article className="detail-panel">
      <header className="detail-header">
        <div>
          <span className="eyebrow">{submission.canonicalKey}</span>
          <h2>{submission.displayName}</h2>
          <p>{submission.publisher}</p>
        </div>
        <span className={`status large status-${submission.status}`}>
          {statusLabels[submission.status]}
        </span>
      </header>

      <section className="summary-card" aria-label="申请摘要">
        <div className="summary-description">
          <span className="eyebrow">摘要</span>
          <p>{submission.description}</p>
        </div>
        <dl className="summary-grid">
          <div>
            <dt>文件</dt>
            <dd>{submission.fileCount}</dd>
          </div>
          <div>
            <dt>包大小</dt>
            <dd>{formatBytes(submission.totalBytes)}</dd>
          </div>
          <div>
            <dt>安全状态</dt>
            <dd>受限</dd>
          </div>
        </dl>
      </section>

      {submission.rejectionReason !== undefined && (
        <section className="reason-card" aria-label="驳回原因">
          <strong>驳回原因</strong>
          <p>{submission.rejectionReason}</p>
        </section>
      )}

      <section className="metadata-card" aria-label="申请元数据">
        <h3>元数据</h3>
        <dl className="metadata-grid">
          <div>
            <dt>格式兼容性</dt>
            <dd>{submission.compatibility}</dd>
          </div>
          <div>
            <dt>SPDX 许可证</dt>
            <dd>{submission.licenseSpdx}</dd>
          </div>
          <div>
            <dt>上游提交/版本</dt>
            <dd>{submission.sourceRevision || "未声明"}</dd>
          </div>
          <div>
            <dt>来源地址</dt>
            <dd>
              {submission.sourceUrl.length === 0 ? (
                "未声明"
              ) : sourceUrl === undefined ? (
                submission.sourceUrl
              ) : (
                <a href={sourceUrl} target="_blank" rel="noreferrer">
                  {submission.sourceUrl}
                </a>
              )}
            </dd>
          </div>
          <div>
            <dt>包摘要</dt>
            <dd title={submission.packageDigest}>{displayDigest(submission.packageDigest)}</dd>
          </div>
          <div>
            <dt>入口摘要</dt>
            <dd title={submission.entrypointDigest}>
              {displayDigest(submission.entrypointDigest)}
            </dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>{formatDate(submission.createdAt)}</dd>
          </div>
          <div>
            <dt>更新时间</dt>
            <dd>{formatDate(submission.updatedAt)}</dd>
          </div>
        </dl>
      </section>

      <section className="entrypoint-card" aria-label="SKILL.md">
        <div className="section-heading">
          <div>
            <span className="eyebrow">入口文件</span>
            <h3>SKILL.md</h3>
          </div>
          <span>
            {formatBytes(new TextEncoder().encode(submission.entrypointMarkdown).byteLength)}
          </span>
        </div>
        <pre>{submission.entrypointMarkdown}</pre>
      </section>

      <section className="files-card" aria-label="文件清单">
        <div className="section-heading">
          <div>
            <span className="eyebrow">包内容</span>
            <h3>文件清单</h3>
          </div>
          <span>{submission.files.length} 项</span>
        </div>
        <div className="file-table-wrap">
          <table>
            <thead>
              <tr>
                <th>路径</th>
                <th>媒体类型</th>
                <th>大小</th>
                <th>摘要</th>
              </tr>
            </thead>
            <tbody>
              {submission.files.map((file) => (
                <tr key={file.path}>
                  <td>{file.path}</td>
                  <td>{file.mediaType}</td>
                  <td>{formatBytes(file.sizeBytes)}</td>
                  <td title={file.contentDigest}>{displayDigest(file.contentDigest)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <StatusActions
        submission={submission}
        busy={busy}
        onPublish={onPublish}
        onRevoke={onRevoke}
        onReplace={onReplace}
      />
    </article>
  );
}

export function SkillConsole({
  apiClient = defaultApi,
}: {
  readonly apiClient?: SkillAdminApiContract;
}) {
  const [submissions, setSubmissions] = useState<readonly SkillSubmissionDto[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [selected, setSelected] = useState<SkillSubmissionDto>();
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<AdminApiError>();
  const [replacing, setReplacing] = useState<SkillSubmissionDto>();

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    try {
      const page = await apiClient.listSubmissions();
      setSubmissions(page.items);
      setNextCursor(page.nextCursor);
      setSelectedId((current) =>
        current !== undefined && page.items.some((item) => item.submissionId === current)
          ? current
          : page.items[0]?.submissionId,
      );
      setError(undefined);
    } catch (reason) {
      setError(presentError(reason));
    } finally {
      setLoading(false);
    }
  }, [apiClient]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  useEffect(() => {
    if (selectedId === undefined) {
      setSelected(undefined);
      return;
    }
    let active = true;
    setDetailLoading(true);
    void apiClient
      .getSubmission(selectedId)
      .then((submission) => {
        if (!active) return;
        setSelected(submission);
        setSubmissions((current) =>
          current.map((item) =>
            item.submissionId === submission.submissionId ? submission : item,
          ),
        );
        setError(undefined);
      })
      .catch((reason: unknown) => {
        if (active) setError(presentError(reason));
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [apiClient, selectedId]);

  const updateSubmission = useCallback((submission: SkillSubmissionDto) => {
    setSelected(submission);
    setSubmissions((current) => [
      submission,
      ...current.filter((item) => item.canonicalKey !== submission.canonicalKey),
    ]);
  }, []);

  const runTransition = async (operation: () => Promise<SkillSubmissionDto>) => {
    setActionLoading(true);
    try {
      updateSubmission(await operation());
      setError(undefined);
    } catch (reason) {
      setError(presentError(reason));
    } finally {
      setActionLoading(false);
    }
  };

  const selectedSummary = useMemo(
    () => submissions.find((item) => item.submissionId === selectedId),
    [selectedId, submissions],
  );
  const current = selected?.submissionId === selectedId ? selected : selectedSummary;

  return (
    <main className="admin-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">Hoox</span>
          <h1>技能发布管理台</h1>
        </div>
        <button
          type="button"
          className="quiet-button refresh-button"
          onClick={() => void loadFirstPage()}
        >
          刷新列表
        </button>
      </header>

      {error !== undefined && <ErrorBanner error={error} onDismiss={() => setError(undefined)} />}

      <CreateSubmissionForm
        key={replacing?.submissionId ?? "new-skill"}
        api={apiClient}
        replacing={replacing}
        onCancelReplacement={() => setReplacing(undefined)}
        onCreated={(submission) => {
          updateSubmission(submission);
          setSelectedId(submission.submissionId);
          setReplacing(undefined);
        }}
        onError={setError}
      />

      <div className="workspace-grid">
        <SubmissionList
          items={submissions}
          selectedId={selectedId}
          loading={loading}
          hasMore={nextCursor !== undefined}
          onSelect={setSelectedId}
          onLoadMore={() => {
            if (nextCursor === undefined || loading) return;
            setLoading(true);
            void apiClient
              .listSubmissions(nextCursor)
              .then((page) => {
                setSubmissions((current) => {
                  const byId = new Map(current.map((item) => [item.canonicalKey, item]));
                  for (const item of page.items) byId.set(item.canonicalKey, item);
                  return [...byId.values()];
                });
                setNextCursor(page.nextCursor);
              })
              .catch((reason: unknown) => setError(presentError(reason)))
              .finally(() => setLoading(false));
          }}
        />
        <section className="detail-region" aria-live="polite">
          {detailLoading && current === undefined ? (
            <p className="empty-state large">正在加载申请详情…</p>
          ) : current === undefined ? (
            <div className="empty-detail">
              <span aria-hidden="true">◇</span>
              <h2>选择一个技能</h2>
              <p>上传技能包，检查预览后即可发布。</p>
            </div>
          ) : (
            <SubmissionDetail
              key={current.submissionId}
              submission={current}
              busy={actionLoading}
              onPublish={() =>
                void runTransition(() =>
                  apiClient.publishSubmission(current.submissionId, {
                    expectedVersionToken: current.versionToken,
                    recommended: true,
                  }),
                )
              }
              onRevoke={(publication) =>
                void runTransition(async () => {
                  const revoked = await apiClient.revokeSubmission(publication.submissionId, {
                    expectedVersionToken: publication.versionToken,
                  });
                  if (publication.submissionId === current.submissionId) return revoked;
                  const { currentPublished: _previous, ...upload } = current;
                  return {
                    ...upload,
                    ...(revoked.currentPublished === undefined
                      ? {}
                      : { currentPublished: revoked.currentPublished }),
                  };
                })
              }
              onReplace={() => setReplacing(current)}
            />
          )}
        </section>
      </div>
    </main>
  );
}

const { Content, Header, Sider } = Layout;

const navigation: NonNullable<MenuProps["items"]> = [
  {
    key: "/overview",
    icon: <AppstoreOutlined />,
    label: "工作台",
  },
  {
    type: "group",
    label: "运营",
    children: [
      { key: "/analytics", icon: <BarChartOutlined />, label: "数据运营" },
      { key: "/runs", icon: <HistoryOutlined />, label: "运行记录" },
      { key: "/users", icon: <TeamOutlined />, label: "用户管理" },
    ],
  },
  {
    type: "group",
    label: "Agent",
    children: [
      { key: "/agent-definitions", icon: <RobotOutlined />, label: "Agent 管理" },
      { key: "/external-tools", icon: <ToolOutlined />, label: "外部工具" },
    ],
  },
  {
    type: "group",
    label: "AI 能力",
    children: [
      { key: "/models", icon: <RobotOutlined />, label: "模型服务" },
      { key: "/memory", icon: <BulbOutlined />, label: "记忆服务" },
      { key: "/sandboxes", icon: <DatabaseOutlined />, label: "沙箱服务" },
      { key: "/skills", icon: <DatabaseOutlined />, label: "Skills" },
    ],
  },
  {
    type: "group",
    label: "系统",
    children: [
      { key: "/identity", icon: <SafetyCertificateOutlined />, label: "身份与登录" },
      { key: "/settings", icon: <SettingOutlined />, label: "运行设置" },
      { key: "/audits", icon: <AuditOutlined />, label: "操作审计" },
    ],
  },
];

const pageMetadata: Readonly<
  Record<string, { readonly title: string; readonly description: string }>
> = {
  "/overview": {
    title: "工作台",
    description: "平台健康、关键指标与近期变更",
  },
  "/analytics": {
    title: "数据运营",
    description: "用户、对话与运行可靠性指标",
  },
  "/external-tools": { title: "外部工具", description: "管理 MCP 草稿、发布批次和 HTTP 工具预览" },
  "/agent-definitions": {
    title: "Agent 管理",
    description: "维护草稿、发布版本和 Tenant 可用范围",
  },
  "/runs": {
    title: "运行记录",
    description: "按 Tenant、状态与时间浏览 Run 的结构、耗时与用量",
  },
  "/users": {
    title: "用户管理",
    description: "账号状态、使用情况与会话治理",
  },
  "/identity": {
    title: "身份与登录",
    description: "登录方式、开放注册与第三方身份源",
  },
  "/models": {
    title: "模型服务",
    description: "Provider、API Key 与默认模型",
  },
  "/memory": {
    title: "记忆服务",
    description: "Mem0 连接、作用域与异步链路",
  },
  "/sandboxes": { title: "沙箱服务", description: "供应商切换、负载分配与运行策略" },
  "/skills": {
    title: "Skills",
    description: "上传、发布更新与下架技能",
  },
  "/audits": {
    title: "操作审计",
    description: "查看不可变的控制面变更记录",
  },
  "/settings": { title: "运行设置", description: "在线调整任务并发与上下文压缩" },
};

const defaultPageMetadata = {
  title: "工作台",
  description: "平台健康、关键指标与近期变更",
} as const;

/** 菜单与页头按一级路径匹配；Run 详情等子路由归属其列表菜单项。 */
function navigationKey(pathname: string): string {
  if (pathname.startsWith("/external-tools/")) return "/external-tools";
  if (pathname.startsWith("/runs/")) return "/runs";
  if (pathname.startsWith("/agent-definitions/")) return "/agent-definitions";
  return pathname;
}

function RunExplorerListRoute({ api }: { readonly api: RunExplorerApiContract }) {
  const navigate = useNavigate();
  return (
    <RunExplorerList
      api={api}
      onOpen={(run) =>
        navigate(`/runs/${encodeURIComponent(run.tenantId)}/${encodeURIComponent(run.runId)}`)
      }
    />
  );
}

function RunExplorerDetailRoute({ api }: { readonly api: RunExplorerApiContract }) {
  const navigate = useNavigate();
  const { tenantId, runId } = useParams();
  if (tenantId === undefined || runId === undefined) return <Navigate to="/runs" replace />;
  return (
    <RunExplorerDetail
      key={`${tenantId}/${runId}`}
      api={api}
      tenantId={tenantId}
      runId={runId}
      onBack={() => navigate("/runs")}
    />
  );
}

function AgentDefinitionsRoute({
  api,
  kind,
}: {
  readonly api: AgentDefinitionApiContract;
  readonly kind: "list" | "create" | "detail";
}) {
  const navigate = useNavigate();
  const { definitionId } = useParams();
  const base = "/agent-definitions";
  if (kind === "detail" && definitionId === undefined) return <Navigate to={base} replace />;
  return (
    <AgentDefinitionsPage
      api={api}
      destination={kind === "detail" ? { kind, id: definitionId ?? "" } : { kind }}
      onBack={() => navigate(base)}
      onOpen={(id) =>
        navigate(id === undefined ? `${base}/draft/new` : `${base}/${encodeURIComponent(id)}`)
      }
    />
  );
}

function AdminPlatform({
  apiClient,
  controlApi,
  runApi,
  agentApi,
}: {
  readonly apiClient: SkillAdminApiContract;
  readonly controlApi?: AdminControlApiContract;
  readonly runApi: RunExplorerApiContract;
  readonly agentApi: AgentDefinitionApiContract;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const activeKey = navigationKey(location.pathname);
  const metadata = pageMetadata[activeKey] ?? defaultPageMetadata;

  return (
    <Layout className="platform-admin-shell">
      <Sider
        className="platform-sider"
        width={248}
        collapsedWidth={76}
        collapsed={collapsed}
        breakpoint="lg"
        trigger={null}
        onBreakpoint={setCollapsed}
      >
        <button
          type="button"
          className="platform-logo"
          aria-label="返回工作台"
          onClick={() => navigate("/overview")}
        >
          <img className="platform-logo-mark" src={HOOX_APP_ICON_PATH} alt="" aria-hidden="true" />
          {!collapsed && (
            <span className="platform-logo-copy">
              <strong>Hoox</strong>
              <small>Runtime Console</small>
            </span>
          )}
        </button>
        <Menu
          className="platform-menu"
          mode="inline"
          items={navigation}
          selectedKeys={[activeKey]}
          onClick={({ key }) =>
            navigate({ pathname: key, search: location.search === "?setup=1" ? "?setup=1" : "" })
          }
        />
        <div className="platform-sider-footer">
          <span className="service-health-dot" aria-hidden="true" />
          {!collapsed && (
            <span>
              <strong>控制面</strong>
              <small>连接状态以页面数据为准</small>
            </span>
          )}
        </div>
      </Sider>
      <Layout className="platform-main-layout">
        <Header className="platform-header">
          <div className="platform-header-leading">
            <Tooltip title={collapsed ? "展开导航" : "收起导航"}>
              <Button
                type="text"
                className="platform-collapse-button"
                aria-label={collapsed ? "展开导航" : "收起导航"}
                icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                onClick={() => setCollapsed((value) => !value)}
              />
            </Tooltip>
            <div className="platform-page-context">
              <strong>{metadata.title}</strong>
              <span>{metadata.description}</span>
            </div>
          </div>
          <div className="platform-header-actions">
            <Tag>部署类型见服务端检测</Tag>
            <span className="platform-operator">
              <span className="platform-operator-avatar">A</span>
              <span>
                <strong>平台管理员</strong>
                <small>权限由管理网关确认</small>
              </span>
            </span>
          </div>
        </Header>
        <Content className="platform-content">
          <Routes>
            <Route
              path="/overview"
              element={
                <AdminControlConsole
                  view="overview"
                  {...(controlApi === undefined ? {} : { api: controlApi })}
                />
              }
            />
            <Route
              path="/analytics"
              element={
                <AdminControlConsole
                  view="analytics"
                  {...(controlApi === undefined ? {} : { api: controlApi })}
                />
              }
            />
            <Route
              path="/users"
              element={
                <AdminControlConsole
                  view="users"
                  {...(controlApi === undefined ? {} : { api: controlApi })}
                />
              }
            />
            <Route
              path="/identity"
              element={
                <AdminControlConsole
                  view="identity"
                  {...(controlApi === undefined ? {} : { api: controlApi })}
                />
              }
            />
            <Route
              path="/models"
              element={
                <AdminControlConsole
                  view="models"
                  {...(controlApi === undefined ? {} : { api: controlApi })}
                />
              }
            />
            <Route
              path="/memory"
              element={
                <AdminControlConsole
                  view="memory"
                  {...(controlApi === undefined ? {} : { api: controlApi })}
                />
              }
            />
            <Route
              path="/external-tools"
              element={<ExternalToolsPage api={defaultManagementApi} />}
            />
            <Route
              path="/external-tools/http-preview"
              element={<ExternalToolsPage api={defaultManagementApi} httpPreview />}
            />
            <Route
              path="/agent-definitions"
              element={<AgentDefinitionsRoute api={agentApi} kind="list" />}
            />
            <Route
              path="/agent-definitions/draft/new"
              element={<AgentDefinitionsRoute api={agentApi} kind="create" />}
            />
            <Route
              path="/agent-definitions/:definitionId"
              element={<AgentDefinitionsRoute api={agentApi} kind="detail" />}
            />
            <Route path="/runs" element={<RunExplorerListRoute api={runApi} />} />
            <Route
              path="/runs/:tenantId/:runId"
              element={<RunExplorerDetailRoute api={runApi} />}
            />
            <Route path="/skills" element={<SkillConsole apiClient={apiClient} />} />
            <Route path="/sandboxes" element={<SandboxConfigurationPanel />} />
            <Route
              path="/settings"
              element={
                <AdminControlConsole
                  view="settings"
                  {...(controlApi === undefined ? {} : { api: controlApi })}
                />
              }
            />
            <Route
              path="/audits"
              element={
                <AdminControlConsole
                  view="audits"
                  {...(controlApi === undefined ? {} : { api: controlApi })}
                />
              }
            />
            <Route path="/" element={<Navigate to="/overview" replace />} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}

export function App({
  apiClient,
  controlApi,
  runApi,
  agentApi,
  initialPath,
}: {
  readonly apiClient?: SkillAdminApiContract;
  readonly controlApi?: AdminControlApiContract;
  readonly runApi?: RunExplorerApiContract;
  readonly agentApi?: AgentDefinitionApiContract;
  /** 仅用于注入客户端的内存路由（测试与嵌入）；真实管理台以浏览器地址为准。 */
  readonly initialPath?: string;
}) {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            refetchOnWindowFocus: false,
            staleTime: 10_000,
          },
          mutations: { retry: false },
        },
      }),
    [],
  );
  const platform = (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#176b4d",
          colorInfo: "#176b4d",
          colorSuccess: "#21875f",
          colorWarning: "#d18a32",
          colorError: "#c65045",
          colorText: "#17251f",
          colorTextSecondary: "#66756d",
          colorBgLayout: "#f3f6f4",
          colorBorderSecondary: "#e4eae6",
          borderRadius: 10,
          borderRadiusLG: 16,
          fontFamily:
            'Inter, "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif',
        },
        components: {
          Menu: {
            itemBorderRadius: 10,
            itemHeight: 42,
            itemSelectedBg: "#e7f3ed",
            itemSelectedColor: "#12563e",
          },
          Button: { controlHeight: 38 },
        },
      }}
    >
      <AntApp>
        <QueryClientProvider client={queryClient}>
          {typeof window !== "undefined" &&
            new URLSearchParams(window.location.search).get("setup") === "1" && (
              <InstallationProgress />
            )}
          {apiClient === undefined && controlApi === undefined && (
            <button
              type="button"
              className="installation-logout"
              onClick={() => {
                void (async () => {
                  const token = readAdminAccessToken();
                  try {
                    const response = await fetch("/api/v1/auth/logout", {
                      method: "POST",
                      headers: { authorization: `Bearer ${token}` },
                    });
                    if (!response.ok && response.status !== 401) throw new Error("LOGOUT_FAILED");
                    localStorage.removeItem("hoox.auth-session.v2");
                    window.location.reload();
                  } catch {
                    window.alert("退出失败，请检查连接后重试。");
                  }
                })();
              }}
            >
              退出登录
            </button>
          )}
          <AdminPlatform
            apiClient={apiClient ?? defaultApi}
            {...(controlApi === undefined ? {} : { controlApi })}
            runApi={runApi ?? defaultRunApi}
            agentApi={agentApi ?? defaultManagementApi}
          />
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  );

  const basename = browserRouterBasename(import.meta.env.BASE_URL);

  if (apiClient === undefined && controlApi === undefined && readAdminAccessToken() === undefined) {
    return (
      <main className="admin-login-required" aria-label="后台登录提示">
        <section>
          <p className="eyebrow">Hoox Admin</p>
          <h1>请先登录 Hoox 工作台</h1>
          <p>后台不再使用浏览器 Basic 密码框；仅 Demo 管理员的有效 Hoox 会话可以调用后台接口。</p>
          <a href="/">前往工作台登录</a>
        </section>
      </main>
    );
  }

  // 注入客户端时使用内存路由，隔离测试与嵌入场景的全局地址；真实管理台使用浏览器地址形成可复制入口。
  return apiClient !== undefined || controlApi !== undefined ? (
    <MemoryRouter
      initialEntries={[
        initialPath ??
          (apiClient !== undefined && controlApi === undefined ? "/skills" : "/overview"),
      ]}
    >
      {platform}
    </MemoryRouter>
  ) : (
    <BrowserRouter {...(basename === undefined ? {} : { basename })}>{platform}</BrowserRouter>
  );
}

import {
  Building2,
  ChevronDown,
  ChevronRight,
  Plus,
  RefreshCw,
  Settings,
  Users,
  X,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, type TeamMember, type TeamPersonalization, type TeamSummary } from "./api.js";
import { personalizationSize } from "./personalization.js";

const TEAM_SWITCHER_EXPANDED_STORAGE_KEY = "aisay.team-switcher.expanded";

function readTeamSwitcherExpanded(): boolean {
  try {
    return window.localStorage.getItem(TEAM_SWITCHER_EXPANDED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function persistTeamSwitcherExpanded(expanded: boolean): void {
  try {
    window.localStorage.setItem(TEAM_SWITCHER_EXPANDED_STORAGE_KEY, String(expanded));
  } catch {
    // 隐私模式或禁用存储时退化为当前页面内状态，不阻断团队导航。
  }
}

export interface TeamWorkspaceApi {
  listTeams(): Promise<readonly TeamSummary[]>;
  createTeam(displayName: string): Promise<TeamSummary>;
  listTeamMembers(teamId: string): Promise<readonly TeamMember[]>;
  addTeamMember(teamId: string, userId: string, role?: "admin" | "member"): Promise<TeamMember>;
  changeTeamMemberRole(
    teamId: string,
    userId: string,
    role: TeamMember["role"],
  ): Promise<TeamMember>;
  removeTeamMember(teamId: string, userId: string): Promise<void>;
  dissolveTeam(teamId: string): Promise<void>;
  getTeamPersonalization?(teamId: string): Promise<TeamPersonalization>;
  updateTeamPersonalization?(
    teamId: string,
    input: { readonly content: string; readonly expectedVersion: number },
  ): Promise<TeamPersonalization>;
}

export function TeamSwitcher({
  teams,
  selectedTeamId,
  loading,
  onSwitch,
  onNewTeamThread,
  onOpenTeamCenter,
  taskCount,
  children,
}: {
  readonly teams: readonly TeamSummary[];
  readonly selectedTeamId?: string;
  readonly loading: boolean;
  readonly onSwitch: (teamId: string) => void;
  readonly onNewTeamThread: () => void;
  readonly onOpenTeamCenter: () => void;
  readonly taskCount: number;
  readonly children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(readTeamSwitcherExpanded);
  const selected = teams.find((team) => team.id === selectedTeamId) ?? teams[0];
  const hasTeams = selected !== undefined;

  return (
    <section className="team-switcher" aria-label="团队空间">
      <div className="team-switcher-header">
        <button
          type="button"
          className="team-switcher-summary"
          aria-expanded={hasTeams ? expanded : undefined}
          onClick={() => {
            if (!hasTeams) {
              onOpenTeamCenter();
              return;
            }
            setExpanded((value) => {
              const next = !value;
              persistTeamSwitcherExpanded(next);
              return next;
            });
          }}
        >
          {hasTeams ? (
            expanded ? (
              <ChevronDown size={16} />
            ) : (
              <ChevronRight size={16} />
            )
          ) : (
            <Plus size={16} />
          )}
          {hasTeams ? <Users size={17} /> : <Building2 size={17} />}
          <span>{selected?.displayName ?? "创建或加入团队"}</span>
        </button>
        {selected !== undefined && (
          <button
            type="button"
            className="team-new-thread-shortcut"
            aria-label={`在${selected.displayName}新增对话`}
            onClick={onNewTeamThread}
          >
            <Plus size={14} />
            <span>新增对话</span>
          </button>
        )}
      </div>
      {expanded && selected !== undefined && (
        <div className="team-switcher-body">
          <div className="team-switcher-controls">
            <label>
              <span className="sr-only">切换团队</span>
              <select
                value={selected.id}
                disabled={loading}
                onChange={(event) => onSwitch(event.target.value)}
              >
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.displayName}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={onOpenTeamCenter} aria-label="打开团队中心">
              <Settings size={15} />
            </button>
          </div>
          <div className="team-task-heading">
            <span>团队任务</span>
            <span>{taskCount}</span>
          </div>
          <div className="team-task-list">{children}</div>
        </div>
      )}
    </section>
  );
}

export function TeamCenterDialog({
  teams,
  selectedTeamId,
  loading,
  onSelectTeam,
  onCreate,
  onRefresh,
  onManage,
  onClose,
}: {
  readonly teams: readonly TeamSummary[];
  readonly selectedTeamId?: string;
  readonly loading: boolean;
  readonly onSelectTeam: (teamId: string) => void;
  readonly onCreate: (displayName: string) => Promise<void>;
  readonly onRefresh: () => Promise<void>;
  readonly onManage: (teamId: string) => void;
  readonly onClose: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!displayName.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onCreate(displayName.trim());
      setDisplayName("");
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "创建团队失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="skill-center-backdrop">
      <section className="team-center-dialog" role="dialog" aria-modal="true">
        <header className="skill-center-header">
          <div>
            <h2>团队中心</h2>
            <p>创建、加入和管理团队；侧栏只负责切换当前查看的团队。</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭团队中心">
            <X size={18} />
          </button>
        </header>
        {error !== undefined && <div className="skill-center-error">{error}</div>}
        <div className="team-center-content">
          <section className="team-center-panel" aria-labelledby="my-teams-heading">
            <div className="team-center-panel-heading">
              <div>
                <h3 id="my-teams-heading">我的团队</h3>
                <p>选择后，侧栏团队任务栏会展示该团队。</p>
              </div>
              <button
                type="button"
                className="team-center-refresh"
                disabled={loading}
                onClick={() => void onRefresh()}
              >
                <RefreshCw className={loading ? "spin" : undefined} size={14} /> 刷新
              </button>
            </div>
            {teams.length === 0 ? (
              <div className="team-center-empty">你还没有加入任何团队。</div>
            ) : (
              <div className="team-center-list">
                {teams.map((team) => (
                  <article
                    key={team.id}
                    className={team.id === selectedTeamId ? "selected" : undefined}
                  >
                    <button type="button" onClick={() => onSelectTeam(team.id)}>
                      <span>{team.displayName}</span>
                      <small>{team.role}</small>
                    </button>
                    <button type="button" onClick={() => onManage(team.id)}>
                      管理
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>
          <section className="team-center-panel team-center-actions" aria-label="创建或加入团队">
            <div>
              <h3>创建团队</h3>
              <p>创建后会成为 Owner，并自动成为侧栏当前团队。</p>
              <form onSubmit={(event) => void submit(event)}>
                <input
                  value={displayName}
                  maxLength={200}
                  placeholder="团队名称"
                  onChange={(event) => setDisplayName(event.target.value)}
                />
                <button type="submit" disabled={!displayName.trim() || submitting}>
                  <Plus size={14} /> {submitting ? "创建中…" : "创建团队"}
                </button>
              </form>
            </div>
            <div className="team-center-join">
              <h3>加入团队</h3>
              <p>请让团队 Owner 或管理员通过你的用户 ID 添加成员。受邀后在这里刷新即可。</p>
              <button type="button" disabled={loading} onClick={() => void onRefresh()}>
                <RefreshCw className={loading ? "spin" : undefined} size={14} /> 刷新加入状态
              </button>
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

export function TeamManagementDialog({
  api,
  team,
  onDissolved,
  onClose,
}: {
  readonly api: TeamWorkspaceApi;
  readonly team: TeamSummary;
  readonly onDissolved: () => void;
  readonly onClose: () => void;
}) {
  const [members, setMembers] = useState<readonly TeamMember[]>([]);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [personalization, setPersonalization] = useState<TeamPersonalization>();
  const [personalizationContent, setPersonalizationContent] = useState("");
  const [savingPersonalization, setSavingPersonalization] = useState(false);
  const personalizationLimit = personalizationSize(personalizationContent);
  const personalizationTooLarge =
    personalizationLimit.characters > 2_000 || personalizationLimit.bytes > 8 * 1_024;

  useEffect(() => {
    let stopped = false;
    const personalizationRequest = api.getTeamPersonalization?.(team.id);
    void Promise.all([
      api.listTeamMembers(team.id),
      personalizationRequest ?? Promise.resolve(undefined),
    ])
      .then(([items, setting]) => {
        if (!stopped) {
          setMembers(items);
          if (setting !== undefined) {
            setPersonalization(setting);
            setPersonalizationContent(setting.content);
          }
        }
      })
      .catch((reason: unknown) => {
        if (!stopped) setError(reason instanceof ApiError ? reason.message : "加载团队成员失败");
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [api, team.id]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!userId.trim()) return;
    try {
      const member = await api.addTeamMember(team.id, userId.trim(), role);
      setMembers((current) => [...current, member]);
      setUserId("");
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "添加成员失败");
    }
  };

  const savePersonalization = async () => {
    if (
      personalization === undefined ||
      api.updateTeamPersonalization === undefined ||
      !personalization.canEdit ||
      personalizationTooLarge ||
      savingPersonalization
    ) {
      return;
    }
    setSavingPersonalization(true);
    try {
      const value = await api.updateTeamPersonalization(team.id, {
        content: personalizationContent,
        expectedVersion: personalization.version,
      });
      setPersonalization(value);
      setPersonalizationContent(value.content);
      setError(undefined);
    } catch (reason) {
      setError(
        reason instanceof ApiError && reason.status === 409
          ? "团队个性化已被其他管理员更新，请关闭后重新打开。"
          : reason instanceof ApiError
            ? reason.message
            : "保存团队个性化失败",
      );
    } finally {
      setSavingPersonalization(false);
    }
  };

  return (
    <div className="skill-center-backdrop">
      <section className="team-management-dialog" role="dialog" aria-modal="true">
        <header>
          <div>
            <h2>{team.displayName}</h2>
            <p className="team-management-subtitle">成员、角色和团队生命周期</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭团队管理">
            <X size={18} />
          </button>
        </header>
        {error !== undefined && <div className="skill-center-error">{error}</div>}
        {personalization !== undefined && (
          <section
            className="team-personalization-settings"
            aria-labelledby="team-personalization-heading"
          >
            <div>
              <h3 id="team-personalization-heading">团队个性化</h3>
              <p>用于该团队之后发起的任务；当前任务要求可以覆盖这些偏好。</p>
            </div>
            <textarea
              rows={6}
              value={personalizationContent}
              readOnly={!personalization.canEdit}
              placeholder="例如团队默认技术栈、语言和协作习惯…"
              onChange={(event) => setPersonalizationContent(event.target.value)}
            />
            <div className="team-personalization-actions">
              <small className={personalizationTooLarge ? "invalid" : undefined}>
                {personalizationLimit.characters} / 2000 字符
              </small>
              {personalization.canEdit ? (
                <button
                  type="button"
                  disabled={savingPersonalization || personalizationTooLarge}
                  onClick={() => void savePersonalization()}
                >
                  {savingPersonalization ? "保存中…" : "保存团队个性化"}
                </button>
              ) : (
                <small>普通成员可查看，Owner 或管理员可以修改。</small>
              )}
            </div>
          </section>
        )}
        {team.role === "member" ? (
          <p className="team-management-readonly">
            普通成员可查看名单，成员变更由 Owner 或管理员处理。
          </p>
        ) : (
          <form className="team-member-add" onSubmit={(event) => void add(event)}>
            <input
              value={userId}
              placeholder="用户 ID"
              onChange={(event) => setUserId(event.target.value)}
            />
            <select value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
              <option value="member">成员</option>
              <option value="admin">管理员</option>
            </select>
            <button type="submit">添加</button>
          </form>
        )}
        <div className="team-member-list">
          {loading ? (
            <p>正在加载成员…</p>
          ) : (
            members.map((member) => (
              <article key={member.userId}>
                <span>
                  <strong>{member.userId}</strong>
                  <small>{new Date(member.joinedAt).toLocaleDateString("zh-CN")}</small>
                </span>
                <select
                  value={member.role}
                  disabled={
                    team.role === "member" || (team.role === "admin" && member.role !== "member")
                  }
                  onChange={(event) => {
                    const nextRole = event.target.value as TeamMember["role"];
                    void api
                      .changeTeamMemberRole(team.id, member.userId, nextRole)
                      .then((updated) =>
                        setMembers((current) =>
                          current.map((item) => (item.userId === updated.userId ? updated : item)),
                        ),
                      )
                      .catch((reason: unknown) =>
                        setError(reason instanceof ApiError ? reason.message : "修改角色失败"),
                      );
                  }}
                >
                  <option value="owner" disabled={team.role !== "owner"}>
                    Owner
                  </option>
                  <option value="admin">管理员</option>
                  <option value="member">成员</option>
                </select>
                <button
                  type="button"
                  disabled={team.role === "member"}
                  onClick={() => {
                    if (!window.confirm(`确认移除 ${member.userId}？`)) return;
                    void api
                      .removeTeamMember(team.id, member.userId)
                      .then(() =>
                        setMembers((current) =>
                          current.filter((item) => item.userId !== member.userId),
                        ),
                      )
                      .catch((reason: unknown) =>
                        setError(
                          reason instanceof ApiError
                            ? reason.message
                            : "移除失败；最后一名 Owner 应改为解散团队",
                        ),
                      );
                  }}
                >
                  移除
                </button>
              </article>
            ))
          )}
        </div>
        {team.role === "owner" && (
          <footer>
            <button
              type="button"
              className="danger-button"
              onClick={() => {
                if (!window.confirm(`解散“${team.displayName}”？团队云盘将不再可访问。`)) return;
                void api
                  .dissolveTeam(team.id)
                  .then(onDissolved)
                  .catch((reason: unknown) =>
                    setError(reason instanceof ApiError ? reason.message : "解散团队失败"),
                  );
              }}
            >
              解散团队
            </button>
          </footer>
        )}
      </section>
    </div>
  );
}

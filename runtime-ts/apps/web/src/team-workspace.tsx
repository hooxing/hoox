import { ChevronDown, ChevronRight, Plus, Settings, Users, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, type TeamMember, type TeamSummary } from "./api.js";

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
}

export function TeamSwitcher({
  teams,
  activeTeamId,
  loading,
  onSwitch,
  onCreate,
  onNewTeamThread,
  onManage,
}: {
  readonly teams: readonly TeamSummary[];
  readonly activeTeamId?: string;
  readonly loading: boolean;
  readonly onSwitch: (teamId: string | undefined) => void;
  readonly onCreate: (displayName: string) => Promise<void>;
  readonly onNewTeamThread: () => void;
  readonly onManage: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const active = teams.find((team) => team.id === activeTeamId);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!displayName.trim()) return;
    await onCreate(displayName.trim());
    setDisplayName("");
    setCreating(false);
    setExpanded(true);
  };

  return (
    <section className="team-switcher" aria-label="团队空间">
      <button
        type="button"
        className="team-switcher-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <Users size={17} />
        <span>{active?.displayName ?? "团队"}</span>
        {active !== undefined && <small>{active.role}</small>}
      </button>
      {expanded && (
        <div className="team-switcher-body">
          <label>
            <span className="sr-only">切换团队</span>
            <select
              value={activeTeamId ?? ""}
              disabled={loading}
              onChange={(event) => onSwitch(event.target.value || undefined)}
            >
              <option value="">个人空间</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.displayName}
                </option>
              ))}
            </select>
          </label>
          {active !== undefined && (
            <div className="team-switcher-actions">
              <button type="button" onClick={onNewTeamThread}>
                <Plus size={14} /> 新建团队对话
              </button>
              <button type="button" onClick={onManage} aria-label="管理当前团队">
                <Settings size={14} /> 管理
              </button>
            </div>
          )}
          {creating ? (
            <form className="team-create-form" onSubmit={(event) => void submit(event)}>
              <input
                value={displayName}
                maxLength={200}
                placeholder="团队名称"
                onChange={(event) => setDisplayName(event.target.value)}
              />
              <button type="submit" disabled={!displayName.trim()}>
                创建
              </button>
            </form>
          ) : (
            <button type="button" className="team-create-trigger" onClick={() => setCreating(true)}>
              <Plus size={14} /> 创建团队
            </button>
          )}
        </div>
      )}
    </section>
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

  useEffect(() => {
    let stopped = false;
    void api
      .listTeamMembers(team.id)
      .then((items) => {
        if (!stopped) setMembers(items);
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

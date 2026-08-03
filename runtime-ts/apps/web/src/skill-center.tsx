import { Check, LoaderCircle, Search, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, type RuntimeApi, type SkillCatalogItem, type SkillInstallation } from "./api.js";

export interface SkillCenterDialogProps {
  readonly api: SkillCenterApi;
  readonly onClose: () => void;
}

export type SkillCenterApi = Pick<
  RuntimeApi,
  "listSkills" | "listInstalledSkills" | "installSkill" | "setSkillEnabled" | "uninstallSkill"
>;

export function SkillCenterDialog({ api, onClose }: SkillCenterDialogProps) {
  const [skills, setSkills] = useState<readonly SkillCatalogItem[]>([]);
  const [installations, setInstallations] = useState<readonly SkillInstallation[]>([]);
  const [query, setQuery] = useState("");
  const [invocationNames, setInvocationNames] = useState<Readonly<Record<string, string>>>({});
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState<string>();
  const [error, setError] = useState<string>();

  const installedByKey = useMemo(
    () => new Map(installations.map((installation) => [installation.canonicalKey, installation])),
    [installations],
  );

  const load = useCallback(
    async (search: string) => {
      setLoading(true);
      setError(undefined);
      try {
        const [catalog, installed] = await Promise.all([
          api.listSkills(search),
          api.listInstalledSkills(),
        ]);
        setSkills(catalog.items);
        setInstallations(installed);
      } catch (reason) {
        setError(reason instanceof ApiError ? reason.message : "技能中心暂时不可用");
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void load("");
  }, [load]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    void load(query);
  };

  const install = async (skill: SkillCatalogItem) => {
    setMutating(skill.canonicalKey);
    setError(undefined);
    try {
      const installed = await api.installSkill(
        skill.canonicalKey,
        invocationNames[skill.canonicalKey] ?? skill.canonicalKey,
      );
      setInstallations((current) =>
        [...current.filter((item) => item.canonicalKey !== installed.canonicalKey), installed].sort(
          (left, right) => left.invocationName.localeCompare(right.invocationName),
        ),
      );
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "安装技能失败");
    } finally {
      setMutating(undefined);
    }
  };

  const setEnabled = async (installation: SkillInstallation, enabled: boolean) => {
    setMutating(installation.canonicalKey);
    setError(undefined);
    try {
      const updated = await api.setSkillEnabled(installation, enabled);
      setInstallations((current) =>
        current.map((item) => (item.canonicalKey === updated.canonicalKey ? updated : item)),
      );
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "更新技能失败");
    } finally {
      setMutating(undefined);
    }
  };

  const uninstall = async (installation: SkillInstallation) => {
    setMutating(installation.canonicalKey);
    setError(undefined);
    try {
      await api.uninstallSkill(installation);
      setInstallations((current) =>
        current.filter((item) => item.canonicalKey !== installation.canonicalKey),
      );
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "卸载技能失败");
    } finally {
      setMutating(undefined);
    }
  };

  return (
    <div className="skill-center-backdrop">
      <section
        className="skill-center-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-center-title"
      >
        <header className="skill-center-header">
          <div>
            <h2 id="skill-center-title">技能中心</h2>
            <p>安装后的技能与当前用户关联，可在所有任务中使用。</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭技能中心">
            <X size={18} />
          </button>
        </header>

        <form className="skill-search" onSubmit={submitSearch}>
          <Search size={17} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索技能"
            aria-label="搜索技能"
          />
          <button type="submit">搜索</button>
        </form>

        {error !== undefined && (
          <div className="skill-center-error" role="alert">
            {error}
          </div>
        )}

        <div className="skill-center-list">
          {loading ? (
            <div className="skill-center-empty">
              <LoaderCircle className="spin" size={20} /> 正在加载技能
            </div>
          ) : skills.length === 0 ? (
            <div className="skill-center-empty">没有找到可安装的技能。</div>
          ) : (
            skills.map((skill) => {
              const installed = installedByKey.get(skill.canonicalKey);
              const busy = mutating === skill.canonicalKey;
              return (
                <article className="skill-card" key={skill.canonicalKey}>
                  <div className="skill-card-main">
                    <div className="skill-card-title">
                      <h3>{skill.displayName}</h3>
                      {skill.securityStatus === "verified" && (
                        <span className="skill-verified" title="已验证">
                          <ShieldCheck size={15} /> 已验证
                        </span>
                      )}
                    </div>
                    <p>{skill.description}</p>
                    <small>
                      {skill.publisher} · {skill.recommendedVersion} · {skill.compatibility}
                    </small>
                    {installed !== undefined && (
                      <div className="skill-installation-meta">
                        <Check size={14} /> /{installed.invocationName} ·{" "}
                        {installed.status === "enabled" ? "已启用" : "已停用"}
                      </div>
                    )}
                    {installed === undefined && (
                      <label className="skill-invocation-input">
                        <span>/</span>
                        <input
                          value={invocationNames[skill.canonicalKey] ?? skill.canonicalKey}
                          onChange={(event) =>
                            setInvocationNames((current) => ({
                              ...current,
                              [skill.canonicalKey]: event.target.value,
                            }))
                          }
                          aria-label={`${skill.displayName}调用名称`}
                          maxLength={128}
                        />
                      </label>
                    )}
                  </div>
                  <div className="skill-card-actions">
                    {installed === undefined ? (
                      <button type="button" disabled={busy} onClick={() => void install(skill)}>
                        {busy ? "安装中" : "安装"}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void setEnabled(installed, installed.status !== "enabled")}
                        >
                          {installed.status === "enabled" ? "停用" : "启用"}
                        </button>
                        <button
                          type="button"
                          className="danger-text"
                          disabled={busy}
                          onClick={() => void uninstall(installed)}
                        >
                          卸载
                        </button>
                      </>
                    )}
                  </div>
                </article>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

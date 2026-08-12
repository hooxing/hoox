import { X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, type PersonalPersonalization } from "./api.js";

export interface PersonalizationApi {
  getPersonalPersonalization(): Promise<PersonalPersonalization>;
  updatePersonalPersonalization(input: {
    readonly content: string;
    readonly applyToTeamTasks: boolean;
    readonly expectedVersion: number;
  }): Promise<PersonalPersonalization>;
}

const MAX_CHARACTERS = 2_000;
const MAX_BYTES = 8 * 1_024;

export function personalizationSize(content: string) {
  return Object.freeze({
    characters: Array.from(content).length,
    bytes: new TextEncoder().encode(content).byteLength,
  });
}

export function PersonalizationDialog({
  api,
  hasTeams,
  onClose,
}: {
  readonly api: PersonalizationApi;
  readonly hasTeams: boolean;
  readonly onClose: () => void;
}) {
  const [setting, setSetting] = useState<PersonalPersonalization>();
  const [content, setContent] = useState("");
  const [applyToTeamTasks, setApplyToTeamTasks] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const size = personalizationSize(content);
  const tooLarge = size.characters > MAX_CHARACTERS || size.bytes > MAX_BYTES;

  useEffect(() => {
    let stopped = false;
    void api
      .getPersonalPersonalization()
      .then((value) => {
        if (stopped) return;
        setSetting(value);
        setContent(value.content);
        setApplyToTeamTasks(value.applyToTeamTasks);
      })
      .catch((reason: unknown) => {
        if (!stopped) setError(reason instanceof ApiError ? reason.message : "加载个性化设置失败");
      });
    return () => {
      stopped = true;
    };
  }, [api]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (setting === undefined || saving || tooLarge) return;
    setSaving(true);
    try {
      const value = await api.updatePersonalPersonalization({
        content,
        applyToTeamTasks,
        expectedVersion: setting.version,
      });
      setSetting(value);
      setContent(value.content);
      setApplyToTeamTasks(value.applyToTeamTasks);
      setError(undefined);
    } catch (reason) {
      setError(
        reason instanceof ApiError && reason.status === 409
          ? "设置已在其他窗口更新，请关闭后重新打开。"
          : reason instanceof ApiError
            ? reason.message
            : "保存个性化设置失败",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="skill-center-backdrop">
      <section className="personalization-dialog" role="dialog" aria-modal="true">
        <header className="skill-center-header">
          <div>
            <h2>个性化</h2>
            <p>这些长期偏好会自动用于你之后发起的任务，并可被当前任务要求覆盖。</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭个性化">
            <X size={18} />
          </button>
        </header>
        {error !== undefined && <div className="skill-center-error">{error}</div>}
        {setting === undefined ? (
          <p className="personalization-loading">正在加载个性化设置…</p>
        ) : (
          <form onSubmit={(event) => void save(event)}>
            <label className="personalization-field">
              <strong>自定义指令</strong>
              <span>例如偏好的语言、表达方式、技术栈或工作习惯。</span>
              <textarea
                value={content}
                rows={11}
                placeholder="添加自定义指令…"
                onChange={(event) => setContent(event.target.value)}
              />
            </label>
            <div className={`personalization-count ${tooLarge ? "invalid" : ""}`}>
              {size.characters} / {MAX_CHARACTERS} 字符
              {size.bytes > MAX_BYTES && `，UTF-8 内容超过 ${MAX_BYTES} 字节`}
            </div>
            {hasTeams && (
              <label className="personalization-team-toggle">
                <input
                  type="checkbox"
                  checked={applyToTeamTasks}
                  onChange={(event) => setApplyToTeamTasks(event.target.checked)}
                />
                <span>
                  <strong>应用于团队任务</strong>
                  <small>开启后，你在团队中发起的任务会同时携带个人和团队个性化。</small>
                </span>
              </label>
            )}
            <footer>
              <button type="button" onClick={onClose}>
                取消
              </button>
              <button type="submit" disabled={saving || tooLarge}>
                {saving ? "保存中…" : "保存"}
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}

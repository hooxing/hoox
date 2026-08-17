import { CalendarClock, LoaderCircle, Pause, Play, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ApiError,
  type CreateScheduledTaskInput,
  type RuntimeApi,
  type ScheduledTask,
  type Thread,
  type UpdateScheduledTaskInput,
} from "./api.js";

export type AutomationCenterApi = Pick<
  RuntimeApi,
  "listScheduledTasks" | "createScheduledTask" | "updateScheduledTask"
>;

export interface AutomationCenterDialogProps {
  readonly api: AutomationCenterApi;
  readonly threads: readonly Thread[];
  readonly initialThreadId?: string;
  readonly onClose: () => void;
}

function localDateTime(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function scheduleText(task: ScheduledTask): string {
  const next =
    task.nextRunAt === undefined ? "无后续执行" : new Date(task.nextRunAt).toLocaleString();
  if (task.rrule === undefined) return next;
  const match = /^FREQ=(MINUTELY|HOURLY|DAILY);INTERVAL=(\d+)$/u.exec(task.rrule);
  if (match === null) return `${next} · ${task.rrule}`;
  const unit = match[1] === "MINUTELY" ? "分钟" : match[1] === "HOURLY" ? "小时" : "天";
  return `${next} · 每 ${match[2]} ${unit}`;
}

export function AutomationCenterDialog({
  api,
  threads,
  initialThreadId,
  onClose,
}: AutomationCenterDialogProps) {
  const activeThreads = useMemo(
    () => threads.filter((thread) => thread.status === "active"),
    [threads],
  );
  const [tasks, setTasks] = useState<readonly ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState<string>();
  const [error, setError] = useState<string>();
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [threadId, setThreadId] = useState(initialThreadId ?? activeThreads[0]?.id ?? "");
  const [firstRunAt, setFirstRunAt] = useState(localDateTime(new Date(Date.now() + 3_600_000)));
  const [repeat, setRepeat] = useState<"none" | "hourly" | "daily">("none");

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setTasks(await api.listScheduledTasks());
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "定时任务暂时不可用");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (threadId === "") {
      setError("请先创建一个任务对话");
      return;
    }
    setMutating("create");
    setError(undefined);
    const input: CreateScheduledTaskInput = {
      targetThreadId: threadId,
      name,
      instruction,
      firstRunAt: new Date(firstRunAt).toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      ...(repeat === "none"
        ? {}
        : { rrule: repeat === "hourly" ? "FREQ=HOURLY;INTERVAL=1" : "FREQ=DAILY;INTERVAL=1" }),
    };
    try {
      const created = await api.createScheduledTask(input);
      setTasks((current) => [created, ...current]);
      setName("");
      setInstruction("");
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "创建定时任务失败");
    } finally {
      setMutating(undefined);
    }
  };

  const mutate = async (task: ScheduledTask, input: UpdateScheduledTaskInput) => {
    setMutating(task.id);
    setError(undefined);
    try {
      const updated = await api.updateScheduledTask(task.id, input);
      setTasks((current) =>
        input.action === "delete"
          ? current.filter((item) => item.id !== task.id)
          : current.map((item) => (item.id === task.id ? updated : item)),
      );
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "更新定时任务失败");
    } finally {
      setMutating(undefined);
    }
  };

  return (
    <div className="skill-center-backdrop automation-center-backdrop">
      <section
        className="skill-center-dialog automation-center-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="automation-center-title"
      >
        <header className="skill-center-header">
          <div>
            <h2 id="automation-center-title">定时任务</h2>
            <p>到期后向所选任务对话追加指令，并复用该对话的 Sandbox 与 Workspace。</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭定时任务">
            <X size={18} />
          </button>
        </header>

        <form className="automation-create-form" onSubmit={(event) => void create(event)}>
          <label>
            名称
            <input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：每日项目摘要"
            />
          </label>
          <label>
            目标任务
            <select required value={threadId} onChange={(event) => setThreadId(event.target.value)}>
              <option value="">请选择</option>
              {activeThreads.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title}
                </option>
              ))}
            </select>
          </label>
          <label className="automation-instruction">
            执行指令
            <textarea
              required
              maxLength={16_384}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="描述每次到期后 Agent 要完成的工作"
            />
          </label>
          <label>
            首次执行
            <input
              required
              type="datetime-local"
              value={firstRunAt}
              onChange={(event) => setFirstRunAt(event.target.value)}
            />
          </label>
          <label>
            重复
            <select
              value={repeat}
              onChange={(event) => setRepeat(event.target.value as typeof repeat)}
            >
              <option value="none">仅一次</option>
              <option value="hourly">每小时</option>
              <option value="daily">每天</option>
            </select>
          </label>
          <button type="submit" disabled={mutating === "create" || activeThreads.length === 0}>
            {mutating === "create" ? "创建中" : "创建定时任务"}
          </button>
        </form>

        {error !== undefined && (
          <div className="skill-center-error" role="alert">
            {error}
          </div>
        )}
        <div className="automation-list">
          {loading ? (
            <div className="skill-center-empty">
              <LoaderCircle className="spin" size={20} /> 正在加载定时任务
            </div>
          ) : tasks.length === 0 ? (
            <div className="skill-center-empty">
              <CalendarClock size={20} /> 暂无定时任务
            </div>
          ) : (
            tasks.map((task) => (
              <article className="automation-card" key={task.id}>
                <div>
                  <div className="automation-card-title">
                    <h3>{task.name}</h3>
                    <span data-status={task.status}>
                      {task.status === "active"
                        ? "运行中"
                        : task.status === "paused"
                          ? "已暂停"
                          : "已完成"}
                    </span>
                  </div>
                  <p>{task.instruction}</p>
                  <small>{scheduleText(task)}</small>
                </div>
                <div className="automation-card-actions">
                  {task.status === "active" && (
                    <button
                      type="button"
                      disabled={mutating === task.id}
                      onClick={() => void mutate(task, { action: "pause" })}
                    >
                      <Pause size={15} />
                      暂停
                    </button>
                  )}
                  {task.status === "paused" && (
                    <button
                      type="button"
                      disabled={mutating === task.id}
                      onClick={() => void mutate(task, { action: "resume" })}
                    >
                      <Play size={15} />
                      恢复
                    </button>
                  )}
                  <button
                    type="button"
                    className="danger-text"
                    disabled={mutating === task.id}
                    onClick={() => void mutate(task, { action: "delete" })}
                  >
                    <Trash2 size={15} />
                    删除
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

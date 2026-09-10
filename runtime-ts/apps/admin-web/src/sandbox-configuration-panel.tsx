import type {
  PublishSandboxRoutingRequest,
  SandboxControlDto,
  SaveSandboxProfileRequest,
} from "@hoox/protocol";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { AdminApiError } from "./api.js";
import { AdminControlApi } from "./control-api.js";

type SandboxApi = Pick<
  AdminControlApi,
  "sandboxOverview" | "saveSandboxProfile" | "publishSandboxRouting" | "probeSandboxProfile"
>;
const defaultApi = new AdminControlApi();
const providers = [
  { key: "cube", label: "CubeSandbox" },
  { key: "e2b", label: "E2B" },
  { key: "tencent-ags", label: "腾讯云 AGS" },
] as const;
type ProviderKey = (typeof providers)[number]["key"];
type Target = PublishSandboxRoutingRequest["configuration"]["targets"][number];
const fields = [
  ["sessionTtlSeconds", "实例存活时间（秒）", 1, 86400, 3600],
  ["operationTimeoutMs", "操作超时（毫秒）", 1000, 600000, 60000],
  ["lifecycleTimeoutMs", "创建与恢复超时（毫秒）", 1000, 90000, 90000],
  ["pausedRetentionSeconds", "暂停保留时间（秒）", 0, 2592000, 86400],
] as const;

export function SandboxConfigurationPanel({ api = defaultApi }: { api?: SandboxApi }) {
  const [data, setData] = useState<SandboxControlDto>();
  const [providerKey, setProviderKey] = useState<ProviderKey>("tencent-ags");
  const [targets, setTargets] = useState<Target[]>([]);
  const [mode, setMode] = useState<"single" | "weighted">("single");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const refresh = useCallback(
    async (preserveRouting = false) => {
      const next = await api.sandboxOverview();
      setData(next);
      if (!preserveRouting) {
        setTargets(next.routing?.targets ?? []);
        setMode(next.routing?.mode ?? "single");
      }
    },
    [api],
  );
  const fail = useCallback(
    (reason: unknown) =>
      setError(reason instanceof AdminApiError ? reason.message : "操作未完成，请刷新后重试。"),
    [],
  );
  useEffect(() => {
    let active = true;
    void api.sandboxOverview().then(
      (next) => {
        if (active) {
          setData(next);
          setTargets(next.routing?.targets ?? []);
          setMode(next.routing?.mode ?? "single");
        }
      },
      (reason) => {
        if (active) fail(reason);
      },
    );
    return () => {
      active = false;
    };
  }, [api, fail]);
  const latest = data?.profiles.find((item) => item.configuration.providerKey === providerKey);
  const configured = latest?.configuration;
  const perform = async (operation: () => Promise<string>, preserveRouting = false) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await operation();
      await refresh(preserveRouting);
      setMessage(result);
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  };
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!data) return;
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim();
    const apiKey = String(form.get("apiKey") ?? "");
    const policy = {
      templateId: text("templateId"),
      sessionTtlSeconds: Number(form.get("sessionTtlSeconds")),
      operationTimeoutMs: Number(form.get("operationTimeoutMs")),
      lifecycleTimeoutMs: Number(form.get("lifecycleTimeoutMs")),
      pausedRetentionSeconds: Number(form.get("pausedRetentionSeconds")),
      idleAction: text("idleAction") === "kill" ? ("kill" as const) : ("pause" as const),
    };
    const input: SaveSandboxProfileRequest = {
      expectedGeneration: data.generation,
      configuration: {
        providerKey,
        displayName: text("displayName"),
        endpoint: text("endpoint"),
        ...(providerKey === "cube" && text("proxyHost")
          ? {
              cubeProxy: {
                host: text("proxyHost"),
                port: Number(form.get("proxyPort")),
                scheme: text("proxyScheme") === "https" ? ("https" as const) : ("http" as const),
              },
            }
          : {}),
        policy,
      },
      ...(apiKey
        ? { apiKey }
        : latest?.configuration.credentialConfigured
          ? { reuseCredentialFromRevision: latest.revision }
          : {}),
    };
    void perform(async () => {
      await api.saveSandboxProfile(input);
      return "配置已保存。测试通过后可加入分配。";
    });
  };
  const targetHealthy = (target: Target) =>
    data?.profiles.some(
      (item) =>
        item.configuration.providerKey === target.providerKey &&
        item.revision === target.profileRevision &&
        item.probeStatus === "healthy",
    ) === true;
  return (
    <div className="sandbox-configuration">
      <header className="control-page-header">
        <div>
          <h1>沙箱服务</h1>
          <p>切换供应商、分配新实例并设置各供应商的运行策略。</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void perform(async () => "配置已刷新。")}
        >
          刷新
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {!data ? (
        <p>{error ? "暂时无法读取配置，请刷新重试。" : "正在读取沙箱配置…"}</p>
      ) : (
        <>
          <section className="control-panel" aria-label="沙箱分配">
            <h2>新实例分配</h2>
            <p>
              {data.routing
                ? "已有会话继续使用创建时的供应商和策略。"
                : "尚未发布后台配置，当前沿用部署配置。"}
            </p>
            <fieldset disabled={busy}>
              <label>
                分配方式
                <select
                  aria-label="分配方式"
                  value={mode}
                  onChange={(event) => {
                    const next = event.target.value === "single" ? "single" : "weighted";
                    setMode(next);
                    if (next === "single") setTargets(targets.slice(0, 1));
                  }}
                >
                  <option value="single">单供应商</option>
                  <option value="weighted">按权重分配</option>
                </select>
              </label>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>参与分配</th>
                      <th>供应商</th>
                      <th>使用配置</th>
                      <th>权重</th>
                      <th>验证</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providers.map((provider) => {
                      const versions = data.profiles.filter(
                        (item) => item.configuration.providerKey === provider.key,
                      );
                      const target = targets.find((item) => item.providerKey === provider.key);
                      const selected =
                        versions.find((item) => item.revision === target?.profileRevision) ??
                        versions[0];
                      return (
                        <tr key={provider.key}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`启用 ${provider.label}`}
                              checked={target !== undefined}
                              disabled={!selected}
                              onChange={(event) => {
                                if (!selected) return;
                                const rest = targets.filter(
                                  (item) => item.providerKey !== provider.key,
                                );
                                setTargets(
                                  event.target.checked
                                    ? [
                                        ...(mode === "single" ? [] : rest),
                                        {
                                          providerKey: provider.key,
                                          profileRevision: selected.revision,
                                          weight: 1,
                                        },
                                      ]
                                    : rest,
                                );
                              }}
                            />
                          </td>
                          <td>{provider.label}</td>
                          <td>
                            {selected ? (
                              <select
                                aria-label={`${provider.label} 配置版本`}
                                value={selected.revision}
                                onChange={(event) =>
                                  setTargets(
                                    targets.map((item) =>
                                      item.providerKey === provider.key
                                        ? { ...item, profileRevision: Number(event.target.value) }
                                        : item,
                                    ),
                                  )
                                }
                                disabled={!target}
                              >
                                {versions.map((version) => (
                                  <option key={version.revision} value={version.revision}>
                                    版本 {version.revision} ·{" "}
                                    {version.configuration.policy.templateId}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              "尚未配置"
                            )}
                          </td>
                          <td>
                            <input
                              aria-label={`${provider.label} 权重`}
                              type="number"
                              min={1}
                              max={1000}
                              value={target?.weight ?? 1}
                              disabled={!target || mode === "single"}
                              onChange={(event) =>
                                setTargets(
                                  targets.map((item) =>
                                    item.providerKey === provider.key
                                      ? { ...item, weight: Number(event.target.value) }
                                      : item,
                                  ),
                                )
                              }
                            />
                          </td>
                          <td>
                            {selected && (
                              <>
                                <span>
                                  {selected.probeStatus === "healthy"
                                    ? "通过"
                                    : selected.probeStatus === "failed"
                                      ? "失败"
                                      : "未测试"}
                                </span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void perform(async () => {
                                      const result = await api.probeSandboxProfile(
                                        provider.key,
                                        selected.revision,
                                      );
                                      return result.healthy
                                        ? `连接测试通过，耗时 ${(result.durationMs / 1000).toFixed(1)} 秒。`
                                        : "连接测试失败，请检查地址、密钥和模板。";
                                    }, true)
                                  }
                                >
                                  测试连接
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p>
                权重决定新实例的分配比例。例如 1:3 约为
                25%:75%；运行中的会话不会迁移。测试会创建并释放临时实例。
              </p>
              <button
                type="button"
                className="primary-button"
                disabled={
                  targets.length === 0 ||
                  !targets.every(targetHealthy) ||
                  targets.some(
                    (target) =>
                      !Number.isInteger(target.weight) || target.weight < 1 || target.weight > 1000,
                  )
                }
                onClick={() =>
                  void perform(async () => {
                    await api.publishSandboxRouting({
                      expectedGeneration: data.generation,
                      configuration: { mode, targets },
                    });
                    return "分配配置已生效，新建实例开始使用。";
                  })
                }
              >
                应用分配
              </button>
            </fieldset>
          </section>
          <section className="control-panel" aria-label="供应商运行策略">
            <h2>供应商配置</h2>
            <label>
              供应商
              <select
                aria-label="编辑供应商"
                value={providerKey}
                disabled={busy}
                onChange={(event) => setProviderKey(event.target.value as ProviderKey)}
              >
                {providers.map((provider) => (
                  <option key={provider.key} value={provider.key}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </label>
            <form key={`${providerKey}-${latest?.revision ?? 0}`} onSubmit={save}>
              <fieldset disabled={busy}>
                <div className="form-grid">
                  <label>
                    名称
                    <input
                      name="displayName"
                      required
                      maxLength={120}
                      defaultValue={
                        configured?.displayName ??
                        providers.find((provider) => provider.key === providerKey)?.label
                      }
                    />
                  </label>
                  <label>
                    {providerKey === "cube" ? "服务地址" : "服务域名"}
                    <input
                      name="endpoint"
                      required
                      maxLength={2048}
                      defaultValue={configured?.endpoint ?? ""}
                      placeholder={
                        providerKey === "cube"
                          ? "https://sandbox.example.test"
                          : "sandbox.example.test"
                      }
                    />
                  </label>
                  <label>
                    API Key
                    <input
                      name="apiKey"
                      type="password"
                      autoComplete="new-password"
                      placeholder={
                        configured?.credentialConfigured ? "已配置，留空保留" : "输入供应商密钥"
                      }
                      required={providerKey !== "cube" && !configured?.credentialConfigured}
                    />
                  </label>
                  <label>
                    模板
                    <input
                      name="templateId"
                      required
                      maxLength={255}
                      defaultValue={configured?.policy.templateId ?? ""}
                    />
                  </label>
                  {fields.map(([name, label, min, max, fallback]) => (
                    <label key={name}>
                      {label}
                      <input
                        name={name}
                        type="number"
                        min={min}
                        max={max}
                        required
                        defaultValue={configured?.policy[name] ?? fallback}
                      />
                    </label>
                  ))}
                  {providerKey === "cube" && (
                    <>
                      <label>
                        代理主机（可选）
                        <input
                          name="proxyHost"
                          maxLength={253}
                          defaultValue={configured?.cubeProxy?.host ?? ""}
                          placeholder="proxy.example.test"
                        />
                      </label>
                      <label>
                        代理端口
                        <input
                          name="proxyPort"
                          type="number"
                          min={1}
                          max={65535}
                          defaultValue={configured?.cubeProxy?.port ?? 80}
                        />
                      </label>
                      <label>
                        代理协议
                        <select
                          name="proxyScheme"
                          defaultValue={configured?.cubeProxy?.scheme ?? "http"}
                        >
                          <option value="http">HTTP</option>
                          <option value="https">HTTPS</option>
                        </select>
                      </label>
                    </>
                  )}
                  <label>
                    任务结束后的空闲策略
                    <select
                      name="idleAction"
                      defaultValue={configured?.policy.idleAction ?? "pause"}
                    >
                      <option value="pause">暂停，后续任务恢复</option>
                      <option value="kill">销毁，后续任务重新创建</option>
                    </select>
                  </label>
                </div>
                <p>
                  保存会生成新版本。已创建实例仍按原版本恢复和清理；修改后需重新测试并应用分配。
                </p>
                <button className="primary-button" type="submit">
                  保存配置
                </button>
              </fieldset>
            </form>
          </section>
        </>
      )}
    </div>
  );
}

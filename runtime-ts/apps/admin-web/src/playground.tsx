import type { AdminAgentDefinitionList } from "@hoox/protocol";
import { Alert, Button, Empty, Input, Spin } from "antd";
import { type FormEvent, useId, useRef, useState } from "react";
import { agentStatusLabels, useAgentDefinitions, useAgentHistory } from "./agent-definitions.js";
import type { AgentDefinitionApiContract } from "./control-api.js";
import { startPlaygroundRun, type PlaygroundReceipt } from "./playground-api.js";
import { RunExplorerDetail } from "./run-explorer.js";
import type { RunExplorerApiContract } from "./run-explorer-api.js";

type PlaygroundProps = {
  readonly agentApi: AgentDefinitionApiContract;
  readonly runApi: RunExplorerApiContract;
};

export function PlaygroundPage({ agentApi, runApi }: PlaygroundProps) {
  const list = useAgentDefinitions(agentApi);
  if (list.isError)
    return (
      <Alert
        type="error"
        showIcon
        title={list.error.message}
        action={<Button onClick={() => void list.refetch()}>重试</Button>}
      />
    );
  if (!list.data) return <Spin aria-label="正在读取 Agent 列表" />;
  if (!list.data.canManage)
    return <Alert type="warning" showIcon title="只有 Agent 管理员可以使用 Playground。" />;
  if (!list.data.items.length) return <Empty description="暂无可测试的 Agent，请先创建草稿。" />;
  return <PlaygroundWorkspace agentApi={agentApi} runApi={runApi} items={list.data.items} />;
}

function PlaygroundWorkspace({
  agentApi,
  runApi,
  items,
}: PlaygroundProps & { readonly items: AdminAgentDefinitionList["items"] }) {
  const messageId = useId();
  const [definitionId, setDefinitionId] = useState("");
  const [revisionId, setRevisionId] = useState("");
  const [message, setMessage] = useState("");
  const [accepted, setAccepted] = useState<{ receipt: PlaygroundReceipt; version: string }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const key = useRef<string | undefined>(undefined);
  const history = useAgentHistory(agentApi, definitionId);
  const revision = history.data?.items.find(
    (item) => item.id === revisionId && item.status !== "revoked",
  );
  const ready = !busy && !history.isError && revision !== undefined && message.trim() !== "";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(undefined);
    try {
      // 响应丢失时沿用同一键；修改输入或成功受理后再生成新键。
      key.current ??= crypto.randomUUID();
      const result = await startPlaygroundRun({ definitionId, revisionId, message }, key.current);
      setAccepted({
        receipt: result,
        version: `${revision.displayName} · 版本 ${revision.revision}`,
      });
      key.current = undefined;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法发起运行，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="playground-workspace">
      <form
        className="control-panel agent-form playground-form"
        onSubmit={(event) => void submit(event)}
        onChange={() => {
          key.current = undefined;
          setError(undefined);
        }}
      >
        <header>
          <h2>测试对话</h2>
          <p>每次运行都在你的个人空间创建新对话，不会发布所选版本。</p>
        </header>
        <label className="agent-field">
          <span>Agent</span>
          <select
            value={definitionId}
            disabled={busy}
            onChange={(event) => {
              setDefinitionId(event.target.value);
              setRevisionId("");
            }}
          >
            <option value="">选择 Agent</option>
            {items.map(({ definition, revision }) => (
              <option key={definition.id} value={definition.id}>
                {revision?.displayName ?? definition.id} · {definition.id}
              </option>
            ))}
          </select>
        </label>
        <label className="agent-field">
          <span>版本</span>
          <select
            value={revisionId}
            disabled={busy || !history.data || history.isError}
            onChange={(event) => setRevisionId(event.target.value)}
          >
            <option value="">
              {!definitionId
                ? "先选择 Agent"
                : history.isLoading
                  ? "正在读取版本…"
                  : history.data?.items.length === 0
                    ? "暂无版本"
                    : "选择版本"}
            </option>
            {history.data?.items.map((item) => (
              <option key={item.id} value={item.id} disabled={item.status === "revoked"}>
                版本 {item.revision} · {agentStatusLabels[item.status]}
              </option>
            ))}
          </select>
        </label>
        {history.isError && (
          <Alert
            type="error"
            title={history.error.message}
            action={<Button onClick={() => void history.refetch()}>重试</Button>}
          />
        )}
        <label className="agent-field" htmlFor={messageId}>
          <span>测试消息</span>
          <Input.TextArea
            id={messageId}
            rows={5}
            placeholder="输入要让这个版本回答的问题"
            value={message}
            disabled={busy}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
        <p className="playground-note">此处不提供工具 Mock。请勿发送依赖模拟工具返回值的测试。</p>
        {error && <Alert type="error" showIcon title={error} />}
        <Button type="primary" htmlType="submit" loading={busy} disabled={!ready}>
          发起运行
        </Button>
      </form>
      <aside className="playground-trace" aria-label="执行轨迹">
        {accepted ? (
          <>
            <p className="playground-trace-caption" role="status">
              最近受理：{accepted.version}
            </p>
            <RunExplorerDetail
              key={`${accepted.receipt.tenantId}/${accepted.receipt.runId}`}
              api={runApi}
              tenantId={accepted.receipt.tenantId}
              runId={accepted.receipt.runId}
              live
            />
          </>
        ) : (
          <section className="control-panel">
            <h2>执行轨迹</h2>
            <Empty description="发起运行后，这里会自动更新模型调用、工具调用、耗时和 Token。" />
          </section>
        )}
      </aside>
    </div>
  );
}

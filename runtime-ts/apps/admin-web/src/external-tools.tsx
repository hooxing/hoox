import type {
  AdminExternalToolBatchDto,
  AdminMcpDraftDto,
  AdminMcpProbeReport,
} from "@hoox/protocol";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Input, Space, Spin, Tag, Typography } from "antd";
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import type { ExternalToolApiContract } from "./control-api.js";
import { HttpPreviewPage, McpSettingsForm, useToolAction } from "./external-tool-forms.js";

export function ExternalToolsPage({
  api,
  httpPreview = false,
}: {
  api: ExternalToolApiContract;
  httpPreview?: boolean;
}) {
  const query = useQuery({
    queryKey: ["admin-external-tools"],
    queryFn: () => api.listExternalTools(),
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState<string>();
  if (query.isError)
    return (
      <Alert
        type="error"
        showIcon
        title={query.error.message}
        action={<Button onClick={() => void query.refetch()}>重试</Button>}
      />
    );
  if (!query.data) return <Spin aria-label="正在读取外部工具" />;
  if (httpPreview) return <HttpPreviewPage api={api} />;
  const refresh = async () => {
    await query.refetch();
  };
  const draft = query.data.drafts.find((d) => d.draftId === selected);
  if (creating)
    return (
      <McpSettingsForm
        onCancel={() => setCreating(undefined)}
        onSave={async (settings) => {
          const saved = await api.createMcpDraft({
            draftId: creating,
            expectedGeneration: 0,
            settings,
          });
          await refresh();
          setCreating(undefined);
          setSelected(saved.draftId);
        }}
      />
    );
  // 草稿或凭据的修订变化后，丢弃旧表单与探测报告，不能沿用之前的发布许可。
  if (draft)
    return (
      <DraftPanel
        key={`${draft.draftId}:${draft.generation}`}
        api={api}
        draft={draft}
        refresh={refresh}
        back={() => setSelected(undefined)}
      />
    );
  return (
    <div className="agent-page">
      <div className="agent-page-heading">
        <div>
          <Typography.Title level={2}>工具注册</Typography.Title>
          <Typography.Text type="secondary">
            保存 MCP 草稿并探测工具。只有已发布且未撤销的版本可加入 Agent。
          </Typography.Text>
        </div>
        <Space wrap>
          <Link to="/external-tools/http-preview">HTTP 工具预览</Link>
          <Button type="primary" onClick={() => setCreating(`mcp_${crypto.randomUUID()}`)}>
            新建 MCP 草稿
          </Button>
        </Space>
      </div>
      <Card title="MCP 草稿">
        {query.data.drafts.length === 0 ? (
          <Typography.Text type="secondary">尚未注册 MCP Server。</Typography.Text>
        ) : (
          <ul className="agent-row-list">
            {query.data.drafts.map((d) => (
              <li className="agent-row" key={d.draftId}>
                <div className="agent-row-identity">
                  <strong>{d.displayName}</strong>
                  <span>
                    {d.serverName} · {d.endpoint}
                  </span>
                </div>
                <Tag>{d.credentialConfigured ? "凭据已配置" : "未配置凭据"}</Tag>
                <Button onClick={() => setSelected(d.draftId)}>管理草稿</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="发布批次">
        {query.data.batches.length === 0 ? (
          <Typography.Text type="secondary">暂无已发布的工具版本。</Typography.Text>
        ) : (
          query.data.batches.map((batch) => (
            <BatchPanel key={batch.batchId} api={api} batch={batch} refresh={refresh} />
          ))
        )}
      </Card>
    </div>
  );
}

function DraftPanel({
  api,
  draft,
  refresh,
  back,
}: {
  api: ExternalToolApiContract;
  draft: AdminMcpDraftDto;
  refresh: () => Promise<void>;
  back: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [credentialEdit, setCredentialEdit] = useState<"write" | "clear">();
  const [report, setReport] = useState<AdminMcpProbeReport>();
  const formId = useId();
  const action = useToolAction();
  const generation = { expectedGeneration: draft.generation };
  if (editing)
    return (
      <McpSettingsForm
        draft={draft}
        onCancel={() => setEditing(false)}
        onSave={async (settings) => {
          await api.updateMcpDraft(draft.draftId, { ...generation, settings });
          await refresh();
          setEditing(false);
        }}
      />
    );
  function writeCredential(credential: string | null) {
    setReport(undefined);
    void action.run(async () => {
      await api.setMcpCredential(draft.draftId, { ...generation, credential });
      setCredentialEdit(undefined);
      await refresh();
    });
  }
  return (
    <div className="agent-page">
      <div className="agent-page-heading">
        <div>
          <Typography.Title level={2}>{draft.displayName}</Typography.Title>
          <Typography.Text type="secondary">
            {draft.serverName} · 草稿修订 {draft.generation}
          </Typography.Text>
        </div>
        <Button onClick={back} disabled={action.pending}>
          返回列表
        </Button>
      </div>
      <Card
        title="连接设置"
        extra={
          <Button
            disabled={action.pending}
            onClick={() => {
              setEditing(true);
              setReport(undefined);
            }}
          >
            编辑设置
          </Button>
        }
      >
        <div className="agent-fields">
          <strong>{draft.endpoint}</strong>
          <span>
            超时 {draft.timeoutMs} 毫秒 · 响应上限 {draft.maxResponseBytes} 字节
          </span>
          <Space wrap>
            <Tag>{draft.credentialConfigured ? "凭据已配置" : "未配置凭据"}</Tag>
            <Button disabled={action.pending} onClick={() => setCredentialEdit("write")}>
              {draft.credentialConfigured ? "替换凭据" : "写入凭据"}
            </Button>
            {draft.credentialConfigured && (
              <Button disabled={action.pending} onClick={() => setCredentialEdit("clear")}>
                清除凭据
              </Button>
            )}
          </Space>
          {credentialEdit === "write" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const field = e.currentTarget.elements.namedItem("credential") as HTMLInputElement;
                // 提交后无论成功与否都清空输入，不把凭据保存在组件或查询缓存里。
                const credential = field.value;
                field.value = "";
                writeCredential(credential);
              }}
            >
              <fieldset className="tool-form-fields" disabled={action.pending}>
                <label htmlFor={`${formId}-credential`} className="agent-field">
                  <span>新凭据（只写）</span>
                  <input
                    className="tool-credential"
                    id={`${formId}-credential`}
                    name="credential"
                    type="password"
                    autoComplete="new-password"
                    required
                    maxLength={8192}
                  />
                </label>
                <Space>
                  <Button htmlType="submit">保存凭据</Button>
                  <Button onClick={() => setCredentialEdit(undefined)}>取消</Button>
                </Space>
              </fieldset>
            </form>
          )}
          {credentialEdit === "clear" && (
            <Alert
              type="warning"
              title="清除后，后续草稿探测将不再携带凭据。"
              action={
                <Space>
                  <Button disabled={action.pending} danger onClick={() => writeCredential(null)}>
                    确认清除
                  </Button>
                  <Button disabled={action.pending} onClick={() => setCredentialEdit(undefined)}>
                    取消
                  </Button>
                </Space>
              }
            />
          )}
        </div>
      </Card>
      <Card title="探测与发布">
        <div className="agent-fields">
          <Typography.Text type="secondary">
            发布时重新探测。任一工具未通过，整个批次都不会发布。
          </Typography.Text>
          <Space wrap>
            <Button
              disabled={action.pending || !!credentialEdit}
              onClick={() => {
                setReport(undefined);
                void action.run(async () =>
                  setReport(await api.probeMcpDraft(draft.draftId, generation)),
                );
              }}
            >
              探测草稿
            </Button>
            <Button
              type="primary"
              disabled={
                action.pending ||
                !!credentialEdit ||
                !report?.publishable ||
                report.draftId !== draft.draftId ||
                report.generation !== draft.generation
              }
              onClick={() =>
                void action.run(async () => {
                  await api.publishMcpDraft(draft.draftId, generation);
                  await refresh();
                  back();
                })
              }
            >
              发布整批工具
            </Button>
          </Space>
          {report && (
            <>
              <Alert
                type={report.publishable ? "success" : "warning"}
                title={
                  report.failure?.message ??
                  (report.publishable ? "全部工具通过探测。" : "此工具清单不能发布。")
                }
              />
              <ul className="agent-row-list">
                {report.tools.map((tool, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 拒绝项可能重名或无名称；整份报告只读且总是整体替换。
                  <li className="agent-row" key={`${index}:${tool.remoteToolName ?? ""}`}>
                    <Tag color={tool.accepted ? "success" : "error"}>
                      {tool.accepted ? "通过" : "拒绝"}
                    </Tag>
                    <strong>{tool.remoteToolName ?? "未命名工具"}</strong>
                    <span>{tool.accepted ? tool.modelToolName : tool.reasonMessage}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </Card>
      {action.error && (
        <Alert
          type="error"
          showIcon
          title={action.error}
          action={<Button onClick={() => void refresh()}>刷新草稿</Button>}
        />
      )}
    </div>
  );
}

function BatchPanel({
  api,
  batch,
  refresh,
}: {
  api: ExternalToolApiContract;
  batch: AdminExternalToolBatchDto;
  refresh: () => Promise<void>;
}) {
  const [revoking, setRevoking] = useState(false);
  const formId = useId();
  const action = useToolAction();
  return (
    <details className="tool-batch">
      <summary>
        <strong>{batch.displayName}</strong> · {batch.tools.length} 个工具{" "}
        <Tag color={batch.revoked ? "error" : "success"}>{batch.revoked ? "已撤销" : "已发布"}</Tag>
      </summary>
      <div className="agent-fields">
        <Typography.Text type="secondary">
          {batch.endpoint} · 草稿修订 {batch.draftGeneration}
        </Typography.Text>
        <ul className="agent-row-list">
          {batch.tools.map((tool) => (
            <li className="agent-row" key={tool.toolVersionId}>
              <div className="agent-row-identity">
                <strong>{tool.modelToolName}</strong>
                <span>{tool.description}</span>
                <small>
                  版本 ID：{tool.toolVersionId} · 远端名称：{tool.remoteToolName ?? "—"}
                </small>
                <small>Schema 摘要：{tool.inputSchemaDigest}</small>
              </div>
            </li>
          ))}
        </ul>
        {batch.revoked ? (
          <span>撤销原因：{batch.revocationReason ?? "未记录"}</span>
        ) : revoking ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const reason = String(new FormData(e.currentTarget).get("reason")).trim();
              if (!reason) {
                action.setError("请填写撤销原因。");
                return;
              }
              void action.run(async () => {
                await api.revokeToolBatch(batch.batchId, { reason });
                await refresh();
                setRevoking(false);
              });
            }}
          >
            <fieldset className="tool-form-fields" disabled={action.pending}>
              <Alert
                type="warning"
                title="批次内所有版本将不可再选用，引用这些版本的 Agent 草稿必须移除引用才能保存或发布。"
              />
              <label htmlFor={`${formId}-reason`} className="agent-field">
                <span>撤销原因</span>
                <Input id={`${formId}-reason`} name="reason" maxLength={500} required />
              </label>
              <Space>
                <Button danger htmlType="submit" loading={action.pending}>
                  确认撤销
                </Button>
                <Button onClick={() => setRevoking(false)}>取消</Button>
              </Space>
            </fieldset>
          </form>
        ) : (
          <div>
            <Button danger onClick={() => setRevoking(true)}>
              撤销批次
            </Button>
          </div>
        )}
        {action.error && <Alert type="error" title={action.error} />}
      </div>
    </details>
  );
}

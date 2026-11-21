import type {
  AdminAgentDefinitionList,
  AdminAgentRevisionHistory,
  AdminSetAgentAvailability,
  AgentDefinitionDto,
  AgentPinnedModelReferenceDto,
  AgentRevisionContentDto,
  AgentRevisionDto,
} from "@hoox/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Empty, Input, Modal, Space, Spin, Tag, Typography } from "antd";
import { type FormEvent, useId, useState } from "react";
import {
  allTenants,
  availabilityText,
  AvailabilityFields,
  AgentDefinitionEditor,
  parseAvailability,
} from "./agent-definition-editor.js";
import type { AgentDefinitionApiContract } from "./control-api.js";

const statuses = {
  draft: "草稿",
  published: "已发布",
  disabled: "已停用",
  revoked: "已撤销",
} as const;
const listKey = ["admin-agent-definitions"] as const;
const historyKey = (id: string) => ["admin-agent-history", id] as const;

function RevisionStatus({ status }: { readonly status: keyof typeof statuses }) {
  return (
    <Tag color={status === "published" ? "success" : status === "revoked" ? "error" : "default"}>
      {statuses[status]}
    </Tag>
  );
}

export function AgentDefinitionsPage({
  api,
  destination,
  onOpen,
  onBack,
}: {
  readonly api: AgentDefinitionApiContract;
  readonly destination:
    | { readonly kind: "list" | "create" }
    | { readonly kind: "detail"; readonly id: string };
  readonly onOpen: (id?: string) => void;
  readonly onBack: () => void;
}) {
  const query = useQuery({
    queryKey: listKey,
    queryFn: () => api.listAgentDefinitions(),
    gcTime: 0,
    staleTime: 0,
  });
  if (query.isError)
    return (
      <Alert
        type="error"
        showIcon
        title={query.error.message}
        action={<Button onClick={() => void query.refetch()}>重试</Button>}
      />
    );
  if (!query.data) return <Spin aria-label="正在读取 Agent 列表" />;
  const { items, canManage, builtinToolLimit, pinnedModelOptions, externalToolOptions } =
    query.data;
  if (destination.kind === "create") {
    return canManage ? (
      <CreateAgent
        api={api}
        builtinToolLimit={builtinToolLimit}
        pinnedModelOptions={pinnedModelOptions}
        externalToolOptions={externalToolOptions}
        onOpen={onOpen}
        onBack={onBack}
      />
    ) : (
      <Alert type="warning" showIcon title="当前账号只有已发布版本的读取权限。" />
    );
  }
  if (destination.kind === "detail") {
    return (
      <AgentHistory
        key={destination.id}
        api={api}
        id={destination.id}
        canManage={canManage}
        builtinToolLimit={builtinToolLimit}
        pinnedModelOptions={pinnedModelOptions}
        externalToolOptions={externalToolOptions}
        onBack={onBack}
      />
    );
  }
  return (
    <div className="agent-page">
      <div className="agent-page-heading">
        <div>
          <Typography.Title level={2}>Agent 列表</Typography.Title>
          <Typography.Text type="secondary">
            在平台维护 Agent 定义、版本和 Tenant 可用范围。
          </Typography.Text>
        </div>
        {canManage && (
          <Button type="primary" onClick={() => onOpen()}>
            新建 Agent
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <Empty description="没有可查看的 Agent 定义" />
      ) : (
        <Card>
          <ul className="agent-row-list">
            {items.map(({ definition, revision }) => (
              <li key={definition.id} className="agent-row">
                <div className="agent-row-identity">
                  <strong>{revision?.displayName ?? definition.id}</strong>
                  <Typography.Text type="secondary">{definition.id}</Typography.Text>
                </div>
                <RevisionStatus status={definition.status} />
                <span>{revision ? `版本 ${revision.revision}` : "尚无版本"}</span>
                <span>{availabilityText(definition.availability)}</span>
                <Button type="link" onClick={() => onOpen(definition.id)}>
                  查看版本
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function revisionId() {
  return `agent_revision_${crypto.randomUUID()}`;
}

function CreateAgent({
  api,
  builtinToolLimit,
  pinnedModelOptions,
  externalToolOptions,
  onOpen,
  onBack,
}: {
  readonly api: AgentDefinitionApiContract;
  readonly builtinToolLimit: readonly string[];
  readonly pinnedModelOptions: readonly AgentPinnedModelReferenceDto[];
  readonly externalToolOptions: Readonly<AdminAgentDefinitionList["externalToolOptions"]>;
  readonly onOpen: (id: string) => void;
  readonly onBack: () => void;
}) {
  const client = useQueryClient();
  const [id] = useState(() => `agent_${crypto.randomUUID()}`);
  const [firstRevision] = useState(revisionId);
  const create = useMutation({
    gcTime: 0,
    mutationFn: (input: Parameters<typeof api.createAgentDefinition>[0]) =>
      api.createAgentDefinition(input),
  });
  return (
    <div className="agent-page">
      <Typography.Title level={2}>新建 Agent 草稿</Typography.Title>
      <AgentDefinitionEditor
        builtinToolLimit={builtinToolLimit}
        pinnedModelOptions={pinnedModelOptions}
        externalToolOptions={externalToolOptions}
        saving={create.isPending}
        onCancel={onBack}
        onSave={async (content, availability = allTenants) => {
          const result = await create.mutateAsync({
            id,
            revisionId: firstRevision,
            expectedGeneration: 0,
            content,
            availability,
          });
          await client.invalidateQueries({ queryKey: listKey });
          onOpen(result.definition.id);
        }}
      />
    </div>
  );
}

type Work =
  | {
      readonly kind: "edit";
      readonly revisionId: string;
      readonly generation: number;
      readonly newRevisionId: string;
    }
  | { readonly kind: "scope"; readonly definition: AgentDefinitionDto }
  | {
      readonly kind: "revoke";
      readonly revisionId: string;
      readonly revision: number;
      readonly generation: number;
      readonly current: boolean;
    };

function AgentHistory({
  api,
  id,
  canManage,
  builtinToolLimit,
  pinnedModelOptions,
  externalToolOptions,
  onBack,
}: {
  readonly api: AgentDefinitionApiContract;
  readonly id: string;
  readonly canManage: boolean;
  readonly builtinToolLimit: readonly string[];
  readonly pinnedModelOptions: readonly AgentPinnedModelReferenceDto[];
  readonly externalToolOptions: Readonly<AdminAgentDefinitionList["externalToolOptions"]>;
  readonly onBack: () => void;
}) {
  const client = useQueryClient();
  const history = useQuery({
    queryKey: historyKey(id),
    queryFn: () => api.listAgentRevisions(id),
    gcTime: 0,
    staleTime: 0,
  });
  const [work, setWork] = useState<Work>();
  const [selected, setSelected] = useState<string>();
  const [comparison, setComparison] = useState("");
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const [notice, setNotice] = useState<string>();
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: async (write: () => Promise<unknown>) => write(),
  });
  const edit = work?.kind === "edit" && canManage ? work : undefined;
  const activeRevisionId =
    edit?.revisionId ??
    selected ??
    history.data?.definition.currentRevisionId ??
    history.data?.items[0]?.id;
  const active = useAgentRevision(api, id, activeRevisionId);
  const compare = useAgentRevision(
    api,
    id,
    !edit && comparison !== activeRevisionId ? comparison || undefined : undefined,
  );

  async function run(write: () => Promise<unknown>, message: string) {
    setNotice(undefined);
    await mutation.mutateAsync(async () => {
      await write();
      setWork(undefined);
      await Promise.all([
        client.invalidateQueries({ queryKey: historyKey(id) }),
        client.invalidateQueries({ queryKey: listKey }),
        client.invalidateQueries({ queryKey: ["admin-agent-revision", id] }),
      ]);
    });
    setNotice(message);
  }

  if (history.isError)
    return (
      <div className="agent-page">
        <Button onClick={onBack}>返回列表</Button>
        <Alert
          type="error"
          showIcon
          title={history.error.message}
          action={<Button onClick={() => void history.refetch()}>重试</Button>}
        />
      </div>
    );
  if (!history.data) return <Spin aria-label="正在读取版本历史" />;
  const { definition, items } = history.data;
  const current = items.find((item) => item.id === definition.currentRevisionId);
  const displayedName = current?.displayName ?? items[0]?.displayName ?? id;
  const busy = mutation.isPending;
  function action(write: () => Promise<unknown>, message: string) {
    void run(write, message).catch(() => undefined);
  }

  return (
    <div className="agent-page">
      <div>
        <Button onClick={onBack}>返回列表</Button>
      </div>
      <div className="agent-page-heading">
        <div>
          <Typography.Title level={2}>{displayedName}</Typography.Title>
          <Typography.Text type="secondary">
            {id} · 第 {definition.generation} 次配置变更
          </Typography.Text>
        </div>
        <Space wrap>
          <RevisionStatus status={definition.status} />
          {canManage && definition.status === "published" && !work && (
            <Button
              disabled={busy}
              onClick={() =>
                action(
                  () =>
                    api.deactivateAgentDefinition(id, {
                      expectedGeneration: definition.generation,
                    }),
                  "已停用。正在执行的 Run 不受停用影响。",
                )
              }
            >
              停用 Agent
            </Button>
          )}
        </Space>
      </div>
      {notice && <Alert type="success" showIcon title={notice} />}
      {mutation.isError &&
        work?.kind !== "edit" &&
        work?.kind !== "scope" &&
        work?.kind !== "revoke" && (
          <Alert
            type="error"
            showIcon
            title={mutation.error.message}
            action={
              <Button
                onClick={() => {
                  mutation.reset();
                  void history.refetch();
                }}
              >
                刷新版本
              </Button>
            }
          />
        )}
      <Card
        title="可用范围"
        extra={
          canManage &&
          !work && (
            <Button disabled={busy} onClick={() => setWork({ kind: "scope", definition })}>
              设置可用范围
            </Button>
          )
        }
      >
        {work?.kind === "scope" && canManage ? (
          <AvailabilityEditor
            definition={work.definition}
            saving={busy}
            onCancel={() => setWork(undefined)}
            onSave={(availability) =>
              run(
                () =>
                  api.setAgentAvailability(id, {
                    availability,
                    expectedGeneration: work.definition.generation,
                  }),
                "可用范围已更新。",
              )
            }
          />
        ) : (
          <>
            <strong>{availabilityText(definition.availability)}</strong>
            {definition.availability.mode === "selected_tenants" && (
              <ul className="agent-tenant-ids">
                {definition.availability.tenantIds.map((item) => (
                  <li key={item}>
                    <code>{item}</code>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>
      {edit ? (
        <section className="agent-page" aria-label="草稿编辑器">
          <Typography.Title level={3}>编辑为新草稿</Typography.Title>
          {active.isError ? (
            <Alert
              type="error"
              showIcon
              title={active.error.message}
              action={<Button onClick={() => setWork(undefined)}>返回版本</Button>}
            />
          ) : active.data ? (
            <AgentDefinitionEditor
              key={edit.newRevisionId}
              initial={active.data.content}
              builtinToolLimit={builtinToolLimit}
              pinnedModelOptions={pinnedModelOptions}
              externalToolOptions={externalToolOptions}
              saving={busy}
              onCancel={() => setWork(undefined)}
              onSave={(content) =>
                run(async () => {
                  const result = await api.saveAgentRevision(id, {
                    content,
                    expectedGeneration: edit.generation,
                    revisionId: edit.newRevisionId,
                  });
                  setSelected(result.id);
                }, "已保存新草稿，当前发布版本未变更。")
              }
            />
          ) : (
            <Spin />
          )}
        </section>
      ) : (
        <>
          <Card title="版本历史">
            <ul className="agent-row-list">
              {items.map((item) => (
                <li key={item.id} className="agent-row">
                  <div className="agent-row-identity">
                    <strong>
                      版本 {item.revision} · {item.displayName}
                    </strong>
                    <Typography.Text type="secondary">
                      {new Date(item.createdAt).toLocaleString()} · {item.createdBy}
                    </Typography.Text>
                  </div>
                  <RevisionStatus status={item.status} />
                  {item.id === definition.currentRevisionId && <Tag>当前版本</Tag>}
                  <Space wrap>
                    <Button
                      type="link"
                      aria-pressed={activeRevisionId === item.id}
                      onClick={() => setSelected(item.id)}
                    >
                      查看版本 {item.revision}
                    </Button>
                    {canManage && !work && definition.status !== "revoked" && (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          setWork({
                            kind: "edit",
                            revisionId: item.id,
                            newRevisionId: revisionId(),
                            generation: definition.generation,
                          })
                        }
                      >
                        编辑为新草稿
                      </Button>
                    )}
                    {canManage &&
                      !work &&
                      item.status === "draft" &&
                      definition.status !== "revoked" && (
                        <Button
                          type="primary"
                          disabled={busy}
                          onClick={() =>
                            action(
                              () =>
                                api.publishAgentRevision(id, item.id, {
                                  expectedGeneration: definition.generation,
                                }),
                              `已发布版本 ${item.revision}。`,
                            )
                          }
                        >
                          发布
                        </Button>
                      )}
                    {canManage && !work && item.status === "published" && (
                      <Button
                        danger
                        type="text"
                        disabled={busy}
                        onClick={() => {
                          mutation.reset();
                          setReason("");
                          setWork({
                            kind: "revoke",
                            revisionId: item.id,
                            revision: item.revision,
                            generation: definition.generation,
                            current: item.id === definition.currentRevisionId,
                          });
                        }}
                      >
                        撤销
                      </Button>
                    )}
                  </Space>
                </li>
              ))}
            </ul>
          </Card>
          <Card title={active.data ? `版本 ${active.data.revision} 详情` : "版本详情"}>
            {items.length > 1 && (
              <CompareSelect
                items={items}
                activeId={activeRevisionId}
                comparison={comparison}
                onCompare={setComparison}
              />
            )}
            {active.isError ? (
              <Alert type="error" showIcon title={active.error.message} />
            ) : active.data ? (
              <RevisionContent
                revision={active.data}
                comparison={compare.isSuccess ? compare.data : undefined}
              />
            ) : (
              <Spin />
            )}
            {compare.isError && <Alert type="error" showIcon title={compare.error.message} />}
            {compare.isFetching && <Spin aria-label="正在读取对比版本" />}
          </Card>
        </>
      )}
      {canManage && work?.kind === "revoke" && (
        <Modal
          open
          title={`确认撤销版本 ${work.revision}？`}
          okText="确认撤销"
          cancelText="取消"
          confirmLoading={busy}
          okButtonProps={{
            danger: true,
            disabled: !reason.trim() || new TextEncoder().encode(reason.trim()).byteLength > 500,
          }}
          onCancel={() => {
            if (!busy) setWork(undefined);
          }}
          onOk={() =>
            action(
              () =>
                api.revokeAgentRevision(id, work.revisionId, {
                  expectedGeneration: work.generation,
                  reason: reason.trim(),
                }),
              "版本已撤销。",
            )
          }
        >
          <p>撤销不可恢复。使用此版本的在途 Run 将在下一个安全点失败关闭，不会自动切换版本。</p>
          {work.current && <p>这是当前版本，撤销后该 Agent 将不再接受新 Run。</p>}
          <label className="agent-field" htmlFor={reasonId}>
            <span>撤销原因（最多 500 字节）</span>
            <Input.TextArea
              id={reasonId}
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {mutation.error && <Alert type="error" showIcon title={mutation.error.message} />}
        </Modal>
      )}
    </div>
  );
}

function AvailabilityEditor({
  definition,
  saving,
  onSave,
  onCancel,
}: {
  readonly definition: AgentDefinitionDto;
  readonly saving: boolean;
  readonly onSave: (value: AdminSetAgentAvailability["availability"]) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [mode, setMode] = useState<string>(definition.availability.mode);
  const [text, setText] = useState(
    definition.availability.mode === "selected_tenants"
      ? definition.availability.tenantIds.join("\n")
      : "",
  );
  const [error, setError] = useState<string>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setError(undefined);
    try {
      await onSave(parseAvailability(mode, text));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法更新可用范围，请重试。");
    }
  }
  return (
    <form className="agent-form" onSubmit={(event) => void submit(event)}>
      <AvailabilityFields mode={mode} text={text} onMode={setMode} onText={setText} />
      {error && <Alert type="error" showIcon title={error} />}
      <Space>
        <Button type="primary" htmlType="submit" loading={saving}>
          保存可用范围
        </Button>
        <Button onClick={onCancel} disabled={saving}>
          取消
        </Button>
      </Space>
    </form>
  );
}

function useAgentRevision(
  api: AgentDefinitionApiContract,
  id: string,
  revisionId: string | undefined,
) {
  return useQuery({
    queryKey: ["admin-agent-revision", id, revisionId],
    queryFn: () => api.readAgentRevision(id, revisionId ?? ""),
    enabled: revisionId !== undefined,
    gcTime: 0,
    staleTime: 0,
  });
}

function CompareSelect({
  items,
  activeId,
  comparison,
  onCompare,
}: {
  readonly items: AdminAgentRevisionHistory["items"];
  readonly activeId: string | undefined;
  readonly comparison: string;
  readonly onCompare: (id: string) => void;
}) {
  return (
    <label className="agent-field agent-compare-select">
      <span>对比版本</span>
      <select
        value={comparison === activeId ? "" : comparison}
        onChange={(event) => onCompare(event.target.value)}
      >
        <option value="">不比较</option>
        {items
          .filter((item) => item.id !== activeId)
          .map((item) => (
            <option key={item.id} value={item.id}>
              版本 {item.revision} · {statuses[item.status]}
            </option>
          ))}
      </select>
    </label>
  );
}

const contentLabels: Record<keyof AgentRevisionContentDto, string> = {
  displayName: "显示名称",
  description: "简介",
  avatarRef: "头像引用",
  welcomeMessage: "欢迎语",
  suggestedQuestions: "建议问题",
  operatorInstructions: "Operator 指令",
  replyLanguage: "回复语言",
  model: "模型",
  tools: "工具",
  skillVersions: "自带 Skill",
  includeTenantSkills: "叠加 Tenant Skill",
  sandboxTemplateId: "Sandbox 模板",
  sandboxIdleAction: "Sandbox 空闲策略",
  memory: "长期记忆",
};

function contentText(value: AgentRevisionContentDto[keyof AgentRevisionContentDto]): string {
  if (value === undefined || value === "") return "未设置";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "启用" : "不启用";
  return JSON.stringify(value, null, 2);
}

function RevisionContent({
  revision,
  comparison,
}: {
  readonly revision: AgentRevisionDto;
  readonly comparison: AgentRevisionDto | undefined;
}) {
  const fields = (Object.keys(contentLabels) as (keyof AgentRevisionContentDto)[]).filter(
    (field) =>
      comparison
        ? JSON.stringify(revision.content[field]) !== JSON.stringify(comparison.content[field])
        : revision.content[field] !== undefined,
  );
  if (fields.length === 0) return <Empty description="两个版本的配置没有差异" />;
  return (
    <div className="agent-revision-content">
      {comparison && (
        <Typography.Text type="secondary">
          仅显示与版本 {comparison.revision} 不同的字段。
        </Typography.Text>
      )}
      {fields.map((field) => (
        <section className="agent-content-field" key={field}>
          <strong>{contentLabels[field]}</strong>
          <div className={comparison ? "agent-comparison" : undefined}>
            <div>
              {comparison && <span>版本 {revision.revision}</span>}
              <pre>{contentText(revision.content[field])}</pre>
            </div>
            {comparison && (
              <div>
                <span>版本 {comparison.revision}</span>
                <pre>{contentText(comparison.content[field])}</pre>
              </div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

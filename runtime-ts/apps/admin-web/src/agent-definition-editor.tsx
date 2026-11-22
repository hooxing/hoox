import {
  type AdminAgentDefinitionList,
  AGENT_OPERATOR_INSTRUCTIONS_MAX_BYTES,
  type AdminSetAgentAvailability,
  type AgentPinnedModelReferenceDto,
  type AgentRevisionContentDto,
  RUNTIME_TOOL_CATALOG,
} from "@hoox/protocol";
import { Alert, Button, Card, Input, Space, Typography } from "antd";
import { type FormEvent, useId, useState } from "react";
import { AgentSkillSelector } from "./agent-skill-selector.js";

export const allTenants = { mode: "all_tenants" } as const;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
const lines = (text: string) =>
  text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

export function availabilityText(value: AdminSetAgentAvailability["availability"]) {
  return value.mode === "all_tenants" ? "全部 Tenant" : `指定 Tenant（${value.tenantIds.length}）`;
}

export function parseAvailability(
  mode: string,
  text: string,
): AdminSetAgentAvailability["availability"] {
  if (mode === "all_tenants") return allTenants;
  const tenantIds = lines(text);
  if (
    tenantIds.length === 0 ||
    tenantIds.length > 1000 ||
    tenantIds.some((id) => !idPattern.test(id)) ||
    new Set(tenantIds).size !== tenantIds.length
  ) {
    throw new Error("请逐行填写 1 至 1000 个格式有效且不重复的 Tenant ID。");
  }
  return { mode: "selected_tenants", tenantIds };
}

export function AvailabilityFields({
  mode,
  text,
  onMode,
  onText,
}: {
  readonly mode: string;
  readonly text: string;
  readonly onMode: (value: string) => void;
  readonly onText: (value: string) => void;
}) {
  const inputId = useId();
  return (
    <div className="agent-fields">
      <label className="agent-field">
        <span>可用范围</span>
        <select value={mode} onChange={(event) => onMode(event.target.value)}>
          <option value="all_tenants">全部 Tenant</option>
          <option value="selected_tenants">指定 Tenant</option>
        </select>
      </label>
      {mode === "selected_tenants" && (
        <label className="agent-field" htmlFor={inputId}>
          <span>Tenant ID（每行一个）</span>
          <Input.TextArea
            id={inputId}
            rows={3}
            value={text}
            onChange={(event) => onText(event.target.value)}
            required
          />
        </label>
      )}
    </div>
  );
}

const initialContent: AgentRevisionContentDto = {
  displayName: "",
  description: "",
  suggestedQuestions: [],
  operatorInstructions: "",
  replyLanguage: "zh-CN",
  model: { mode: "platform_default" },
  tools: { mode: "platform_default" },
  skillVersions: [],
  includeTenantSkills: true,
  sandboxIdleAction: "pause",
  memory: { mode: "platform_default" },
};

function pinnedModelKey(model: AgentPinnedModelReferenceDto): string {
  return JSON.stringify([model.providerKey, model.providerRevision, model.modelId]);
}

export function AgentDefinitionEditor({
  initial,
  builtinToolLimit,
  pinnedModelOptions,
  externalToolOptions = [],
  skillOptions = [],
  saving,
  onSave,
  onCancel,
}: {
  readonly initial?: AgentRevisionContentDto;
  readonly builtinToolLimit: readonly string[];
  readonly pinnedModelOptions: readonly AgentPinnedModelReferenceDto[];
  readonly externalToolOptions?: Readonly<AdminAgentDefinitionList["externalToolOptions"]>;
  readonly skillOptions?: Readonly<AdminAgentDefinitionList["skillOptions"]>;
  readonly saving: boolean;
  readonly onSave: (
    content: AgentRevisionContentDto,
    availability?: AdminSetAgentAvailability["availability"],
    versionNotes?: string,
  ) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const formId = useId();
  const [content, setContent] = useState(initial ?? initialContent);
  const [clientToolSchemaDrafts, setClientToolSchemaDrafts] = useState(() =>
    (initial?.tools.mode === "configured" ? initial.tools.clientTools : []).map((tool) =>
      JSON.stringify(tool.inputSchema, null, 2),
    ),
  );
  const [questions, setQuestions] = useState(content.suggestedQuestions.join("\n"));
  const [clientToolRowIds, setClientToolRowIds] = useState(() =>
    (initial?.tools.mode === "configured" ? initial.tools.clientTools : []).map(() =>
      crypto.randomUUID(),
    ),
  );
  const [versionNotes, setVersionNotes] = useState("");
  const [scope, setScope] = useState("all_tenants");
  const [tenantIds, setTenantIds] = useState("");
  const [error, setError] = useState<string>();
  const instructionsHelpId = `${formId}-instructions-status`;
  const instructionBytes = byteLength(content.operatorInstructions);
  const instructionError =
    instructionBytes > AGENT_OPERATOR_INSTRUCTIONS_MAX_BYTES
      ? "Operator 指令超出字节上限。"
      : /\$\{[^}]+\}|\{\{[^}]+\}\}/u.test(content.operatorInstructions)
        ? "Operator 指令不得包含模板变量。"
        : undefined;
  const pinnedModels = new Map(pinnedModelOptions.map((model) => [pinnedModelKey(model), model]));
  const selectedModelKey =
    content.model.mode === "pinned" ? pinnedModelKey(content.model) : "platform_default";
  const unavailableModel =
    content.model.mode === "pinned" && !pinnedModels.has(selectedModelKey)
      ? content.model
      : undefined;
  const configured = content.tools.mode === "configured" ? content.tools : undefined;
  const unavailableTools =
    configured?.builtinTools.filter((tool) => !builtinToolLimit.includes(tool)) ?? [];
  const unavailableExternalTools =
    configured?.externalTools.filter(
      (tool) => !externalToolOptions.some((option) => option.toolVersionId === tool.versionId),
    ) ?? [];

  function change<K extends keyof AgentRevisionContentDto>(
    field: K,
    value: AgentRevisionContentDto[K],
  ) {
    setContent((previous) => ({ ...previous, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setError(undefined);
    try {
      if (instructionError) throw new Error(instructionError);
      if (unavailableModel) throw new Error("当前固定模型不可用，请重新选择。");
      const suggestedQuestions = lines(questions);
      if (
        suggestedQuestions.length > 12 ||
        suggestedQuestions.some((item) => byteLength(item) > 500)
      ) {
        throw new Error("最多填写 12 条建议问题，每条不超过 500 字节。");
      }
      if (unavailableTools.length > 0) throw new Error("请移除平台已禁用的内置工具。");
      if (unavailableExternalTools.length) throw new Error("请移除已不可选的外部工具版本。");
      if (
        content.skillVersions.some(
          (item) =>
            !skillOptions.some(
              (option) => option.skillId === item.skillId && option.versions.includes(item.version),
            ),
        )
      ) {
        throw new Error("请重新选择或移除已不可选的 Skill 版本。");
      }
      if (Array.from(versionNotes).length > 2000) throw new Error("版本说明不得超过 2000 字符。");
      if (configured?.toolCallingMode === "ptc" && configured.clientTools.length)
        throw new Error("客户端工具需要 native 工具调用模式。");
      const tools =
        content.tools.mode !== "configured"
          ? content.tools
          : {
              ...content.tools,
              clientTools: content.tools.clientTools.map((tool, index) => {
                let inputSchema: unknown;
                try {
                  inputSchema = JSON.parse(clientToolSchemaDrafts[index] ?? "");
                } catch {
                  throw new Error("客户端工具参数 Schema 必须是有效 JSON 对象。");
                }
                if (
                  typeof inputSchema !== "object" ||
                  inputSchema === null ||
                  Array.isArray(inputSchema)
                ) {
                  throw new Error("客户端工具参数 Schema 必须是有效 JSON 对象。");
                }
                return { ...tool, inputSchema: inputSchema as Record<string, unknown> };
              }),
            };
      await onSave(
        { ...content, tools, suggestedQuestions },
        initial === undefined ? parseAvailability(scope, tenantIds) : undefined,
        versionNotes,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存草稿，请重试。");
    }
  }

  return (
    <form className="agent-form" onSubmit={(event) => void submit(event)}>
      <Card title="展示信息">
        <div className="agent-fields">
          <label className="agent-field" htmlFor={`${formId}-display-name`}>
            <span>显示名称</span>
            <Input
              id={`${formId}-display-name`}
              value={content.displayName}
              maxLength={200}
              required
              onChange={(event) => change("displayName", event.target.value)}
            />
          </label>
          <label className="agent-field" htmlFor={`${formId}-description`}>
            <span>简介</span>
            <Input.TextArea
              id={`${formId}-description`}
              rows={2}
              value={content.description}
              maxLength={2048}
              required
              onChange={(event) => change("description", event.target.value)}
            />
          </label>
          <label className="agent-field" htmlFor={`${formId}-welcome`}>
            <span>欢迎语</span>
            <Input.TextArea
              id={`${formId}-welcome`}
              rows={2}
              value={content.welcomeMessage ?? ""}
              maxLength={2048}
              onChange={(event) => change("welcomeMessage", event.target.value)}
            />
          </label>
          <label className="agent-field" htmlFor={`${formId}-questions`}>
            <span>建议问题（每行一条）</span>
            <Input.TextArea
              id={`${formId}-questions`}
              rows={3}
              value={questions}
              onChange={(event) => setQuestions(event.target.value)}
            />
          </label>
        </div>
      </Card>
      <Card title="指令与模型">
        <div className="agent-fields">
          <label className="agent-field" htmlFor={`${formId}-instructions`}>
            <span>Operator 指令</span>
            <Input.TextArea
              id={`${formId}-instructions`}
              rows={8}
              required
              value={content.operatorInstructions}
              aria-describedby={instructionsHelpId}
              aria-invalid={Boolean(instructionError)}
              status={instructionError ? "error" : ""}
              onChange={(event) => change("operatorInstructions", event.target.value)}
            />
            <span id={instructionsHelpId} role="status">
              {instructionBytes.toLocaleString()} /{" "}
              {AGENT_OPERATOR_INSTRUCTIONS_MAX_BYTES.toLocaleString()} 字节
              {instructionError ? ` · ${instructionError}` : ""}
            </span>
          </label>
          <label className="agent-field" htmlFor={`${formId}-reply-language`}>
            <span>回复语言</span>
            <Input
              id={`${formId}-reply-language`}
              value={content.replyLanguage}
              maxLength={100}
              required
              onChange={(event) => change("replyLanguage", event.target.value)}
            />
          </label>
          <label className="agent-field">
            <span>模型</span>
            <select
              value={selectedModelKey}
              onChange={(event) =>
                change(
                  "model",
                  pinnedModels.get(event.target.value) ?? { mode: "platform_default" },
                )
              }
            >
              <option value="platform_default">跟随平台默认</option>
              {unavailableModel && (
                <option value={selectedModelKey} disabled>
                  {unavailableModel.modelId} · {unavailableModel.providerKey} · 版本{" "}
                  {unavailableModel.providerRevision}（不可用）
                </option>
              )}
              {Array.from(pinnedModels, ([key, model]) => (
                <option key={key} value={key}>
                  {model.modelId} · {model.providerKey} · 版本 {model.providerRevision}
                </option>
              ))}
            </select>
          </label>
          <Typography.Text type="secondary">
            可跟随平台默认，或固定到已保存的模型版本。固定后不随平台默认模型切换。
          </Typography.Text>
        </div>
      </Card>
      <Card title="工具与 Skill">
        <div className="agent-fields">
          <label className="agent-field">
            <span>工具配置</span>
            <select
              value={content.tools.mode}
              onChange={(event) => {
                const tools: AgentRevisionContentDto["tools"] =
                  event.target.value !== "configured"
                    ? { mode: "platform_default" }
                    : initial?.tools.mode === "configured"
                      ? initial.tools
                      : {
                          mode: "configured",
                          builtinTools: [],
                          externalTools: [],
                          clientTools: [],
                          toolCallingMode: "native",
                        };
                const definitions = tools.mode === "configured" ? tools.clientTools : [];
                setClientToolSchemaDrafts(
                  definitions.map((t) => JSON.stringify(t.inputSchema, null, 2)),
                );
                setClientToolRowIds(definitions.map(() => crypto.randomUUID()));
                change("tools", tools);
              }}
            >
              <option value="platform_default">跟随平台运行设置</option>
              <option value="configured">显式选择工具</option>
            </select>
          </label>
          {configured && (
            <>
              <fieldset className="agent-tool-list">
                <legend>内置工具</legend>
                {RUNTIME_TOOL_CATALOG.filter(
                  (tool) =>
                    builtinToolLimit.includes(tool.name) ||
                    configured.builtinTools.includes(tool.name),
                ).map((tool) => (
                  <label key={tool.name}>
                    <input
                      type="checkbox"
                      checked={configured.builtinTools.includes(tool.name)}
                      onChange={(event) =>
                        change("tools", {
                          ...configured,
                          builtinTools: event.target.checked
                            ? [...configured.builtinTools, tool.name]
                            : configured.builtinTools.filter((name) => name !== tool.name),
                        })
                      }
                      disabled={
                        !builtinToolLimit.includes(tool.name) &&
                        !configured.builtinTools.includes(tool.name)
                      }
                    />
                    {tool.label}
                    {!builtinToolLimit.includes(tool.name) && "（平台已禁用）"}
                  </label>
                ))}
                {builtinToolLimit.length === 0 && unavailableTools.length === 0 && (
                  <Typography.Text type="secondary">平台未启用内置工具。</Typography.Text>
                )}
              </fieldset>
              <label className="agent-field">
                <span>工具调用模式</span>
                <select
                  value={configured.toolCallingMode}
                  onChange={(event) =>
                    change("tools", {
                      ...configured,
                      toolCallingMode: event.target.value === "ptc" ? "ptc" : "native",
                    })
                  }
                >
                  <option value="native">原生工具调用</option>
                  <option value="ptc">程序化工具调用</option>
                </select>
              </label>
              <fieldset className="agent-tool-list">
                <legend>客户端工具</legend>
                {configured.clientTools.map((tool, index) => (
                  <div className="agent-fields" key={clientToolRowIds[index]}>
                    <div className="agent-field">
                      <span>工具名称</span>
                      <Input
                        aria-label="客户端工具名称"
                        value={tool.name}
                        maxLength={100}
                        onChange={(event) =>
                          change("tools", {
                            ...configured,
                            clientTools: configured.clientTools.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, name: event.target.value } : item,
                            ),
                          })
                        }
                      />
                    </div>
                    <div className="agent-field">
                      <span>描述</span>
                      <Input
                        aria-label="客户端工具描述"
                        value={tool.description}
                        maxLength={1000}
                        onChange={(event) =>
                          change("tools", {
                            ...configured,
                            clientTools: configured.clientTools.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, description: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </div>
                    <div className="agent-field">
                      <span>参数 Schema（JSON）</span>
                      <Input.TextArea
                        aria-label="客户端工具参数 Schema"
                        rows={4}
                        value={clientToolSchemaDrafts[index] ?? ""}
                        onChange={(event) =>
                          setClientToolSchemaDrafts((previous) =>
                            previous.map((schema, schemaIndex) =>
                              schemaIndex === index ? event.target.value : schema,
                            ),
                          )
                        }
                      />
                    </div>
                    <div className="agent-field">
                      <span>等待时限（毫秒，可选；默认 300000）</span>
                      <Input
                        aria-label="客户端工具等待时限"
                        type="number"
                        min={1000}
                        max={86400000}
                        value={tool.waitTimeoutMs ?? ""}
                        onChange={(event) =>
                          change("tools", {
                            ...configured,
                            clientTools: configured.clientTools.map((item, itemIndex) =>
                              itemIndex === index
                                ? event.target.value === ""
                                  ? (() => {
                                      const { waitTimeoutMs: _waitTimeoutMs, ...rest } = item;
                                      return rest;
                                    })()
                                  : { ...item, waitTimeoutMs: Number(event.target.value) }
                                : item,
                            ),
                          })
                        }
                      />
                    </div>
                    <Button
                      htmlType="button"
                      onClick={() => {
                        change("tools", {
                          ...configured,
                          clientTools: configured.clientTools.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        });
                        setClientToolSchemaDrafts((previous) =>
                          previous.filter((_, itemIndex) => itemIndex !== index),
                        );
                        setClientToolRowIds((previous) =>
                          previous.filter((_, itemIndex) => itemIndex !== index),
                        );
                      }}
                    >
                      移除客户端工具
                    </Button>
                  </div>
                ))}
                <Button
                  htmlType="button"
                  disabled={configured.clientTools.length >= 64}
                  onClick={() => {
                    change("tools", {
                      ...configured,
                      clientTools: [
                        ...configured.clientTools,
                        {
                          name: "",
                          description: "",
                          inputSchema: {
                            type: "object",
                            properties: {},
                            additionalProperties: false,
                          },
                        },
                      ],
                    });
                    setClientToolSchemaDrafts((previous) => [
                      ...previous,
                      JSON.stringify(
                        { type: "object", properties: {}, additionalProperties: false },
                        null,
                        2,
                      ),
                    ]);
                    setClientToolRowIds((previous) => [...previous, crypto.randomUUID()]);
                  }}
                >
                  添加客户端工具
                </Button>
                {configured.clientTools.length > 0 && configured.toolCallingMode === "ptc" && (
                  <Typography.Text type="danger">
                    首版不支持 PTC 模式与客户端工具同时启用，请改用原生工具调用。
                  </Typography.Text>
                )}
              </fieldset>
            </>
          )}
          {configured && (
            <fieldset className="agent-tool-list">
              <legend>已发布外部工具</legend>
              {externalToolOptions.map((tool) => {
                const selected = configured.externalTools.some(
                  (item) => item.versionId === tool.toolVersionId,
                );
                return (
                  <label key={tool.toolVersionId}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(event) =>
                        change("tools", {
                          ...configured,
                          externalTools: event.target.checked
                            ? [
                                ...configured.externalTools,
                                { kind: tool.source, versionId: tool.toolVersionId },
                              ]
                            : configured.externalTools.filter(
                                (item) => item.versionId !== tool.toolVersionId,
                              ),
                        })
                      }
                    />
                    {tool.modelToolName} · {tool.batchName} · {tool.toolVersionId}
                    {tool.description && (
                      <Typography.Text type="secondary"> — {tool.description}</Typography.Text>
                    )}
                  </label>
                );
              })}
              {unavailableExternalTools.map((tool) => (
                <label key={tool.versionId}>
                  <input
                    type="checkbox"
                    checked
                    onChange={() =>
                      change("tools", {
                        ...configured,
                        externalTools: configured.externalTools.filter(
                          (selected) => selected.versionId !== tool.versionId,
                        ),
                      })
                    }
                  />
                  已不可选版本：{tool.versionId}（可能已撤销）
                </label>
              ))}
              {externalToolOptions.length === 0 && unavailableExternalTools.length === 0 && (
                <Typography.Text type="secondary">暂无可选的已发布外部工具。</Typography.Text>
              )}
            </fieldset>
          )}
          <Typography.Text type="secondary">
            HTTP 工具尚不能发布或加入 Agent。管理员可在「外部工具」页预览端点声明或 OpenAPI 片段。
          </Typography.Text>
          <AgentSkillSelector
            options={skillOptions}
            value={content.skillVersions}
            onChange={(value) => change("skillVersions", value)}
          />
          <label>
            <input
              type="checkbox"
              checked={content.includeTenantSkills}
              onChange={(event) => change("includeTenantSkills", event.target.checked)}
            />{" "}
            叠加 Tenant 已安装 Skill
          </label>
        </div>
      </Card>
      <Card title="执行设置">
        <div className="agent-fields">
          <label className="agent-field">
            <span>Sandbox 空闲策略</span>
            <select
              value={content.sandboxIdleAction}
              onChange={(event) =>
                change("sandboxIdleAction", event.target.value === "kill" ? "kill" : "pause")
              }
            >
              <option value="pause">暂停</option>
              <option value="kill">销毁</option>
            </select>
          </label>
          <label className="agent-field">
            <span>长期记忆</span>
            <select
              value={
                content.memory.mode === "platform_default"
                  ? "platform_default"
                  : content.memory.longTermEnabled
                    ? "enabled"
                    : "disabled"
              }
              onChange={(event) =>
                change(
                  "memory",
                  event.target.value === "platform_default"
                    ? { mode: "platform_default" }
                    : { mode: "configured", longTermEnabled: event.target.value === "enabled" },
                )
              }
            >
              <option value="platform_default">跟随平台设置</option>
              <option value="enabled">启用（受平台设置约束）</option>
              <option value="disabled">关闭</option>
            </select>
          </label>
        </div>
      </Card>
      {initial === undefined && (
        <Card title="可用范围">
          <AvailabilityFields
            mode={scope}
            text={tenantIds}
            onMode={setScope}
            onText={setTenantIds}
          />
        </Card>
      )}
      <Card title="版本说明">
        <label className="agent-field" htmlFor={`${formId}-version-notes`}>
          <span>版本说明（可选，最多 2000 字符）</span>
          <Input.TextArea
            id={`${formId}-version-notes`}
            rows={4}
            maxLength={2000}
            showCount
            value={versionNotes}
            onChange={(event) => setVersionNotes(event.target.value)}
            placeholder="这次改了什么？这个版本有什么特点？"
          />
        </label>
        <Typography.Text type="secondary">
          仅供后台管理，发布后不可修改，不会发送给模型。
        </Typography.Text>
      </Card>
      {error && <Alert type="error" showIcon title={error} />}
      <Space>
        <Button
          type="primary"
          htmlType="submit"
          loading={saving}
          disabled={Boolean(instructionError)}
        >
          保存新草稿
        </Button>
        <Button onClick={onCancel} disabled={saving}>
          取消
        </Button>
      </Space>
    </form>
  );
}

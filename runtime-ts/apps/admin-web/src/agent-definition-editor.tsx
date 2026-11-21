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

function skills(value: string): AgentRevisionContentDto["skillVersions"] {
  const versions = lines(value).map((line) => {
    const [skillId, version, ...rest] = line.split(/\s+/u);
    if (
      skillId === undefined ||
      !idPattern.test(skillId) ||
      version === undefined ||
      byteLength(version) > 64 ||
      rest.length > 0
    ) {
      throw new Error("请逐行填写 Skill ID 与精确版本，两者用空格分隔。");
    }
    return { skillId, version };
  });
  if (
    versions.length > 64 ||
    new Set(versions.map((item) => item.skillId)).size !== versions.length
  ) {
    throw new Error("最多可添加 64 个 Skill，每个 Skill 只能固定一个版本。");
  }
  return versions;
}

function pinnedModelKey(model: AgentPinnedModelReferenceDto): string {
  return JSON.stringify([model.providerKey, model.providerRevision, model.modelId]);
}

export function AgentDefinitionEditor({
  initial,
  builtinToolLimit,
  pinnedModelOptions,
  externalToolOptions = [],
  saving,
  onSave,
  onCancel,
}: {
  readonly initial?: AgentRevisionContentDto;
  readonly builtinToolLimit: readonly string[];
  readonly pinnedModelOptions: readonly AgentPinnedModelReferenceDto[];
  readonly externalToolOptions?: Readonly<AdminAgentDefinitionList["externalToolOptions"]>;
  readonly saving: boolean;
  readonly onSave: (
    content: AgentRevisionContentDto,
    availability?: AdminSetAgentAvailability["availability"],
  ) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [content, setContent] = useState(initial ?? initialContent);
  const [questions, setQuestions] = useState(content.suggestedQuestions.join("\n"));
  const [skillVersions, setSkillVersions] = useState(
    content.skillVersions.map(({ skillId, version }) => `${skillId} ${version}`).join("\n"),
  );
  const [scope, setScope] = useState("all_tenants");
  const [tenantIds, setTenantIds] = useState("");
  const [error, setError] = useState<string>();
  const formId = useId();
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
      await onSave(
        { ...content, suggestedQuestions, skillVersions: skills(skillVersions) },
        initial === undefined ? parseAvailability(scope, tenantIds) : undefined,
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
              onChange={(event) =>
                change(
                  "tools",
                  event.target.value === "configured"
                    ? initial?.tools.mode === "configured"
                      ? initial.tools
                      : {
                          mode: "configured",
                          builtinTools: [],
                          externalTools: [],
                          clientTools: [],
                          toolCallingMode: "native",
                        }
                    : { mode: "platform_default" },
                )
              }
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
          <label className="agent-field" htmlFor={`${formId}-skills`}>
            <span>自带 Skill（每行填写 Skill ID 和版本）</span>
            <Input.TextArea
              id={`${formId}-skills`}
              rows={3}
              value={skillVersions}
              onChange={(event) => setSkillVersions(event.target.value)}
            />
          </label>
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

// @vitest-environment jsdom

import type { AgentDefinitionDto, AgentRevisionDto } from "@hoox/protocol";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, settle, button, field, enter, select } from "./testing/admin-component.js";
import { AgentDefinitionEditor } from "./agent-definition-editor.js";
import { AgentSkillSelector } from "./agent-skill-selector.js";
import { AgentDefinitionsPage } from "./agent-definitions.js";
import type { SkillAdminApiContract } from "./api.js";
import { App } from "./app.js";
import { AdminControlApi, type AgentDefinitionApiContract } from "./control-api.js";

const timestamp = "2026-11-20T00:00:00.000Z";
const definition: AgentDefinitionDto = {
  id: "agent_example",
  status: "published",
  currentRevisionId: "revision_second",
  generation: 3,
  availability: { mode: "selected_tenants", tenantIds: ["tenant_test"] },
  createdAt: timestamp,
  updatedAt: timestamp,
};
const current: AgentRevisionDto = {
  id: "revision_second",
  definitionId: definition.id,
  revision: 2,
  status: "published",
  digest: "b".repeat(64),
  createdAt: timestamp,
  createdBy: "user_example",
  versionNotes: "新增模型能力",
  content: {
    displayName: "新版助手",
    description: "示例简介",
    operatorInstructions: "新版指令",
    replyLanguage: "zh-CN",
    suggestedQuestions: [],
    model: { mode: "platform_default" },
    tools: { mode: "platform_default" },
    skillVersions: [],
    includeTenantSkills: true,
    sandboxIdleAction: "pause",
    memory: { mode: "platform_default" },
  },
};
const previous: AgentRevisionDto = {
  ...current,
  id: "revision_first",
  revision: 1,
  digest: "a".repeat(64),
  content: { ...current.content, displayName: "旧版助手", operatorInstructions: "旧版指令" },
  versionNotes: "初始版本",
};

function summary({ content, versionNotes, ...rest }: AgentRevisionDto) {
  return {
    ...rest,
    displayName: content.displayName,
    ...(rest.id === previous.id || versionNotes === undefined ? {} : { versionNotes }),
    changedSections: ["instructions", "display"] as ("instructions" | "display")[],
  };
}

function fixture(canManage: boolean) {
  return {
    listAgentDefinitions: vi.fn(async () => ({
      canManage,
      builtinToolLimit: ["read"],
      pinnedModelOptions: [],
      externalToolOptions: [],
      skillOptions: [
        {
          skillId: "skill_notes",
          displayName: "会议纪要",
          description: "整理会议记录",
          versions: ["2.0.0", "1.0.0"],
        },
      ],
      items: [{ definition, revision: summary(current) }],
    })),
    listAgentRevisions: vi.fn(async () => ({
      definition,
      items: [summary(current), summary(previous)],
    })),
    readAgentRevision: vi.fn(async (_id: string, revisionId: string) =>
      revisionId === current.id ? current : previous,
    ),
    createAgentDefinition: vi.fn(async () => ({ definition, revision: current })),
    saveAgentRevision: vi.fn(async () => current),
    publishAgentRevision: vi.fn(async () => definition),
    listEvaluationSuites: vi.fn(async () => []),
    deactivateAgentDefinition: vi.fn(async () => definition),
    revokeAgentRevision: vi.fn(async () => definition),
    setAgentAvailability: vi.fn(async () => definition),
  } satisfies AgentDefinitionApiContract;
}

describe("后台 Agent 管理", () => {
  it("增删客户端工具并保存编辑后的 Schema 与等待时限", async () => {
    const onSave = vi.fn(async () => undefined);
    const view = render(
      <AgentDefinitionEditor
        initial={current.content}
        builtinToolLimit={[]}
        pinnedModelOptions={[]}
        saving={false}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );
    select(field<HTMLSelectElement>(view, "工具配置"), "configured");
    const add = () => act(() => button(view, "添加客户端工具").click());
    add();
    add();
    act(() => button(view, "移除客户端工具").click());
    const byLabel = (label: string) => {
      const el = view.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[aria-label="${label}"]`,
      );
      if (!el) throw new Error("缺少客户端工具字段");
      return el;
    };
    enter(byLabel("客户端工具名称"), "lookup");
    enter(byLabel("客户端工具描述"), "客户端查询");
    enter(byLabel("客户端工具等待时限"), "1500");
    enter(byLabel("客户端工具参数 Schema"), "invalid");
    act(() => button(view, "保存新草稿").click());
    await settle();
    expect(onSave).not.toHaveBeenCalled();
    const schema = { type: "object", properties: {}, additionalProperties: false };
    enter(byLabel("客户端工具参数 Schema"), JSON.stringify(schema));
    act(() => button(view, "保存新草稿").click());
    await settle();
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          clientTools: [
            { name: "lookup", description: "客户端查询", waitTimeoutMs: 1500, inputSchema: schema },
          ],
        }),
      }),
      undefined,
      "",
    );
  });
  it("viewer 只查看列表与版本差异，不提供管理操作", async () => {
    const api = fixture(false);
    const onOpen = vi.fn();
    const list = render(
      <AgentDefinitionsPage
        api={api}
        destination={{ kind: "list" }}
        onOpen={onOpen}
        onBack={vi.fn()}
      />,
    );
    const history = render(
      <AgentDefinitionsPage
        api={api}
        destination={{ kind: "detail", id: definition.id }}
        onOpen={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await settle();
    expect(list.textContent).toContain("指定 Tenant（1）");
    expect(list.textContent).not.toContain("新建 Agent");
    act(() => button(list, "查看版本").click());
    expect(onOpen).toHaveBeenCalledWith(definition.id);
    expect(history.textContent).not.toContain("编辑为新草稿");
    expect(history.textContent).not.toContain("撤销");
    expect(history.textContent).not.toContain("设置可用范围");
    select(field<HTMLSelectElement>(history, "对比版本"), previous.id);
    await settle();
    expect(history.textContent).toContain("旧版指令");
    expect(history.textContent).toContain("新增模型能力");
    expect(history.textContent).toContain("改动：指令、展示信息");
    expect(history.textContent).toContain("未填写版本说明");
    expect(history.textContent).toContain("新版指令");
    expect(history.textContent).not.toContain("示例简介");
    expect(api.readAgentRevision).toHaveBeenCalledWith(definition.id, previous.id);
  });

  it("后台详情路径保留 Agent 分组菜单选中项", async () => {
    const api = fixture(false);
    const container = render(
      <App
        apiClient={{} as SkillAdminApiContract}
        agentApi={api}
        initialPath={`/agent-definitions/${definition.id}`}
      />,
    );
    await settle();
    expect(api.listAgentRevisions).toHaveBeenCalledWith(definition.id);
    expect(container.querySelector(".ant-menu-item-selected")?.textContent).toContain("Agent 管理");
  });

  it("超过 UTF-8 字节上限时禁止提交，且工具选择不越过平台上限", async () => {
    const onSave = vi.fn(async () => undefined);
    const container = render(
      <AgentDefinitionEditor
        initial={current.content}
        builtinToolLimit={["read"]}
        pinnedModelOptions={[]}
        saving={false}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );
    const instructions = field<HTMLTextAreaElement>(container, "Operator 指令");
    enter(instructions, "字".repeat(11_000));
    expect(instructions.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("超出字节上限");
    expect(button(container, "保存新草稿").disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
    enter(instructions, "新草稿使用中文回答");
    enter(
      field<HTMLTextAreaElement>(container, "版本说明（可选，最多 2000 字符）"),
      "补充了新行为",
    );
    select(field<HTMLSelectElement>(container, "工具配置"), "configured");
    expect(container.textContent).not.toContain("执行命令");
    act(() => field<HTMLInputElement>(container, "读取文件").click());
    act(() => button(container, "保存新草稿").click());
    await settle();
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorInstructions: "新草稿使用中文回答",
        tools: expect.objectContaining({ builtinTools: ["read"] }),
      }),
      undefined,
      "补充了新行为",
    );
  });

  it("Agent 工具选择只呈现传入的已发布外部工具最小信息", async () => {
    const onSave = vi.fn(async () => undefined);
    const container = render(
      <AgentDefinitionEditor
        initial={current.content}
        builtinToolLimit={[]}
        pinnedModelOptions={[]}
        externalToolOptions={[
          {
            toolVersionId: "published-tool-v1",
            source: "mcp",
            modelToolName: "mcp__docs__search",
            description: "搜索文档",
            batchName: "文档 MCP",
          },
        ]}
        saving={false}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );
    select(field<HTMLSelectElement>(container, "工具配置"), "configured");
    expect(container.textContent).toContain("mcp__docs__search · 文档 MCP");
    expect(container.textContent).not.toContain("inputSchema");
    expect(container.textContent).not.toContain("凭据");
    act(() => field<HTMLInputElement>(container, "mcp__docs__search").click());
    act(() => button(container, "保存新草稿").click());
    await settle();
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          externalTools: [{ kind: "mcp", versionId: "published-tool-v1" }],
        }),
      }),
      undefined,
      "",
    );
  });

  it("已撤销的历史引用不能再次保存，移除后才可提交", async () => {
    const onSave = vi.fn(async () => undefined);
    const container = render(
      <AgentDefinitionEditor
        initial={{
          ...current.content,
          tools: {
            mode: "configured",
            builtinTools: [],
            clientTools: [],
            toolCallingMode: "native",
            externalTools: [{ kind: "mcp", versionId: "old_version" }],
          },
        }}
        builtinToolLimit={[]}
        pinnedModelOptions={[]}
        externalToolOptions={[]}
        saving={false}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );
    act(() => button(container, "保存新草稿").click());
    expect(onSave).not.toHaveBeenCalled();
    expect(container.textContent).toContain("请移除已不可选的外部工具版本");
    act(() => field<HTMLInputElement>(container, "已不可选版本：old_version").click());
    act(() => button(container, "保存新草稿").click());
    await settle();
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ tools: expect.objectContaining({ externalTools: [] }) }),
      undefined,
      "",
    );
  });

  it("保存所选已配置模型的完整固定引用，并可改回平台默认", async () => {
    const onSave = vi.fn(async () => undefined);
    const pinned = {
      mode: "pinned",
      providerKey: "main",
      providerRevision: 2,
      modelId: "model-a",
    } as const;
    const container = render(
      <AgentDefinitionEditor
        initial={current.content}
        builtinToolLimit={[]}
        pinnedModelOptions={[{ ...pinned, providerRevision: 1 }, pinned]}
        saving={false}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );
    const model = field<HTMLSelectElement>(container, "模型");
    const choice = Array.from(model.options).find((option) => option.text.includes("版本 2"));
    if (!choice) throw new Error("未找到固定模型版本");
    select(model, choice.value);
    select(field<HTMLSelectElement>(container, "长期记忆"), "disabled");
    act(() => button(container, "保存新草稿").click());
    await settle();
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: pinned,
        memory: { mode: "configured", longTermEnabled: false },
      }),
      undefined,
      "",
    );
    select(model, "platform_default");
    act(() => button(container, "保存新草稿").click());
    await settle();
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: { mode: "platform_default" } }),
      undefined,
      "",
    );
  });

  it("Skill 选择器搜索目录、默认最新版本并允许切换和移除", () => {
    const onChange = vi.fn();
    const container = render(
      <AgentSkillSelector
        options={[
          {
            skillId: "skill_notes",
            displayName: "会议纪要",
            description: "整理会议记录",
            versions: ["2.0.0", "1.0.0"],
          },
        ]}
        value={[]}
        onChange={onChange}
      />,
    );
    expect(container.textContent).toContain("整理会议记录");
    act(() => button(container, "添加 会议纪要").click());
    expect(onChange).toHaveBeenLastCalledWith([{ skillId: "skill_notes", version: "2.0.0" }]);

    const selected = render(
      <AgentSkillSelector
        options={[
          {
            skillId: "skill_notes",
            displayName: "会议纪要",
            description: "整理会议记录",
            versions: ["2.0.0", "1.0.0"],
          },
        ]}
        value={[{ skillId: "skill_notes", version: "2.0.0" }]}
        onChange={onChange}
      />,
    );
    select(field<HTMLSelectElement>(selected, "会议纪要 的版本"), "1.0.0");
    expect(onChange).toHaveBeenLastCalledWith([{ skillId: "skill_notes", version: "1.0.0" }]);
    act(() => button(selected, "移除 会议纪要").click());
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("目录为空时引导管理员发布 Skill", () => {
    const container = render(<AgentSkillSelector options={[]} value={[]} onChange={vi.fn()} />);
    expect(container.textContent).toContain("请前往「Skills」页面发布");
  });

  it("发布时保留草稿已固定的版本说明", async () => {
    const api = fixture(true);
    api.listAgentRevisions.mockResolvedValue({
      definition,
      items: [{ ...summary(current), status: "draft" }],
    });
    const container = render(
      <AgentDefinitionsPage
        api={api}
        destination={{ kind: "detail", id: definition.id }}
        onOpen={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await settle();
    act(() => button(container, "发布").click());
    await settle();
    act(() => button(document.body, "确认发布").click());
    await settle();
    expect(api.publishAgentRevision).toHaveBeenCalledWith(definition.id, current.id, {
      expectedGeneration: definition.generation,
    });
  });

  it("发布确认说明评测门槛会在发布事务中验证", async () => {
    const api = fixture(true);
    api.listAgentRevisions.mockResolvedValue({
      definition,
      items: [{ ...summary(current), status: "draft" }],
    });
    const container = render(
      <AgentDefinitionsPage
        api={api}
        destination={{ kind: "detail", id: definition.id }}
        onOpen={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await settle();
    act(() => button(container, "发布").click());
    await settle();
    expect(document.body.textContent).toContain("完整评测结果");
    expect(api.listEvaluationSuites).toHaveBeenCalledWith(definition.id);
  });

  it("设置 Tenant 范围提交读取时的 generation", async () => {
    const api = fixture(true);
    const container = render(
      <AgentDefinitionsPage
        api={api}
        destination={{ kind: "detail", id: definition.id }}
        onOpen={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await settle();
    act(() => button(container, "设置可用范围").click());
    enter(field<HTMLTextAreaElement>(container, "Tenant ID"), "tenant_first\ntenant_second");
    act(() => button(container, "保存可用范围").click());
    await settle();
    expect(api.setAgentAvailability).toHaveBeenCalledWith(definition.id, {
      expectedGeneration: 3,
      availability: { mode: "selected_tenants", tenantIds: ["tenant_first", "tenant_second"] },
    });
  });

  it("紧急撤销必须显式确认并告知在途 Run 的后果", async () => {
    const api = fixture(true);
    const container = render(
      <AgentDefinitionsPage
        api={api}
        destination={{ kind: "detail", id: definition.id }}
        onOpen={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await settle();
    act(() => button(container, "撤销").click());
    await settle();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) throw new Error("未打开撤销确认");
    expect(dialog.textContent).toContain("将在下一个安全点失败关闭");
    expect(dialog.textContent).toContain("不再接受新 Run");
    expect(button(dialog, "确认撤销").disabled).toBe(true);
    expect(api.revokeAgentRevision).not.toHaveBeenCalled();
    enter(field<HTMLTextAreaElement>(dialog, "撤销原因"), "  配置已过时  ");
    act(() => button(dialog, "确认撤销").click());
    await settle();
    expect(api.revokeAgentRevision).toHaveBeenCalledExactlyOnceWith(definition.id, current.id, {
      expectedGeneration: 3,
      reason: "配置已过时",
    });
  });

  it("写入结果未知时重试保留幂等键和请求内容", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(Response.json({ data: definition }));
    const api = new AdminControlApi(
      fetcher,
      undefined,
      () => "agent-web-idempotency",
      () => undefined,
    );
    const save = () =>
      api.setAgentAvailability(definition.id, {
        expectedGeneration: 3,
        availability: definition.availability,
      });
    await expect(save()).rejects.toMatchObject({ retryable: true });
    await expect(save()).resolves.toEqual(definition);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/v1/admin/control/agent-definitions/agent_example/availability",
    );
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("idempotency-key")).toBe(
      "agent-web-idempotency",
    );
    expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
  });
});

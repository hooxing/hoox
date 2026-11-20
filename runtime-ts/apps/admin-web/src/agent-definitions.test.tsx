// @vitest-environment jsdom

import type { AgentDefinitionDto, AgentRevisionDto } from "@hoox/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDefinitionEditor } from "./agent-definition-editor.js";
import { AgentDefinitionsPage } from "./agent-definitions.js";
import type { SkillAdminApiContract } from "./api.js";
import { App } from "./app.js";
import { AdminControlApi, type AgentDefinitionApiContract } from "./control-api.js";

const roots: Root[] = [];
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
};

function summary({ content, ...rest }: AgentRevisionDto) {
  return { ...rest, displayName: content.displayName };
}

function fixture(canManage: boolean) {
  return {
    listAgentDefinitions: vi.fn(async () => ({
      canManage,
      builtinToolLimit: ["read"],
      pinnedModelOptions: [],
      externalToolOptions: [],
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
    deactivateAgentDefinition: vi.fn(async () => definition),
    revokeAgentRevision: vi.fn(async () => definition),
    setAgentAvailability: vi.fn(async () => definition),
  } satisfies AgentDefinitionApiContract;
}

function render(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>));
  return container;
}

async function settle() {
  for (let index = 0; index < 5; index++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function button(root: ParentNode, name: string) {
  const result = Array.from(root.querySelectorAll("button")).find(
    (item) => item.textContent?.replace(/\s+/gu, "") === name.replace(/\s+/gu, ""),
  );
  if (!result) throw new Error(`未找到按钮：${name}`);
  return result;
}

function field<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
  root: ParentNode,
  name: string,
) {
  const result = Array.from(root.querySelectorAll("label"))
    .find((item) => item.textContent?.startsWith(name))
    ?.querySelector<T>("input, textarea, select");
  if (!result) throw new Error(`未找到字段：${name}`);
  return result;
}

function enter(input: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function select(input: HTMLSelectElement, value: string) {
  act(() => {
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => computedStyle(element));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addListener() {}, removeListener() {} })),
  );
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("后台 Agent 管理", () => {
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
    );
  });

  it("Agent 工具选择只呈现传入的已发布外部工具最小信息", () => {
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
        onSave={vi.fn(async () => undefined)}
        onCancel={vi.fn()}
      />,
    );
    select(field<HTMLSelectElement>(container, "工具配置"), "configured");
    expect(container.textContent).toContain("mcp__docs__search · 文档 MCP");
    expect(container.textContent).not.toContain("inputSchema");
    expect(container.textContent).not.toContain("凭据");
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
    );
    select(model, "platform_default");
    act(() => button(container, "保存新草稿").click());
    await settle();
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: { mode: "platform_default" } }),
      undefined,
    );
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

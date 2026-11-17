// @vitest-environment jsdom

import type {
  MemoryProviderRevisionDto,
  ModelProviderRevisionDto,
  PiModelCatalogModelDto,
  RuntimeSettingsRevisionDto,
  RuntimeToolName,
} from "@hoox/protocol";
import { RUNTIME_TOOL_CATALOG } from "@hoox/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiError } from "./api.js";
import { App } from "./app.js";
import type { AdminControlApiContract } from "./control-api.js";

const overview = {
  generation: 3,
  statistics: {
    generatedAt: "2026-08-19T00:00:00.000Z",
    users: { total: 7, registered24h: 2, active7d: 5, disabled: 1 },
    conversations: { total: 23, created24h: 4, active24h: 9, archived: 3 },
    runs: { total: 12, queued: 1, running: 2, succeeded24h: 8, failed24h: 1, cancelled24h: 0 },
    dispatch: { pending: 1, claimed: 2 },
    sandboxes: { active: 2, paused: 1, cleanupPending: 0 },
    memory: { pending: 3, failed: 0 },
    automations: { active: 4, failedOccurrences24h: 0 },
    skills: { published: 5, installed: 6 },
    modelUsage24h: {
      inputTokens: 12_500,
      outputTokens: 2_500,
      outputTokensPerSecond: 62.5,
      cacheHitRate: 0.8,
    },
  },
  deploymentSettings: [
    {
      key: "MODEL_API_KEY",
      category: "secret" as const,
      source: "environment" as const,
      configured: true,
      mutable: false as const,
      description: "模型 Provider 部署秘密，页面只保存引用",
    },
    {
      key: "MEM0_API_KEY",
      category: "secret" as const,
      source: "environment" as const,
      configured: true,
      mutable: false as const,
      description: "Mem0 API Key",
    },
    {
      key: "MEM0_SCOPE_HMAC_KEY",
      category: "secret" as const,
      source: "environment" as const,
      configured: false,
      mutable: false as const,
      description: "Mem0 scope key",
    },
  ],
};

function fixture(): AdminControlApiContract {
  return {
    overview: vi.fn(async () => overview),
    getIdentityConfiguration: vi.fn(async () => ({
      versionToken: 0,
      emailPasswordEnabled: true,
      emailVerificationEnabled: false,
      smtpPort: 465,
      smtpSecure: true,
      smtpPasswordConfigured: false,
      registrationEnabled: true,
      phoneEnabled: false,
      smsWebhookSecretConfigured: false,
      providers: [
        { key: "google" as const, enabled: false, clientId: "", secretConfigured: false },
        { key: "github" as const, enabled: false, clientId: "", secretConfigured: false },
        { key: "wechat" as const, enabled: false, clientId: "", secretConfigured: false },
        { key: "qq" as const, enabled: false, clientId: "", secretConfigured: false },
      ],
    })),
    updateIdentityConfiguration: vi.fn(),
    listModelProviders: vi.fn(async () => []),
    listPiModelCatalogProviders: vi.fn(async () => [
      {
        providerId: "deepseek",
        displayName: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        modelCount: 2,
      },
    ]),
    findPiModelCatalogModels: vi.fn(async () => []),
    listMemoryProviders: vi.fn(async () => []),
    listRuntimeSettings: vi.fn(async () => []),
    listAudits: vi.fn(async () => []),
    listUsers: vi.fn(async () => ({
      total: 1,
      items: [
        {
          userId: "user_customer",
          email: "customer@example.com",
          displayName: "测试用户",
          status: "active" as const,
          createdAt: "2026-08-18T00:00:00.000Z",
          lastActiveAt: "2026-08-20T00:00:00.000Z",
          activeSessions: 1,
          conversationCount: 3,
          runCount: 9,
        },
      ],
    })),
    updateUserStatus: vi.fn(async (_userId, input) => ({
      userId: "user_customer",
      email: "customer@example.com",
      displayName: "测试用户",
      status: input.status,
      createdAt: "2026-08-18T00:00:00.000Z",
      lastActiveAt: "2026-08-20T00:00:00.000Z",
      activeSessions: input.status === "active" ? 1 : 0,
      conversationCount: 3,
      runCount: 9,
    })),
    saveModelConfiguration: vi.fn(
      async (input: Parameters<AdminControlApiContract["saveModelConfiguration"]>[0]) => ({
        revision: 1,
        versionToken: 2,
        status: "active" as const,
        probeStatus: "untested" as const,
        createdBy: "user_admin",
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:00.000Z",
        configuration: {
          providerKey: input.providerKey,
          displayName: input.displayName,
          protocol: input.protocol,
          baseUrl: input.baseUrl,
          credentialConfigured: true,
          defaultModelId: input.defaultModelId,
          models: input.models,
        },
      }),
    ),
    saveMemoryConfiguration: vi.fn(),
    saveRuntimeSettingsConfiguration: vi.fn(),
    createModelDraft: vi.fn(),
    createMemoryDraft: vi.fn(),
    createRuntimeSettingsDraft: vi.fn(),
    probe: vi.fn(),
    publish: vi.fn(),
  };
}

function modelRevision(
  providerKey: string,
  probeStatus: ModelProviderRevisionDto["probeStatus"],
): ModelProviderRevisionDto {
  return {
    revision: 1,
    versionToken: 2,
    status: "draft",
    probeStatus,
    createdBy: "user_admin",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:01:00.000Z",
    configuration: {
      providerKey,
      displayName: providerKey === "openrouter" ? "OpenRouter" : "DeepSeek",
      protocol: "openai-compatible",
      baseUrl: "https://model.example.com/v1",
      credentialConfigured: true,
      defaultModelId: "model-a",
      models: [
        {
          id: "model-a",
          name: "Model A",
          enabled: true,
          reasoning: false,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await act(async () => Promise.resolve());
}

function changeControl(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
}

function requiredControl<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
  control: T | null | undefined,
  name: string,
): T {
  if (control === null || control === undefined) throw new Error(`${name}字段缺失`);
  return control;
}

function navigationItem(container: HTMLElement, label: string): HTMLElement {
  const item = [...container.querySelectorAll<HTMLElement>(".ant-menu-item")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (item === undefined) throw new Error(`${label}导航缺失`);
  return item;
}

function runtimeSettingsRevision(enabledTools?: RuntimeToolName[]): RuntimeSettingsRevisionDto {
  return {
    revision: 1,
    versionToken: 1,
    status: "active",
    probeStatus: "untested",
    createdBy: "user_admin",
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
    configuration: {
      workerMaxConcurrentRuns: 20,
      userMaxConcurrentRunsPerTenant: 2,
      compactionSoftLimitPercent: 80,
      compactionTargetPercent: 55,
      compactionRecentUserTokens: 4096,
      compactionMaxOutputTokens: 4096,
      compactionTimeoutMs: 60000,
      ...(enabledTools === undefined ? {} : { enabledTools }),
    },
  };
}

async function mountRuntimeSettings(api: AdminControlApiContract) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<App controlApi={api} />));
  await settle();
  act(() => navigationItem(container, "运行设置").click());
  await settle();
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function runtimeToolCheckboxes(container: HTMLElement): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>('input[name="enabledTools"]')];
}

function selectedRuntimeTools(container: HTMLElement): string[] {
  return runtimeToolCheckboxes(container)
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.value);
}

function runtimeToolAction(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button[type="button"]')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (button === undefined) throw new Error(`${label}按钮缺失`);
  return button;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

describe("统一平台管理导航", () => {
  it("标题模型复用已保存供应商，压缩开关和关闭标题可以保存往返", async () => {
    const api = fixture();
    vi.mocked(api.listModelProviders).mockResolvedValue([modelRevision("titles", "healthy")]);
    let active: RuntimeSettingsRevisionDto | undefined;
    vi.mocked(api.overview).mockImplementation(async () => ({
      ...overview,
      ...(active ? { activeRuntimeSettings: active } : {}),
    }));
    vi.mocked(api.saveRuntimeSettingsConfiguration).mockImplementation(async (input) => {
      const { expectedGeneration: _generation, ...configuration } = input;
      active = {
        revision: (active?.revision ?? 0) + 1,
        versionToken: 1,
        status: "active",
        probeStatus: "untested",
        createdBy: "admin",
        createdAt: "2026-11-15T00:00:00.000Z",
        updatedAt: "2026-11-15T00:00:00.000Z",
        configuration,
      };
      return active;
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();
    act(() => navigationItem(container, "运行设置").click());
    await settle();
    const title = { enabled: true, providerKey: "titles", providerRevision: 1, modelId: "model-a" };
    for (const [selection, compactionEnabled] of [
      [JSON.stringify(title), false],
      ["disabled", true],
    ] as const) {
      act(() => {
        const select = requiredControl(
          container.querySelector<HTMLSelectElement>('select[name="titleGeneration"]'),
          "标题模型",
        );
        select.value = selection;
        const checkbox = requiredControl(
          container.querySelector<HTMLInputElement>('input[name="compactionEnabled"]'),
          "压缩开关",
        );
        checkbox.checked = compactionEnabled;
        container
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      await settle();
      expect(api.saveRuntimeSettingsConfiguration).toHaveBeenLastCalledWith(
        expect.objectContaining({
          titleGeneration: selection === "disabled" ? { enabled: false } : title,
          compactionEnabled,
        }),
      );
      expect(
        container.querySelector<HTMLSelectElement>('select[name="titleGeneration"]')?.value,
      ).toBe(selection);
      expect(
        container.querySelector<HTMLInputElement>('input[name="compactionEnabled"]')?.checked,
      ).toBe(compactionEnabled);
    }
    expect(container.querySelector('input[name="apiKey"]')).toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it("运行设置从默认值直接保存，没有变更原因或发布步骤", async () => {
    const api = fixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();
    act(() => navigationItem(container, "运行设置").click());
    await settle();
    expect(container.textContent).toContain("保存后无需重启");
    expect(container.textContent).not.toContain("变更原因");
    expect(container.querySelector('input[name="workerMaxConcurrentRuns"]')).toHaveProperty(
      "value",
      "20",
    );
    const form = container.querySelector("form");
    act(() => form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(api.saveRuntimeSettingsConfiguration).toHaveBeenCalledOnce();
    expect(vi.mocked(api.saveRuntimeSettingsConfiguration).mock.calls[0]?.[0]).toMatchObject({
      workerMaxConcurrentRuns: 20,
      userMaxConcurrentRunsPerTenant: 2,
      compactionSoftLimitPercent: 80,
      compactionTargetPercent: 55,
      compactionRecentUserTokens: 4096,
      compactionMaxOutputTokens: 4096,
      compactionTimeoutMs: 60000,
      enabledTools: RUNTIME_TOOL_CATALOG.map((tool) => tool.name),
    });
    expect(vi.mocked(api.saveRuntimeSettingsConfiguration).mock.calls[0]?.[0].toolCallingMode).toBe(
      "native",
    );
    expect(api.createRuntimeSettingsDraft).not.toHaveBeenCalled();
    expect(api.publish).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  });
  it.each(["native", "ptc", undefined] as const)(
    "运行设置读取模式 %s，并支持正常与 PTC 保存往返",
    async (initialMode) => {
      const api = fixture();
      let active: RuntimeSettingsRevisionDto = {
        revision: 1,
        versionToken: 1,
        status: "active",
        probeStatus: "untested",
        createdBy: "user_admin",
        createdAt: "2026-10-04T00:00:00.000Z",
        updatedAt: "2026-10-04T00:00:00.000Z",
        configuration: {
          workerMaxConcurrentRuns: 20,
          userMaxConcurrentRunsPerTenant: 2,
          compactionSoftLimitPercent: 80,
          compactionTargetPercent: 55,
          compactionRecentUserTokens: 4096,
          compactionMaxOutputTokens: 4096,
          compactionTimeoutMs: 60000,
          ...(initialMode === undefined ? {} : { toolCallingMode: initialMode }),
        },
      };
      vi.mocked(api.overview).mockImplementation(async () => ({
        ...overview,
        generation: active.revision,
        activeRuntimeSettings: active,
      }));
      vi.mocked(api.saveRuntimeSettingsConfiguration).mockImplementation(async (input) => {
        const { expectedGeneration: _generation, ...configuration } = input;
        active = { ...active, revision: active.revision + 1, configuration };
        return active;
      });
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      act(() => root.render(<App controlApi={api} />));
      await settle();
      act(() => navigationItem(container, "运行设置").click());
      await settle();
      const modeSelect = () =>
        requiredControl(
          container.querySelector<HTMLSelectElement>('select[name="toolCallingMode"]'),
          "工具调用模式",
        );
      expect(modeSelect().value).toBe(initialMode ?? "native");
      expect(container.querySelector('label[for="runtime-tool-calling-mode"]')?.textContent).toBe(
        "工具调用模式",
      );
      expect(
        Array.from(modeSelect().options).map((option) => [option.value, option.textContent]),
      ).toEqual([
        ["native", "正常模式"],
        ["ptc", "PTC 模式（实验）"],
      ]);
      const description = document.getElementById(
        modeSelect().getAttribute("aria-describedby") ?? "",
      );
      expect(description?.textContent).toContain("首次建立 Run 配置快照时固定");
      expect(description?.textContent).toContain("已有快照的 Run 执行和恢复均保持原模式");
      for (const toolCallingMode of ["ptc", "native"] as const) {
        const expectedGeneration = active.revision;
        act(() => {
          modeSelect().value = toolCallingMode;
          modeSelect().dispatchEvent(new Event("change", { bubbles: true }));
          container
            .querySelector("form")
            ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        });
        await settle();
        expect(api.saveRuntimeSettingsConfiguration).toHaveBeenLastCalledWith(
          expect.objectContaining({ toolCallingMode, expectedGeneration }),
        );
        expect(modeSelect().value).toBe(toolCallingMode);
        expect(modeSelect().disabled).toBe(false);
        expect(modeSelect().closest("fieldset")?.disabled).toBe(false);
      }
      expect(api.saveRuntimeSettingsConfiguration).toHaveBeenCalledTimes(2);
      expect(api.createRuntimeSettingsDraft).not.toHaveBeenCalled();
      expect(api.publish).not.toHaveBeenCalled();
      act(() => root.unmount());
      container.remove();
    },
  );

  it.each<{ label: string; enabledTools: RuntimeToolName[] | undefined }>([
    { label: "旧配置缺省时全选", enabledTools: undefined },
    { label: "部分工具", enabledTools: ["read", "todo_write", "wait_agent"] },
    { label: "显式空名单全部关闭", enabledTools: [] },
  ])("运行工具读取并保存：$label", async ({ enabledTools }) => {
    const api = fixture();
    let active = runtimeSettingsRevision(enabledTools);
    vi.mocked(api.overview).mockImplementation(async () => ({
      ...overview,
      generation: active.revision,
      activeRuntimeSettings: active,
    }));
    vi.mocked(api.saveRuntimeSettingsConfiguration).mockImplementation(async (input) => {
      const { expectedGeneration: _generation, ...configuration } = input;
      active = { ...active, revision: active.revision + 1, configuration };
      return active;
    });
    const { container, unmount } = await mountRuntimeSettings(api);
    const expected = RUNTIME_TOOL_CATALOG.filter(
      (tool) => enabledTools === undefined || enabledTools.includes(tool.name),
    ).map((tool) => tool.name);
    expect(selectedRuntimeTools(container)).toEqual(expected);
    expect(runtimeToolCheckboxes(container).map((checkbox) => checkbox.value)).toEqual([
      "exec_command",
      "read",
      "edit",
      "write",
      "skill",
      "todo_write",
      "deliver_file",
      "automation_update",
      "spawn_agent",
      "send_message",
      "followup_task",
      "wait_agent",
      "interrupt_agent",
      "list_agents",
    ]);
    expect(
      [...container.querySelectorAll(".runtime-tool-group legend")].map(
        (legend) => legend.textContent,
      ),
    ).toEqual(["文件与命令", "任务与交付", "智能体协作"]);
    for (const tool of RUNTIME_TOOL_CATALOG) {
      const checkbox = requiredControl(
        runtimeToolCheckboxes(container).find((item) => item.value === tool.name),
        tool.name,
      );
      expect(checkbox.closest("label")?.textContent).toContain(tool.label);
      expect(checkbox.closest("label")?.textContent).toContain(tool.name);
      expect(
        document.getElementById(checkbox.getAttribute("aria-describedby") ?? "")?.textContent,
      ).toBe(tool.description);
    }
    expect(container.querySelector('input[value="run_code"]')).toBeNull();
    expect(container.querySelector('input[value="collapse_process_for_final_answer"]')).toBeNull();
    const description = container.querySelector(".runtime-tool-selection")?.textContent ?? "";
    expect(description).toContain("正常模式与 PTC 模式共用此工具名单");
    expect(description).toContain("首次建立 Run 配置快照时固定");
    expect(description).toContain("已有快照的 Run 执行和恢复均保持原名单");
    expect(description).toContain("不能替代沙箱隔离");
    expect(description).toContain("exec_command 仍可操作文件");
    expect(description).toContain("关闭 read 不代表禁止读取文件系统");
    const form = container.querySelector("form");
    act(() => form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(api.saveRuntimeSettingsConfiguration).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabledTools: expected, expectedGeneration: 1 }),
    );
    expect(selectedRuntimeTools(container)).toEqual(expected);
    expect(container.querySelector("form")).not.toBe(form);
    unmount();
  });

  it.each(["native", "ptc"] as const)("%s 模式勾选部分工具并保存", async (toolCallingMode) => {
    const api = fixture();
    const { container, unmount } = await mountRuntimeSettings(api);
    act(() => runtimeToolAction(container, "全部关闭").click());
    expect(selectedRuntimeTools(container)).toEqual([]);
    for (const name of ["read", "deliver_file", "spawn_agent"]) {
      act(() =>
        requiredControl(
          runtimeToolCheckboxes(container).find((checkbox) => checkbox.value === name),
          name,
        ).click(),
      );
    }
    const readCheckbox = requiredControl(
      runtimeToolCheckboxes(container).find((checkbox) => checkbox.value === "read"),
      "read",
    );
    act(() => readCheckbox.click());
    expect(selectedRuntimeTools(container)).toEqual(["deliver_file", "spawn_agent"]);
    act(() => readCheckbox.click());
    const mode = requiredControl(
      container.querySelector<HTMLSelectElement>('select[name="toolCallingMode"]'),
      "工具调用模式",
    );
    act(() => {
      mode.value = toolCallingMode;
      mode.dispatchEvent(new Event("change", { bubbles: true }));
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(api.saveRuntimeSettingsConfiguration).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toolCallingMode,
        enabledTools: ["read", "deliver_file", "spawn_agent"],
      }),
    );
    unmount();
  });

  it("运行工具支持全部关闭与全选，提交空数组而不是省略名单", async () => {
    const api = fixture();
    vi.mocked(api.overview).mockResolvedValue({
      ...overview,
      activeRuntimeSettings: runtimeSettingsRevision(["read"]),
    });
    const { container, unmount } = await mountRuntimeSettings(api);
    act(() => runtimeToolAction(container, "全选").click());
    expect(selectedRuntimeTools(container)).toEqual(RUNTIME_TOOL_CATALOG.map((tool) => tool.name));
    expect(api.saveRuntimeSettingsConfiguration).not.toHaveBeenCalled();
    act(() => runtimeToolAction(container, "全部关闭").click());
    expect(selectedRuntimeTools(container)).toEqual([]);
    expect(api.saveRuntimeSettingsConfiguration).not.toHaveBeenCalled();
    act(() =>
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await settle();
    expect(api.saveRuntimeSettingsConfiguration).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabledTools: [] }),
    );
    unmount();
  });

  it("运行工具保存失败保留选择与并发检查值，不自动刷新", async () => {
    const api = fixture();
    vi.mocked(api.overview).mockResolvedValue({
      ...overview,
      activeRuntimeSettings: runtimeSettingsRevision(["read"]),
    });
    vi.mocked(api.saveRuntimeSettingsConfiguration).mockRejectedValue(
      new AdminApiError("配置已被更新，请刷新后重试。", 409, false),
    );
    const { container, unmount } = await mountRuntimeSettings(api);
    act(() => runtimeToolAction(container, "全部关闭").click());
    act(() =>
      requiredControl(
        runtimeToolCheckboxes(container).find((checkbox) => checkbox.value === "edit"),
        "edit",
      ).click(),
    );
    const form = container.querySelector("form");
    const reads = vi.mocked(api.overview).mock.calls.length;
    act(() => form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(api.saveRuntimeSettingsConfiguration).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabledTools: ["edit"], expectedGeneration: 3 }),
    );
    expect(api.overview).toHaveBeenCalledTimes(reads);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("配置已被更新");
    expect(container.querySelector("form")).toBe(form);
    expect(selectedRuntimeTools(container)).toEqual(["edit"]);
    expect(container.querySelector('input[name="expectedGeneration"]')).toHaveProperty(
      "value",
      "3",
    );
    expect(
      runtimeToolCheckboxes(container).every((checkbox) => !checkbox.matches(":disabled")),
    ).toBe(true);
    unmount();
  });

  it.each<{ label: string; enabledTools: RuntimeToolName[] | undefined }>([
    { label: "部分名单", enabledTools: ["write", "list_agents"] },
    { label: "全部关闭", enabledTools: [] },
    { label: "旧配置全选", enabledTools: undefined },
  ])("运行工具刷新新 revision 回显：$label", async ({ enabledTools }) => {
    const api = fixture();
    let active = runtimeSettingsRevision(["read"]);
    vi.mocked(api.overview).mockImplementation(async () => ({
      ...overview,
      generation: active.revision,
      activeRuntimeSettings: active,
    }));
    const { container, unmount } = await mountRuntimeSettings(api);
    act(() => runtimeToolAction(container, "全部关闭").click());
    const previousForm = container.querySelector("form");
    active = { ...runtimeSettingsRevision(enabledTools), revision: 2 };
    await act(async () => runtimeToolAction(container, "刷新").click());
    await settle();
    expect(container.querySelector("form")).not.toBe(previousForm);
    expect(selectedRuntimeTools(container)).toEqual(
      RUNTIME_TOOL_CATALOG.filter(
        (tool) => enabledTools === undefined || enabledTools.includes(tool.name),
      ).map((tool) => tool.name),
    );
    expect(container.querySelector('input[name="expectedGeneration"]')).toHaveProperty(
      "value",
      "2",
    );
    expect(api.saveRuntimeSettingsConfiguration).not.toHaveBeenCalled();
    unmount();
  });

  it("运行工具在概览不可用或保存中禁用勾选与批量操作", async () => {
    const api = fixture();
    vi.mocked(api.overview).mockRejectedValue(new AdminApiError("概览暂不可用", 503, false));
    const { container, unmount } = await mountRuntimeSettings(api);
    const assertDisabled = (disabled: boolean) => {
      expect(
        runtimeToolCheckboxes(container).every(
          (checkbox) => checkbox.matches(":disabled") === disabled,
        ),
      ).toBe(true);
      for (const label of ["全选", "全部关闭"]) {
        expect(runtimeToolAction(container, label).matches(":disabled")).toBe(disabled);
      }
    };
    assertDisabled(true);
    act(() => runtimeToolAction(container, "全部关闭").click());
    expect(selectedRuntimeTools(container)).toEqual(RUNTIME_TOOL_CATALOG.map((tool) => tool.name));
    vi.mocked(api.overview).mockResolvedValue(overview);
    await act(async () => runtimeToolAction(container, "刷新").click());
    await settle();
    assertDisabled(false);
    let rejectSave: ((reason: unknown) => void) | undefined;
    vi.mocked(api.saveRuntimeSettingsConfiguration).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    act(() => runtimeToolAction(container, "全部关闭").click());
    act(() =>
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    assertDisabled(true);
    act(() => runtimeToolAction(container, "全选").click());
    expect(selectedRuntimeTools(container)).toEqual([]);
    await act(async () => rejectSave?.(new AdminApiError("保存失败", 503, false)));
    await settle();
    assertDisabled(false);
    expect(selectedRuntimeTools(container)).toEqual([]);
    unmount();
  });

  it("工作台展示真实指标，隐藏内部配置和版本信息", async () => {
    const api = fixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();
    expect(container.textContent).toContain("累计 Run12");
    expect(container.textContent).not.toContain("Generation");
    expect(container.textContent).not.toContain("部署配置地图");
    expect(container.textContent).not.toContain("MODEL_API_KEY");
    act(() => root.unmount());
    container.remove();
  });

  it("审计显示操作者与操作结果，不展示内部版本", async () => {
    const api = fixture();
    vi.mocked(api.listAudits).mockResolvedValue([
      {
        auditId: "audit_one",
        actorUserId: "user_operator",
        objectKind: "model_provider",
        objectKey: "deepseek",
        revision: 1234,
        action: "publish",
        reason: "使用模型配置",
        outcome: "succeeded",
        createdAt: "2026-08-25T00:00:00.000Z",
      },
    ]);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();
    act(() => navigationItem(container, "操作审计").click());
    await settle();
    expect(api.listAudits).toHaveBeenCalledWith(100);
    expect(container.textContent).toContain("操作者：user_operator");
    expect(container.textContent).toContain("使用配置");
    expect(container.textContent).toContain("成功");
    expect(container.textContent).not.toContain("1234");
    act(() => root.unmount());
    container.remove();
  });

  it("在身份与登录模块分区配置访问策略和第三方身份源", async () => {
    const api = fixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();

    act(() => navigationItem(container, "身份与登录").click());
    await settle();

    expect(api.getIdentityConfiguration).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("登录入口控制");
    expect(container.textContent).toContain("基础访问策略");
    expect(container.textContent).toContain("第三方身份源");
    expect(container.textContent).toContain("发信邮箱与 SMTP");
    expect(container.textContent).toContain("密钥只保存在服务端");
    expect(container.querySelectorAll(".identity-provider-card")).toHaveLength(4);

    const emailVerificationToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="开启邮箱验证码"]',
    );
    if (emailVerificationToggle === null) throw new Error("邮箱验证码开关缺失");
    act(() => {
      emailVerificationToggle.click();
      changeControl(
        requiredControl(
          container.querySelector<HTMLInputElement>('input[placeholder="no-reply@example.com"]'),
          "发件人邮箱",
        ),
        "no-reply@example.com",
      );
      changeControl(
        requiredControl(
          container.querySelector<HTMLInputElement>('input[placeholder="smtp.example.com"]'),
          "SMTP 主机",
        ),
        "smtp.example.com",
      );
      const smtpUsers = container.querySelectorAll<HTMLInputElement>(
        'input[placeholder="no-reply@example.com"]',
      );
      changeControl(requiredControl(smtpUsers[1], "SMTP 用户名"), "mailer@example.com");
      changeControl(
        requiredControl(
          container.querySelector<HTMLInputElement>('input[placeholder="输入密码或授权码"]'),
          "SMTP 密码",
        ),
        "smtp-secret",
      );
    });

    const github = container.querySelector<HTMLElement>('[data-provider="github"]');
    if (github === null) throw new Error("GitHub 身份源缺失");
    const fields = github.querySelectorAll<HTMLInputElement>("input");
    act(() => {
      changeControl(requiredControl(fields[0], "GitHub Client ID"), "github-client");
      changeControl(requiredControl(fields[1], "GitHub Client Secret"), "github-secret");
      github.querySelector<HTMLButtonElement>('[role="switch"]')?.click();
    });
    const publish = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "保存并立即生效",
    );
    if (publish === undefined) throw new Error("身份策略发布按钮缺失");
    expect(publish.disabled).toBe(false);
    expect(container.textContent).not.toContain("变更原因");
    expect(container.textContent).not.toContain("当前版本");
    await act(async () => publish.click());
    await settle();

    expect(api.updateIdentityConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersionToken: 0,
        emailPasswordEnabled: true,
        emailVerificationEnabled: true,
        emailFromAddress: "no-reply@example.com",
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpSecure: true,
        smtpUsername: "mailer@example.com",
        smtpPassword: "smtp-secret",
        registrationEnabled: true,
        phoneEnabled: false,
        providers: expect.arrayContaining([
          expect.objectContaining({
            key: "github",
            enabled: true,
            clientId: "github-client",
            clientSecret: "github-secret",
          }),
        ]),
      }),
    );

    expect(vi.mocked(api.updateIdentityConfiguration).mock.calls[0]?.[0]).not.toHaveProperty(
      "reason",
    );
    act(() => root.unmount());
    container.remove();
  });

  it.each([false, true])("身份通道保存后展示实际开关 %s，不引入发布阶段", async (enabled) => {
    const api = fixture();
    const base = await api.getIdentityConfiguration();
    let current = {
      ...base,
      emailVerificationEnabled: enabled,
      phoneEnabled: enabled,
      emailFromAddress: "no-reply@example.com",
      smtpHost: "smtp.example.com",
      smtpUsername: "mailer",
      smtpPasswordConfigured: true,
      smsWebhookUrl: "https://sms.example.com/otp",
    };
    vi.mocked(api.getIdentityConfiguration).mockResolvedValue(current);
    vi.mocked(api.updateIdentityConfiguration).mockImplementation(async (input) => {
      current = {
        ...current,
        emailVerificationEnabled: input.emailVerificationEnabled,
        phoneEnabled: input.phoneEnabled,
      };
      vi.mocked(api.getIdentityConfiguration).mockResolvedValue(current);
      return current;
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();
    act(() => navigationItem(container, "身份与登录").click());
    await settle();
    const status = () =>
      [
        ...container.querySelectorAll(
          ".identity-mail-settings .identity-state, .identity-sms-settings .identity-state",
        ),
      ].map((item) => item.textContent);
    expect(status()).toEqual([enabled ? "已开启" : "已关闭", enabled ? "已开启" : "已关闭"]);
    act(() => {
      container
        .querySelector<HTMLButtonElement>(`[aria-label="${enabled ? "关闭" : "开启"}邮箱验证码"]`)
        ?.click();
      container
        .querySelector<HTMLButtonElement>(`[aria-label="${enabled ? "关闭" : "开启"}手机验证码"]`)
        ?.click();
    });
    expect(status()).toEqual([enabled ? "已开启" : "已关闭", enabled ? "已开启" : "已关闭"]);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('form button[type="submit"]')?.click(),
    );
    await settle();
    expect(status()).toEqual([enabled ? "已关闭" : "已开启", enabled ? "已关闭" : "已开启"]);
    expect(container.textContent).not.toContain("待发布");
    expect(container.textContent).not.toContain("发布前");
    act(() => root.unmount());
    container.remove();
  });

  it.each([false, true])("无后台模型时仍可独立配置记忆，现有配置存在 %s", async (hasMemory) => {
    const api = fixture();
    const activeMemory: MemoryProviderRevisionDto = {
      revision: 1,
      versionToken: 2,
      status: "active",
      probeStatus: "healthy",
      createdBy: "user_admin",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      configuration: {
        providerKey: "mem0",
        displayName: "Mem0",
        providerKind: "mem0",
        enabled: true,
        baseUrl: "https://memory.example.com/",
        apiSecretRef: "deployment:memory-api",
        scopeSecretRef: "deployment:memory-scope",
        requestTimeoutMs: 10000,
      },
    };
    vi.mocked(api.overview).mockResolvedValue({
      ...overview,
      ...(hasMemory ? { activeMemory } : {}),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();
    expect(container.querySelector(".active-stack")?.textContent).toContain(
      hasMemory ? "记忆：Mem0" : "记忆：由部署配置管理",
    );
    act(() => navigationItem(container, "记忆服务").click());
    await settle();
    expect(container.querySelector(".memory-active-state")?.textContent).toBe(
      hasMemory ? "已开启" : "已关闭",
    );
    expect(container.querySelector(".memory-control-form")?.textContent).not.toContain(
      "请先在模型服务中接入后台模型",
    );
    expect(
      container.querySelector<HTMLFieldSetElement>(".memory-configuration-fields")?.disabled,
    ).toBe(false);
    const save = container.querySelector<HTMLButtonElement>('form button[type="submit"]');
    expect(save?.disabled).toBe(false);
    const secret = container.querySelector<HTMLInputElement>('input[name="apiKey"]');
    if (secret === null) throw new Error("记忆密钥输入缺失");
    expect(secret.type).toBe("password");
    expect(secret.value).toBe("");
    act(() => changeControl(secret, "unit-memory-new-key"));
    await act(async () => save?.click());
    expect(api.saveMemoryConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "unit-memory-new-key",
        apiSecretRef: "managed:memory-api",
        scopeSecretRef: "platform:memory-scope",
      }),
    );
    act(() => root.unmount());
    container.remove();
  });

  it("已接入后台模型但没有记忆配置时显示关闭，并允许首次保存", async () => {
    const api = fixture();
    vi.mocked(api.overview).mockResolvedValue({
      ...overview,
      activeModel: { ...modelRevision("deepseek", "healthy"), status: "active" },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();
    act(() => navigationItem(container, "记忆服务").click());
    await settle();
    expect(container.querySelector(".memory-active-state")?.textContent).toBe("已关闭");
    const save = container.querySelector<HTMLButtonElement>('form button[type="submit"]');
    expect(save?.disabled).toBe(false);
    await act(async () => save?.click());
    await settle();
    expect(api.saveMemoryConfiguration).toHaveBeenCalledOnce();
    expect(vi.mocked(api.saveMemoryConfiguration).mock.calls[0]?.[0]).toMatchObject({
      expectedGeneration: 3,
      enabled: false,
    });
    act(() => root.unmount());
    container.remove();
  });

  it.each([false, true])("记忆表单带入当前配置和启用状态 %s，一次保存直接生效", async (enabled) => {
    const api = fixture();
    const activeMemory: MemoryProviderRevisionDto = {
      revision: 9,
      versionToken: 3,
      status: "active",
      probeStatus: "healthy",
      createdBy: "user_admin",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      configuration: {
        providerKey: "memory-main",
        displayName: "企业记忆",
        providerKind: "mem0",
        baseUrl: "https://memory.example.com/",
        apiSecretRef: "managed:memory-api",
        scopeSecretRef: "platform:memory-scope",
        requestTimeoutMs: 12345,
        enabled,
      },
    };
    vi.mocked(api.overview).mockResolvedValue({
      ...overview,
      activeMemory,
      activeModel: { ...modelRevision("deepseek", "healthy"), status: "active" },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();
    act(() => navigationItem(container, "记忆服务").click());
    await settle();
    expect(container.querySelector(".memory-active-state")?.textContent).toBe(
      enabled ? "已开启" : "已关闭",
    );
    expect(container.querySelector<HTMLInputElement>('input[name="displayName"]')?.value).toBe(
      "企业记忆",
    );
    expect(container.querySelector<HTMLInputElement>('input[name="baseUrl"]')?.value).toBe(
      "https://memory.example.com/",
    );
    expect(container.querySelector<HTMLInputElement>('input[name="requestTimeoutMs"]')?.value).toBe(
      "12345",
    );
    expect(container.querySelector<HTMLInputElement>('input[name="enabled"]')?.checked).toBe(
      enabled,
    );
    expect(container.querySelector('input[name="providerKey"]')).toBeNull();
    for (const label of [
      "变更原因",
      "Revision",
      "版本记录",
      "待启用",
      "Secret Ref",
      "HMAC",
      "探测连接",
    ]) {
      expect(container.textContent).not.toContain(label);
    }
    const save = container.querySelector<HTMLButtonElement>('form button[type="submit"]');
    if (save === null) throw new Error("记忆保存按钮缺失");
    act(() => container.querySelector<HTMLInputElement>('input[name="enabled"]')?.click());
    await act(async () => save.click());
    await settle();
    expect(api.saveMemoryConfiguration).toHaveBeenCalledExactlyOnceWith({
      expectedGeneration: 3,
      ...activeMemory.configuration,
      reuseCredentialFromRevision: activeMemory.revision,
      enabled: !enabled,
    });
    expect(api.createMemoryDraft).not.toHaveBeenCalled();
    expect(api.probe).not.toHaveBeenCalled();
    expect(api.publish).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  });

  it("记忆状态未读到时禁止保存，避免用默认值覆盖现有配置", async () => {
    const api = fixture();
    vi.mocked(api.overview).mockRejectedValue(new Error("unavailable"));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();
    act(() => navigationItem(container, "记忆服务").click());
    await settle();
    expect(container.querySelector(".memory-active-state")?.textContent).toBe("状态未知");
    expect(container.querySelector<HTMLButtonElement>('form button[type="submit"]')?.disabled).toBe(
      true,
    );
    expect(api.saveMemoryConfiguration).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  });

  it("记忆保存失败保留未保存输入，等待显式刷新", async () => {
    const api = fixture();
    vi.mocked(api.overview).mockResolvedValue({
      ...overview,
      activeModel: { ...modelRevision("deepseek", "healthy"), status: "active" },
    });
    vi.mocked(api.saveMemoryConfiguration).mockRejectedValue(
      new AdminApiError("配置已被更新，请刷新后重试。", 409, false),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();
    act(() => navigationItem(container, "记忆服务").click());
    await settle();
    const name = requiredControl(
      container.querySelector<HTMLInputElement>('input[name="displayName"]'),
      "记忆名称",
    );
    const url = requiredControl(
      container.querySelector<HTMLInputElement>('input[name="baseUrl"]'),
      "记忆地址",
    );
    act(() => {
      changeControl(name, "待保存的记忆连接");
      changeControl(url, "https://memory.example.com/");
      container.querySelector<HTMLInputElement>('input[name="enabled"]')?.click();
    });
    const reads = vi.mocked(api.overview).mock.calls.length;
    await act(async () =>
      container.querySelector<HTMLButtonElement>('form button[type="submit"]')?.click(),
    );
    await settle();
    expect(api.saveMemoryConfiguration).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("请输入 Mem0 API Key");
    const key = requiredControl(
      container.querySelector<HTMLInputElement>('input[name="apiKey"]'),
      "记忆密钥",
    );
    act(() => changeControl(key, "unit-unsaved-memory-key"));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('form button[type="submit"]')?.click(),
    );
    await settle();
    expect(api.overview).toHaveBeenCalledTimes(reads);
    expect(name.value).toBe("待保存的记忆连接");
    expect(key.value).toBe("unit-unsaved-memory-key");
    expect(url.value).toBe("https://memory.example.com/");
    expect(container.querySelector<HTMLInputElement>('input[name="enabled"]')?.checked).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("请刷新后重试");
    expect(vi.mocked(api.saveMemoryConfiguration).mock.calls[0]?.[0].expectedGeneration).toBe(3);
    act(() => root.unmount());
    container.remove();
  });

  it("身份保存失败不重载配置或清空输入", async () => {
    const api = fixture();
    vi.mocked(api.updateIdentityConfiguration).mockRejectedValue(
      new AdminApiError("配置内容不符合要求。", 400, false),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();
    act(() => navigationItem(container, "身份与登录").click());
    await settle();
    const name = requiredControl(
      container.querySelector<HTMLInputElement>('input[placeholder="Hoox"]'),
      "发件人名称",
    );
    act(() => changeControl(name, "待保存的发件人"));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('form button[type="submit"]')?.click(),
    );
    await settle();
    expect(api.getIdentityConfiguration).toHaveBeenCalledOnce();
    expect(name.value).toBe("待保存的发件人");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("配置内容不符合要求");
    act(() => root.unmount());
    container.remove();
  });

  it("展示有口径的数据运营和可审计用户状态治理", async () => {
    const api = fixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();

    act(() => navigationItem(container, "数据运营").click());
    await settle();
    expect(container.textContent).toContain("7 日活跃用户");
    expect(container.textContent).toContain("Thread.updated_at");
    expect(container.textContent).toContain("等待写入 Mem0");
    expect(container.textContent).toContain("Tokens/s");
    expect(container.textContent).toContain("62.5");
    expect(container.textContent).toContain("80%");
    expect(container.textContent).toContain("12,500");
    expect(container.textContent).toContain("2,500");
    const trajectoryLink = container.querySelector<HTMLAnchorElement>(".trajectory-viewer-link");
    expect(trajectoryLink?.href).toBe("http://127.0.0.1:4188/");
    expect(trajectoryLink?.target).toBe("_blank");
    expect(container.querySelector("iframe")).toBeNull();

    act(() => navigationItem(container, "用户管理").click());
    await settle();
    expect(api.listUsers).toHaveBeenCalledWith({ limit: 100 });
    expect(container.textContent).toContain("customer@example.com");
    expect(container.textContent).toContain("不返回密码散列");

    const disable = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === "停用",
    );
    if (disable === undefined) throw new Error("停用按钮缺失");
    act(() => disable.click());
    expect(api.updateUserStatus).not.toHaveBeenCalled();
    expect(container.querySelector(".user-status-confirm input")).toBeNull();
    expect(container.textContent).toContain("提交后将立即拒绝登录并撤销现有会话");
    const confirm = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === "确认停用",
    );
    if (confirm === undefined) throw new Error("确认停用按钮缺失");
    await act(async () => confirm.click());
    await settle();
    expect(api.updateUserStatus).toHaveBeenCalledWith("user_customer", {
      status: "disabled",
    });

    act(() => root.unmount());
    container.remove();
  });

  it("恢复用户直接执行，停用失败时保留后果确认", async () => {
    const api = fixture();
    const userPage = await api.listUsers();
    const user = userPage.items[0];
    if (user === undefined) throw new Error("用户夹具缺失");
    vi.mocked(api.listUsers).mockResolvedValue({
      ...userPage,
      items: [{ ...user, status: "disabled" }],
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();
    act(() => navigationItem(container, "用户管理").click());
    await settle();
    const restore = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "恢复",
    );
    if (restore === undefined) throw new Error("恢复按钮缺失");
    await act(async () => restore.click());
    await settle();
    expect(api.updateUserStatus).toHaveBeenCalledExactlyOnceWith("user_customer", {
      status: "active",
    });
    expect(container.querySelector(".user-status-confirm")).toBeNull();

    vi.mocked(api.listUsers).mockResolvedValue(userPage);
    vi.mocked(api.updateUserStatus).mockRejectedValue(
      new AdminApiError("账号状态更新失败。", 503, true),
    );
    const refresh = container.querySelector<HTMLButtonElement>(".refresh-button");
    await act(async () => refresh?.click());
    await settle();
    const disable = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "停用",
    );
    if (disable === undefined) throw new Error("停用按钮缺失");
    act(() => disable.click());
    const confirm = container.querySelector<HTMLButtonElement>(
      '.user-status-confirm button[type="submit"]',
    );
    await act(async () => confirm?.click());
    await settle();
    expect(container.querySelector(".user-status-confirm")).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("账号状态更新失败");
    act(() => root.unmount());
    container.remove();
  });

  it("自定义供应商可填写完整模型信息并保存后立即使用", async () => {
    const api = fixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();

    act(() => navigationItem(container, "模型服务").click());
    await settle();
    const addProvider = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "添加供应商",
    );
    if (addProvider === undefined) throw new Error("添加供应商按钮缺失");
    act(() => addProvider.click());
    const addCustomProvider = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "自定义供应商",
    );
    if (addCustomProvider === undefined) throw new Error("自定义供应商按钮缺失");
    act(() => addCustomProvider.click());
    const addModel = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "手动添加模型",
    );
    if (addModel === undefined) throw new Error("添加模型按钮缺失");
    act(() => addModel.click());

    const rows = [...container.querySelectorAll<HTMLElement>(".model-editor-row")];
    expect(rows).toHaveLength(2);
    const defaultChoices = rows.map((row) =>
      row.querySelector<HTMLInputElement>('input[type="radio"]'),
    );
    expect(defaultChoices.map((choice) => choice?.checked)).toEqual([true, false]);
    act(() => {
      const firstInputs = rows[0]?.querySelectorAll<HTMLInputElement>(
        'input:not([type="radio"]):not([type="checkbox"])',
      );
      const secondInputs = rows[1]?.querySelectorAll<HTMLInputElement>(
        'input:not([type="radio"]):not([type="checkbox"])',
      );
      if (firstInputs === undefined || secondInputs === undefined) throw new Error("模型字段缺失");
      changeControl(requiredControl(firstInputs[0], "首个模型 ID"), "model-a");
      changeControl(requiredControl(firstInputs[1], "首个模型名称"), "Model A");
      changeControl(requiredControl(secondInputs[0], "第二个模型 ID"), "model-b");
      changeControl(requiredControl(secondInputs[1], "第二个模型名称"), "Model B");
      rows[1]?.querySelector<HTMLInputElement>('input[type="radio"]')?.click();

      const form = container.querySelector<HTMLFormElement>(".control-form");
      if (form === null) throw new Error("模型表单缺失");
      changeControl(
        requiredControl(
          form.querySelector<HTMLInputElement>('input[name="displayName"]'),
          "显示名称",
        ),
        "主模型",
      );
      changeControl(
        requiredControl(form.querySelector<HTMLInputElement>('input[name="baseUrl"]'), "Base URL"),
        "https://model.example.com/v1",
      );
      changeControl(
        requiredControl(form.querySelector<HTMLInputElement>('input[name="apiKey"]'), "API Key"),
        "test-provider-key",
      );
    });
    const saveAndUse = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "保存并使用",
    );
    if (saveAndUse === undefined) throw new Error("保存并使用按钮缺失");
    expect(container.querySelectorAll('form button[type="submit"]')).toHaveLength(1);
    await act(async () => saveAndUse.click());
    await settle();

    const request = vi.mocked(api.saveModelConfiguration).mock.calls[0]?.[0];
    expect(request).toEqual(
      expect.objectContaining({
        providerKey: expect.stringMatching(/^custom-/u),
        defaultModelId: "model-b",
        models: [
          expect.objectContaining({ id: "model-a", enabled: false }),
          expect.objectContaining({ id: "model-b", enabled: true }),
        ],
      }),
    );
    expect(request).not.toHaveProperty("reason");
    expect(request?.expectedGeneration).toBe(3);
    expect(api.saveModelConfiguration).toHaveBeenCalledOnce();
    expect(api.publish).not.toHaveBeenCalled();
    expect(api.createModelDraft).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("变更原因");
    expect(container.textContent).not.toContain("探测连接");

    act(() => root.unmount());
    container.remove();
  });

  it("编辑模型复用已有密钥并保留零值并发检查，冲突后不继续使用旧配置", async () => {
    const api = fixture();
    const activeModel = { ...modelRevision("deepseek", "healthy"), status: "active" as const };
    vi.mocked(api.overview).mockResolvedValue({ ...overview, generation: 0, activeModel });
    vi.mocked(api.listModelProviders).mockResolvedValue([activeModel]);
    vi.mocked(api.saveModelConfiguration).mockRejectedValue(
      new AdminApiError("配置已被更新，请刷新后重试。", 409, false),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();
    act(() => navigationItem(container, "模型服务").click());
    await settle();
    act(() =>
      changeControl(
        requiredControl(
          container.querySelector<HTMLInputElement>('input[name="displayName"]'),
          "显示名称",
        ),
        "修改后的供应商",
      ),
    );
    const save = container.querySelector<HTMLButtonElement>('form button[type="submit"]');
    if (save === null) throw new Error("模型保存按钮缺失");
    await act(async () => save.click());
    await settle();
    expect(api.saveModelConfiguration).toHaveBeenCalledOnce();
    expect(api.overview).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.saveModelConfiguration).mock.calls[0]?.[0]).toMatchObject({
      expectedGeneration: 0,
      displayName: "修改后的供应商",
      reuseCredentialFromRevision: 1,
    });
    expect(vi.mocked(api.saveModelConfiguration).mock.calls[0]?.[0]).not.toHaveProperty("apiKey");
    expect(api.publish).not.toHaveBeenCalled();
    expect(api.createModelDraft).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "配置已被更新，请刷新后重试",
    );
    expect(container.querySelector('form button[type="submit"]')).not.toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it("直接展示当前使用模型和新 Run 边界，不暴露内部版本", async () => {
    const api = fixture();
    const activeModel = { ...modelRevision("deepseek", "healthy"), status: "active" as const };
    vi.mocked(api.overview).mockResolvedValue({ ...overview, activeModel });
    vi.mocked(api.listModelProviders).mockResolvedValue([activeModel]);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();

    act(() => navigationItem(container, "模型服务").click());
    await settle();

    const effectiveState = container.querySelector<HTMLElement>(".model-effective-state.active");
    if (effectiveState === null) throw new Error("当前模型生效状态缺失");
    expect(effectiveState.textContent).toContain("当前使用");
    expect(effectiveState.textContent).toContain("DeepSeek / model-a");
    expect(effectiveState.textContent).toContain("新任务使用这份配置");
    expect(effectiveState.textContent).toContain("已经开始的任务保持不变");
    expect(effectiveState.textContent).not.toContain("Revision");
    expect(effectiveState.textContent).not.toContain("Generation");

    act(() => root.unmount());
    container.remove();
  });

  it("供应商列表可直接测试和切换且不要求填写原因", async () => {
    const api = fixture();
    vi.mocked(api.listModelProviders).mockResolvedValue([
      modelRevision("deepseek", "failed"),
      modelRevision("openrouter", "healthy"),
    ]);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();

    act(() => navigationItem(container, "模型服务").click());
    await settle();

    expect(container.querySelectorAll(".provider-settings-list article")).toHaveLength(2);
    expect(container.querySelector(".model-editor-pane")?.textContent).not.toContain("测试配置");
    expect(container.textContent).toContain("DeepSeek");
    expect(container.textContent).toContain("OpenRouter");
    expect(container.querySelector(".control-revision")).toBeNull();
    expect(container.textContent).not.toContain("版本记录");
    expect(container.textContent).toContain("测试失败");
    expect(container.textContent).toContain("测试成功");
    expect(container.textContent).not.toContain("启用此配置");
    expect(container.textContent).not.toContain("变更原因");

    const deepseekRow = container.querySelector<HTMLElement>(".provider-settings-list article");
    if (deepseekRow === null) throw new Error("DeepSeek 供应商缺失");
    const test = [...deepseekRow.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "测试已保存配置",
    );
    const activate = [...deepseekRow.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "使用",
    );
    if (test === undefined || activate === undefined) throw new Error("供应商快捷操作缺失");
    await act(async () => test.click());
    await settle();
    await act(async () => activate.click());
    await settle();
    expect(api.probe).toHaveBeenCalledWith("model-providers", "deepseek", 1, {
      expectedVersionToken: 2,
    });
    expect(api.publish).toHaveBeenCalledWith("model-providers", "deepseek", 1, {
      expectedVersionToken: 2,
    });

    act(() => root.unmount());
    container.remove();
  });

  it("不回显历史疑似密钥且新供应商内部标识由系统生成", async () => {
    const secretLikeIdentifier = `sk-${"a".repeat(32)}`;
    const api = fixture();
    vi.mocked(api.listModelProviders).mockResolvedValue([
      modelRevision(secretLikeIdentifier, "failed"),
    ]);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();

    act(() => navigationItem(container, "模型服务").click());
    await settle();
    expect(container.textContent).not.toContain(secretLikeIdentifier);
    expect(container.textContent).toContain("疑似密钥（已隐藏）");
    expect(container.textContent).toContain("已隔离");

    const addProvider = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "添加供应商",
    );
    if (addProvider === undefined) throw new Error("添加供应商按钮缺失");
    act(() => addProvider.click());
    const addCustomProvider = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "自定义供应商",
    );
    if (addCustomProvider === undefined) throw new Error("自定义供应商按钮缺失");
    act(() => addCustomProvider.click());
    const providerKey = requiredControl(
      container.querySelector<HTMLInputElement>('input[name="providerKey"]'),
      "Provider 内部标识",
    );
    expect(providerKey.type).toBe("hidden");
    expect(providerKey.value).toMatch(/^custom-/u);
    expect(providerKey.value).not.toBe(secretLikeIdentifier);
    expect(container.textContent).not.toContain("Provider 内部标识");
    act(() => root.unmount());
    container.remove();
  });

  it("自定义供应商可编辑模型能力字段", async () => {
    const api = fixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();

    act(() => navigationItem(container, "模型服务").click());
    await settle();
    const addProvider = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "添加供应商",
    );
    if (addProvider === undefined) throw new Error("添加供应商按钮缺失");
    act(() => addProvider.click());
    const addCustomProvider = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "自定义供应商",
    );
    if (addCustomProvider === undefined) throw new Error("自定义供应商按钮缺失");
    act(() => addCustomProvider.click());

    expect(container.querySelector<HTMLInputElement>('input[name="providerKey"]')?.type).toBe(
      "hidden",
    );
    expect(container.querySelector('input[name="displayName"]')).not.toBeNull();
    expect(container.querySelector('input[name="baseUrl"]')).not.toBeNull();
    expect(container.querySelector('input[name="apiKey"]')).not.toBeNull();
    expect(container.querySelector(".model-editor-row")).not.toBeNull();
    expect(container.textContent).toContain("上下文窗口");
    expect(container.textContent).toContain("最大输出 Token");
    expect(container.textContent).toContain("图片输入");
    expect(container.textContent).toContain("推理模型");
    expect(container.querySelector<HTMLDetailsElement>(".model-advanced-settings")?.open).toBe(
      false,
    );

    act(() => root.unmount());
    container.remove();
  });

  it("内置 Provider 自动载入目录并只启用选择的模型", async () => {
    const api = fixture();
    const piModels: readonly PiModelCatalogModelDto[] = [
      {
        providerId: "deepseek",
        providerName: "DeepSeek",
        id: "deepseek-chat",
        name: "DeepSeek Chat",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
      {
        providerId: "deepseek",
        providerName: "DeepSeek",
        id: "deepseek-reasoner",
        name: "DeepSeek Reasoner",
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ];
    const lookupPromise = Promise.resolve(piModels);
    vi.mocked(api.findPiModelCatalogModels).mockImplementationOnce(() => lookupPromise);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();

    act(() => navigationItem(container, "模型服务").click());
    await settle();
    const addProvider = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "添加供应商",
    );
    if (addProvider === undefined) throw new Error("添加供应商按钮缺失");
    act(() => addProvider.click());
    expect(container.textContent).toContain("从模型目录添加");
    const deepseek = container.querySelector<HTMLButtonElement>(".provider-catalog-grid button");
    if (deepseek === null) throw new Error("DeepSeek Provider 缺失");
    await act(async () => {
      deepseek.click();
      await lookupPromise;
      await Promise.resolve();
    });

    expect(api.findPiModelCatalogModels).toHaveBeenCalledWith({
      providerId: "deepseek",
      limit: 100,
    });
    const rows = [...container.querySelectorAll<HTMLElement>(".model-editor-row")];
    expect(rows).toHaveLength(2);
    expect(container.textContent).toContain("DeepSeek Reasoner");
    expect(container.textContent).toContain("选择要使用的模型；能力参数可在高级设置中调整");
    expect(container.querySelector<HTMLInputElement>('input[name="providerKey"]')?.type).toBe(
      "hidden",
    );
    expect(container.textContent).not.toContain("Provider 内部标识");
    expect(container.textContent).not.toContain("变更原因");

    act(() => {
      rows[1]?.querySelector<HTMLInputElement>('input[type="radio"]')?.click();
      const firstContextWindow =
        rows[0]?.querySelectorAll<HTMLInputElement>('input[type="number"]')[0];
      changeControl(requiredControl(firstContextWindow, "上下文窗口"), "256000");
      changeControl(
        requiredControl(
          container.querySelector<HTMLInputElement>('input[name="apiKey"]'),
          "API Key",
        ),
        "test-deepseek-key",
      );
    });
    const saveAndUse = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "保存并使用",
    );
    if (saveAndUse === undefined) throw new Error("保存并使用按钮缺失");
    expect(container.querySelectorAll('form button[type="submit"]')).toHaveLength(1);
    await act(async () => saveAndUse.click());
    await settle();

    const request = vi.mocked(api.saveModelConfiguration).mock.calls[0]?.[0];
    expect(request).toEqual(
      expect.objectContaining({
        providerKey: "deepseek",
        apiKey: "test-deepseek-key",
        defaultModelId: "deepseek-reasoner",
        models: [
          expect.objectContaining({ id: "deepseek-chat", enabled: false, contextWindow: 256_000 }),
          expect.objectContaining({ id: "deepseek-reasoner", enabled: true }),
        ],
      }),
    );
    expect(request).not.toHaveProperty("reason");
    expect(request?.expectedGeneration).toBe(3);
    expect(api.publish).not.toHaveBeenCalled();

    act(() => root.unmount());
    container.remove();
  });

  it("模块切换后忽略晚到的驾驶舱响应，不覆盖模型目录", async () => {
    const api = fixture();
    let resolveInitialOverview: ((value: typeof overview) => void) | undefined;
    const initialOverview = new Promise<typeof overview>((resolve) => {
      resolveInitialOverview = resolve;
    });
    vi.mocked(api.overview)
      .mockImplementationOnce(() => initialOverview)
      .mockResolvedValue(overview);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await act(async () => Promise.resolve());

    act(() => navigationItem(container, "模型服务").click());
    await settle();
    const addProvider = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "添加供应商",
    );
    if (addProvider === undefined) throw new Error("添加供应商按钮缺失");
    act(() => addProvider.click());
    expect(container.textContent).toContain("1 个");

    await act(async () => {
      resolveInitialOverview?.(overview);
      await initialOverview;
    });
    await settle();
    expect(container.textContent).toContain("1 个");
    expect(container.textContent).toContain("DeepSeek");

    act(() => root.unmount());
    container.remove();
  });

  it("控制 API 暂不可用时仍可查看模型目录表单", async () => {
    const api: AdminControlApiContract = {
      ...fixture(),
      overview: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();

    act(() => navigationItem(container, "模型服务").click());
    await settle();

    const addProvider = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "添加供应商",
    );
    if (addProvider === undefined) throw new Error("添加供应商按钮缺失");
    act(() => addProvider.click());
    expect(container.textContent).toContain("DeepSeek");
    expect(container.textContent).toContain("25 个");
    expect(container.textContent).toContain("无法确认当前实际使用的模型");
    expect(container.textContent).toContain("暂时无法读取或保存模型配置");

    const addCustomProvider = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "自定义供应商",
    );
    if (addCustomProvider === undefined) throw new Error("自定义供应商按钮缺失");
    act(() => addCustomProvider.click());

    expect(container.querySelector(".model-catalog-editor")).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('form button[type="submit"]')?.disabled).toBe(
      true,
    );
    expect(container.textContent).toContain("操作未完成");

    act(() => root.unmount());
    container.remove();
  });
});

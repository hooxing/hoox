// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PiModelCatalogModelDto } from "@hoox/protocol";
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
    createModelDraft: vi.fn(),
    createMemoryDraft: vi.fn(),
    createRuntimeSettingsDraft: vi.fn(),
    probe: vi.fn(),
    publish: vi.fn(),
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

function requiredControl<T extends HTMLInputElement | HTMLTextAreaElement>(
  control: T | null | undefined,
  name: string,
): T {
  if (control === null || control === undefined) throw new Error(`${name}字段缺失`);
  return control;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

describe("统一平台管理导航", () => {
  it("展示工业化后台模块、核心统计和环境配置状态，但不展示秘密值", async () => {
    const api = fixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();

    const navigation = [...container.querySelectorAll("nav button")].map(
      (item) => item.textContent,
    );
    expect(navigation).toEqual([
      "驾驶舱",
      "数据运营",
      "用户",
      "模型",
      "记忆",
      "Skills",
      "运行配置",
    ]);
    expect(container.textContent).toContain("累计 Run12");
    expect(container.textContent).toContain("MODEL_API_KEY");
    expect(container.textContent).toContain("已配置 · 部署秘密");
    expect(container.textContent).not.toContain("production-model-secret");

    const models = [...container.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (item) => item.textContent === "模型",
    );
    if (models === undefined) throw new Error("模型导航缺失");
    act(() => models.click());
    await settle();
    expect(api.listModelProviders).toHaveBeenCalledOnce();

    const settings = [...container.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (item) => item.textContent === "运行配置",
    );
    if (settings === undefined) throw new Error("配置导航缺失");
    act(() => settings.click());
    await settle();
    expect(api.listRuntimeSettings).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("MODEL_API_KEY");
    expect(container.textContent).toContain("DATABASE_URL / DATABASE_SCHEMA");
    expect(container.textContent).toContain("CUBESANDBOX_API_URL / CUBESANDBOX_TEMPLATE_ID");
    expect(container.textContent).toContain("部署平台");
    expect(container.textContent).toContain("后台 Revision");

    act(() => root.unmount());
    container.remove();
  });

  it("后台离线时仍展示配置真源、优先级和部署顺序", async () => {
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

    const settings = [...container.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (item) => item.textContent === "运行配置",
    );
    if (settings === undefined) throw new Error("配置导航缺失");
    act(() => settings.click());
    await settle();

    expect(container.textContent).toContain("部署配置地图");
    expect(container.textContent).toContain("等待后台检测");
    expect(container.textContent).toContain("P0");
    expect(container.textContent).toContain("按契约确认");
    expect(container.textContent).toContain("deploy/production.env.example");
    expect(container.textContent).toContain("pnpm db:migrate:up");
    expect(container.textContent).toContain("platform_control_operators");
    expect(container.textContent).toContain("数据库与身份 → 模型与 Mem0 秘密");

    act(() => root.unmount());
    container.remove();
  });

  it("说明 Mem0 的部署依赖、数据流和发布步骤", async () => {
    const api = fixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();

    const memory = [...container.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (item) => item.textContent === "记忆",
    );
    if (memory === undefined) throw new Error("记忆导航缺失");
    act(() => memory.click());
    await settle();

    expect(container.textContent).toContain("Mem0 Platform");
    expect(container.textContent).toContain("MEM0_API_KEY");
    expect(container.textContent).toContain("MEM0_SCOPE_HMAC_KEY");
    expect(container.textContent).toContain("探测连接");
    expect(container.textContent).toContain("观察队列");
    expect(container.querySelector<HTMLInputElement>('input[name="baseUrl"]')?.value).toBe(
      "https://api.mem0.ai/",
    );

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

    const analytics = [...container.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (item) => item.textContent === "数据运营",
    );
    if (analytics === undefined) throw new Error("数据运营导航缺失");
    act(() => analytics.click());
    await settle();
    expect(container.textContent).toContain("7 日活跃用户");
    expect(container.textContent).toContain("Thread.updated_at");
    expect(container.textContent).toContain("等待写入 Mem0");

    const users = [...container.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (item) => item.textContent === "用户",
    );
    if (users === undefined) throw new Error("用户导航缺失");
    act(() => users.click());
    await settle();
    expect(api.listUsers).toHaveBeenCalledWith({ limit: 100 });
    expect(container.textContent).toContain("customer@example.com");
    expect(container.textContent).toContain("不返回密码散列");

    const disable = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === "停用",
    );
    if (disable === undefined) throw new Error("停用按钮缺失");
    act(() => disable.click());
    const reason = requiredControl(
      container.querySelector<HTMLInputElement>(".user-status-confirm input"),
      "用户状态原因",
    );
    act(() => changeControl(reason, "用户主动申请停用账号"));
    const confirm = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === "确认停用",
    );
    if (confirm === undefined) throw new Error("确认停用按钮缺失");
    await act(async () => confirm.click());
    await settle();
    expect(api.updateUserStatus).toHaveBeenCalledWith("user_customer", {
      status: "disabled",
      reason: "用户主动申请停用账号",
    });

    act(() => root.unmount());
    container.remove();
  });

  it("一个 Provider 可添加多个模型并选择启用的默认模型", async () => {
    const api = fixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();

    const modelsNavigation = [...container.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (item) => item.textContent === "模型",
    );
    if (modelsNavigation === undefined) throw new Error("模型导航缺失");
    act(() => modelsNavigation.click());
    await settle();
    const addCustomProvider = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "添加自定义 Provider",
    );
    if (addCustomProvider === undefined) throw new Error("自定义 Provider 按钮缺失");
    act(() => addCustomProvider.click());
    const addModel = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "添加空白模型",
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
        'input:not([type="checkbox"]):not([type="radio"])',
      );
      const secondInputs = rows[1]?.querySelectorAll<HTMLInputElement>(
        'input:not([type="checkbox"]):not([type="radio"])',
      );
      if (firstInputs === undefined || secondInputs === undefined) throw new Error("模型字段缺失");
      changeControl(requiredControl(firstInputs[0], "首个模型 ID"), "model-a");
      changeControl(requiredControl(firstInputs[1], "首个模型名称"), "Model A");
      changeControl(requiredControl(secondInputs[0], "第二个模型 ID"), "model-b");
      changeControl(requiredControl(secondInputs[1], "第二个模型名称"), "Model B");
      rows[1]?.querySelector<HTMLInputElement>('input[type="radio"]')?.click();
      const secondChecks = rows[1]?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      secondChecks?.[1]?.click();

      const form = container.querySelector<HTMLFormElement>(".control-form");
      if (form === null) throw new Error("模型表单缺失");
      changeControl(
        requiredControl(
          form.querySelector<HTMLInputElement>('input[name="providerKey"]'),
          "Provider Key",
        ),
        "main",
      );
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
        requiredControl(
          form.querySelector<HTMLTextAreaElement>('textarea[name="reason"]'),
          "变更原因",
        ),
        "创建目录",
      );
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();

    expect(api.createModelDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        providerKey: "main",
        defaultModelId: "model-b",
        models: [
          expect.objectContaining({ id: "model-a", enabled: true }),
          expect.objectContaining({ id: "model-b", enabled: true, reasoning: true }),
        ],
      }),
    );

    act(() => root.unmount());
    container.remove();
  });

  it("自定义 Provider 可按模型名称读取 Pi 元数据", async () => {
    const api = fixture();
    const catalogModel: PiModelCatalogModelDto = {
      providerId: "deepseek",
      providerName: "DeepSeek",
      id: "deepseek-chat",
      name: "DeepSeek Chat",
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 8_192,
    };
    const lookupPromise = Promise.resolve<readonly PiModelCatalogModelDto[]>([catalogModel]);
    vi.mocked(api.findPiModelCatalogModels).mockImplementationOnce(() => lookupPromise);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();

    const modelsNavigation = [...container.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (item) => item.textContent === "模型",
    );
    if (modelsNavigation === undefined) throw new Error("模型导航缺失");
    act(() => modelsNavigation.click());
    await settle();
    const addCustomProvider = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "添加自定义 Provider",
    );
    if (addCustomProvider === undefined) throw new Error("自定义 Provider 按钮缺失");
    act(() => addCustomProvider.click());

    const query = container.querySelector<HTMLInputElement>(
      'input[placeholder="例如 deepseek-chat"]',
    );
    act(() => changeControl(requiredControl(query, "模型查询"), "DeepSeek Chat"));
    const search = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "从 Pi 查询",
    );
    if (search === undefined) throw new Error("Pi 查询按钮缺失");
    await act(async () => {
      search.click();
      await lookupPromise;
      await Promise.resolve();
    });
    const result = [
      ...container.querySelectorAll<HTMLButtonElement>(".pi-search-results button"),
    ].find((item) => item.textContent?.includes("deepseek-chat"));
    if (result === undefined) throw new Error("Pi 查询结果缺失");
    act(() => result.click());

    expect(api.findPiModelCatalogModels).toHaveBeenCalledWith({
      query: "DeepSeek Chat",
      limit: 12,
    });
    expect(container.textContent).toContain("DeepSeek Chat");
    expect(container.textContent).toContain("128,000 ctx");

    act(() => root.unmount());
    container.remove();
  });

  it("内置 Provider 自动载入对应的 Pi 模型目录", async () => {
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

    const modelsNavigation = [...container.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (item) => item.textContent === "模型",
    );
    if (modelsNavigation === undefined) throw new Error("模型导航缺失");
    act(() => modelsNavigation.click());
    await settle();
    expect(container.textContent).toContain("Pi Provider 目录");
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
    expect(container.querySelectorAll(".model-editor-row")).toHaveLength(2);
    expect(container.textContent).toContain("DeepSeek Reasoner");
    expect(container.textContent).toContain("已从 Pi 载入 2 个模型");

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

    const modelsNavigation = [...container.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (item) => item.textContent === "模型",
    );
    if (modelsNavigation === undefined) throw new Error("模型导航缺失");
    act(() => modelsNavigation.click());
    await settle();
    expect(container.textContent).toContain("1 个可配置 Provider");

    await act(async () => {
      resolveInitialOverview?.(overview);
      await initialOverview;
    });
    await settle();
    expect(container.textContent).toContain("1 个可配置 Provider");
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

    const modelsNavigation = [...container.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (item) => item.textContent === "模型",
    );
    if (modelsNavigation === undefined) throw new Error("模型导航缺失");
    act(() => modelsNavigation.click());
    await settle();

    expect(container.textContent).toContain("DeepSeek");
    expect(container.textContent).toContain("25 个可配置 Provider");

    const addCustomProvider = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "添加自定义 Provider",
    );
    if (addCustomProvider === undefined) throw new Error("自定义 Provider 按钮缺失");
    act(() => addCustomProvider.click());

    expect(container.querySelector(".model-catalog-editor")).not.toBeNull();
    expect(container.textContent).toContain("操作未完成");

    act(() => root.unmount());
    container.remove();
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderRevisionDto, PiModelCatalogModelDto } from "@hoox/protocol";
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
      secretRef: "deployment:model",
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

function requiredControl<T extends HTMLInputElement | HTMLTextAreaElement>(
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

    const navigation = [...container.querySelectorAll(".ant-menu-item")].map((item) =>
      item.textContent?.trim(),
    );
    expect(navigation).toEqual([
      "工作台",
      "数据运营",
      "用户管理",
      "模型服务",
      "记忆服务",
      "Skills",
      "身份与登录",
      "运行配置",
      "操作审计",
    ]);
    expect(container.textContent).toContain("累计 Run12");
    expect(container.textContent).toContain("MODEL_API_KEY");
    expect(container.textContent).toContain("已配置 · 部署秘密");
    expect(container.textContent).not.toContain("production-model-secret");

    act(() => navigationItem(container, "模型服务").click());
    await settle();
    expect(api.listModelProviders).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("尚未启用后台模型配置");
    expect(container.textContent).toContain("部署回退");
    expect(container.textContent).toContain("已配置，值不可见");

    act(() => navigationItem(container, "运行配置").click());
    await settle();
    expect(api.listRuntimeSettings).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("MODEL_API_KEY");
    expect(container.textContent).toContain("DATABASE_URL / DATABASE_SCHEMA");
    expect(container.textContent).toContain("CUBESANDBOX_API_URL / CUBESANDBOX_TEMPLATE_ID");
    expect(container.textContent).toContain("部署平台");
    expect(container.textContent).toContain("后台 Revision");

    act(() => navigationItem(container, "操作审计").click());
    await settle();
    expect(api.listAudits).toHaveBeenCalledWith(100);
    expect(container.textContent).toContain("控制面操作记录");
    expect(container.textContent).toContain("不可变审计事实");

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

    act(() => navigationItem(container, "运行配置").click());
    await settle();

    expect(container.textContent).toContain("部署配置地图");
    expect(container.textContent).toContain("DATABASE_SKILL_PUBLISHER_ROLE");
    expect(container.textContent).toContain("统一后台内的 Skill 模块");
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
    expect(container.textContent).toContain("秘密材料只保存在服务端");
    expect(container.querySelectorAll(".identity-provider-card")).toHaveLength(4);

    const github = container.querySelector<HTMLElement>('[data-provider="github"]');
    if (github === null) throw new Error("GitHub 身份源缺失");
    const fields = github.querySelectorAll<HTMLInputElement>("input");
    act(() => {
      changeControl(requiredControl(fields[0], "GitHub Client ID"), "github-client");
      changeControl(requiredControl(fields[1], "GitHub Client Secret"), "github-secret");
      github.querySelector<HTMLButtonElement>('[role="switch"]')?.click();
      changeControl(
        requiredControl(
          container.querySelector<HTMLInputElement>(
            'input[placeholder="例如：为内部测试开放 GitHub 登录"]',
          ),
          "身份策略变更原因",
        ),
        "为内部测试开放 GitHub 登录",
      );
    });
    const publish = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "保存并立即生效",
    );
    if (publish === undefined) throw new Error("身份策略发布按钮缺失");
    expect(publish.disabled).toBe(false);
    await act(async () => publish.click());
    await settle();

    expect(api.updateIdentityConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersionToken: 0,
        emailPasswordEnabled: true,
        registrationEnabled: true,
        phoneEnabled: false,
        reason: "为内部测试开放 GitHub 登录",
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

    act(() => navigationItem(container, "记忆服务").click());
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

    act(() => navigationItem(container, "模型服务").click());
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

  it("直接展示当前生效模型、版本和新 Run 边界", async () => {
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
    expect(effectiveState.textContent).toContain("当前生效");
    expect(effectiveState.textContent).toContain("DeepSeek / model-a");
    expect(effectiveState.textContent).toContain("Revision 1");
    expect(effectiveState.textContent).toContain("Generation 3");
    expect(effectiveState.textContent).toContain("只影响启用后创建的新 Run");
    expect(effectiveState.textContent).toContain("值不可见");

    act(() => root.unmount());
    container.remove();
  });

  it("未探测成功的 Provider 不能启用，健康版本可以启用", async () => {
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

    const failedCard = [...container.querySelectorAll<HTMLElement>(".control-revision")].find(
      (item) => item.textContent?.includes("deepseek"),
    );
    const healthyCard = [...container.querySelectorAll<HTMLElement>(".control-revision")].find(
      (item) => item.textContent?.includes("openrouter"),
    );
    if (failedCard === undefined || healthyCard === undefined) throw new Error("Provider 版本缺失");
    act(() => {
      changeControl(
        requiredControl(failedCard.querySelector<HTMLInputElement>("input"), "失败版本原因"),
        "重试启用",
      );
      changeControl(
        requiredControl(healthyCard.querySelector<HTMLInputElement>("input"), "健康版本原因"),
        "启用健康版本",
      );
    });

    const failedPublish = [...failedCard.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "启用此配置",
    );
    const healthyPublish = [...healthyCard.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "启用此配置",
    );
    if (failedPublish === undefined || healthyPublish === undefined) {
      throw new Error("Provider 启用按钮缺失");
    }
    expect(failedPublish.disabled).toBe(true);
    expect(failedCard.textContent).toContain("重新探测成功后才能启用");
    expect(healthyPublish.disabled).toBe(false);

    await act(async () => healthyPublish.click());
    await settle();
    expect(api.publish).toHaveBeenCalledWith("model-providers", "openrouter", 1, {
      expectedVersionToken: 2,
      reason: "启用健康版本",
    });

    act(() => root.unmount());
    container.remove();
  });

  it("隐藏历史疑似密钥，并在录入时立即清空", async () => {
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
    expect(container.textContent).toContain("页面已隐藏并禁止继续操作");

    const addCustomProvider = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "添加自定义 Provider",
    );
    if (addCustomProvider === undefined) throw new Error("自定义 Provider 按钮缺失");
    act(() => addCustomProvider.click());
    const providerKey = requiredControl(
      container.querySelector<HTMLInputElement>('input[name="providerKey"]'),
      "Provider 内部标识",
    );
    act(() => changeControl(providerKey, secretLikeIdentifier));
    await settle();

    expect(providerKey.value).toBe("");
    expect(container.textContent).toContain("检测到疑似 API Key，内容已清空");
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "保存待启用配置",
    );
    expect(save?.disabled).toBe(true);

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

    act(() => navigationItem(container, "模型服务").click());
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

    act(() => navigationItem(container, "模型服务").click());
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

    act(() => navigationItem(container, "模型服务").click());
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

    act(() => navigationItem(container, "模型服务").click());
    await settle();

    expect(container.textContent).toContain("DeepSeek");
    expect(container.textContent).toContain("25 个可配置 Provider");
    expect(container.textContent).toContain("无法确认当前实际使用的模型");
    expect(container.textContent).toContain("Pi 目录只能用于准备配置");

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

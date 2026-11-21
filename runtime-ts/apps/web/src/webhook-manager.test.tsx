// @vitest-environment jsdom

import { act, type ComponentProps, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { developmentSession, persistAccountSession } from "./account-access.js";
import { RuntimeApi, type TeamSummary, type TenantWebhook } from "./api.js";
import { App } from "./main.js";
import { WebhookManager } from "./webhook-manager.js";

let container: HTMLDivElement;
let root: Root;

type WebhookApi = ComponentProps<typeof WebhookManager>["api"];
type AppApi = NonNullable<ComponentProps<typeof App>["apiClient"]>;

const webhook: TenantWebhook = {
  id: "wh_test",
  name: "测试回调",
  endpointUrl: "https://hooks.example.invalid/hoox",
  eventTypes: ["run.succeeded"],
  createdAt: "2026-11-20T00:00:00.000Z",
};

const teams: readonly TeamSummary[] = [
  { id: "tenant_one", displayName: "测试团队一", role: "owner", joinedAt: webhook.createdAt },
  { id: "tenant_two", displayName: "测试团队二", role: "owner", joinedAt: webhook.createdAt },
];

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function webhookApi(overrides: Partial<WebhookApi> = {}): WebhookApi {
  return {
    listWebhooks: vi.fn(async () => ({ items: [webhook] })),
    createWebhook: vi.fn(async () => ({ webhook, secret: "example_created_secret" })),
    rotateWebhookSecret: vi.fn(async () => ({ secret: "example_rotated_secret" })),
    disableWebhook: vi.fn(async () => ({ webhook })),
    deleteWebhook: vi.fn(async () => ({ deleted: true })),
    ...overrides,
  };
}

async function clickButton(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (button === undefined) throw new Error(`缺少按钮：${text}`);
  await act(async () => button.click());
}

async function submitWebhook() {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    const name = container.querySelector('input[maxlength="120"]');
    const endpoint = container.querySelector('input[type="url"]');
    if (!(name instanceof HTMLInputElement) || !(endpoint instanceof HTMLInputElement))
      throw new Error("Webhook 创建字段缺失");
    setter?.call(name, "测试回调");
    name.dispatchEvent(new Event("input", { bubbles: true }));
    setter?.call(endpoint, webhook.endpointUrl);
    endpoint.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const form = container.querySelector("form");
  if (form === null) throw new Error("Webhook 创建表单缺失");
  await act(async () =>
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

async function switchTeam(tenantId: string) {
  if (container.querySelector(".team-switcher-controls select") === null) {
    const summary = container.querySelector<HTMLButtonElement>(".team-switcher-summary");
    if (summary === null) throw new Error("团队切换入口缺失");
    await act(async () => summary.click());
  }
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>(".team-switcher-controls select");
    if (select === null) throw new Error("团队目录缺失");
    select.value = tenantId;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const shortcut = container.querySelector<HTMLButtonElement>(".team-new-thread-shortcut");
  if (shortcut === null) throw new Error("团队会话入口缺失");
  await act(async () => shortcut.click());
}

function workspaceFixture(
  fetcher: typeof fetch,
  listTeams: () => Promise<readonly TeamSummary[]> = async () => teams,
) {
  const runtime = new RuntimeApi(fetcher, "/api");
  const unexpected = async (): Promise<never> => {
    throw new Error("本测试不执行此工作台操作");
  };
  const api: AppApi = {
    listThreads: async () => [],
    listThreadsForTenant: async () => [],
    listLatestRuns: async () => [],
    getRun: unexpected,
    listEvents: async () => ({ attemptId: undefined, items: [] }),
    listArtifacts: async () => [],
    createThread: unexpected,
    archiveThread: unexpected,
    createRun: unexpected,
    cancelRun: unexpected,
    downloadArtifact: unexpected,
    previewArtifact: unexpected,
    uploadResource: unexpected,
    listTeams,
    createTeam: unexpected,
    listTeamMembers: async () => [],
    addTeamMember: unexpected,
    changeTeamMemberRole: unexpected,
    removeTeamMember: unexpected,
    dissolveTeam: unexpected,
    setTenantId: runtime.setTenantId.bind(runtime),
    listWebhooks: runtime.listWebhooks.bind(runtime),
    createWebhook: runtime.createWebhook.bind(runtime),
    rotateWebhookSecret: runtime.rotateWebhookSecret.bind(runtime),
    disableWebhook: runtime.disableWebhook.bind(runtime),
    deleteWebhook: runtime.deleteWebhook.bind(runtime),
  };
  return { api, runtime };
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.localStorage.clear();
  window.sessionStorage.clear();
  persistAccountSession(window.localStorage, developmentSession);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("Webhook 管理页", () => {
  it("列出客户端工具事件并在创建后只展示一次签名密钥", async () => {
    const api = {
      listWebhooks: vi.fn(async () => ({ items: [] })),
      createWebhook: vi.fn(async () => ({
        webhook: {
          id: "wh_test",
          name: "运行回调",
          endpointUrl: "https://hooks.example.invalid/hoox",
          eventTypes: ["run.requires_action"],
          createdAt: "2026-11-20T00:00:00.000Z",
        },
        secret: "one_time_webhook_secret",
      })),
      rotateWebhookSecret: vi.fn(),
      disableWebhook: vi.fn(),
      deleteWebhook: vi.fn(),
    } as unknown as RuntimeApi;
    await act(async () =>
      root.render(<WebhookManager api={api} tenantId="team_opened" onClose={vi.fn()} />),
    );
    expect(container.textContent).toContain("客户端工具需要操作");

    const nameInput = container.querySelector('input[maxlength="120"]');
    const endpointInput = container.querySelector('input[type="url"]');
    if (!(nameInput instanceof HTMLInputElement) || !(endpointInput instanceof HTMLInputElement))
      throw new Error("Webhook 创建字段缺失");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(nameInput, "运行回调");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      setter?.call(endpointInput, "https://hooks.example.invalid/hoox");
      endpointInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = container.querySelector("form");
    if (form === null) throw new Error("Webhook 创建表单缺失");
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(api.createWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "运行回调",
        endpointUrl: "https://hooks.example.invalid/hoox",
      }),
      "team_opened",
    );
    expect(container.textContent).toContain("one_time_webhook_secret");
    expect(container.textContent).toContain("此后无法再次查看");
    await clickButton("完成");
    expect(container.textContent).not.toContain("one_time_webhook_secret");
  });

  it("StrictMode 重建 Effect 后仍可加载，首次失活加载的迟到结果不覆盖当前列表", async () => {
    const first = deferred<{ readonly items: readonly TenantWebhook[] }>();
    const api = webhookApi({
      listWebhooks: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue({ items: [webhook] }),
    });
    await act(async () =>
      root.render(
        <StrictMode>
          <WebhookManager api={api} tenantId="tenant_one" onClose={vi.fn()} />
        </StrictMode>,
      ),
    );
    expect(api.listWebhooks).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain(webhook.name);
    await act(async () => first.resolve({ items: [{ ...webhook, name: "失活加载的回调" }] }));
    expect(container.textContent).toContain(webhook.name);
    expect(container.textContent).not.toContain("失活加载的回调");
    await clickButton("轮换密钥");
    expect(container.textContent).toContain("example_rotated_secret");
  });

  it.each([
    { label: "轮换密钥", method: "rotateWebhookSecret" as const },
    { label: "停用", method: "disableWebhook" as const },
    { label: "删除", method: "deleteWebhook" as const },
  ])("$label 和刷新均携带打开时的 Tenant", async ({ label, method }) => {
    const api = webhookApi();
    await act(async () =>
      root.render(<WebhookManager api={api} tenantId="tenant_one" onClose={vi.fn()} />),
    );
    await clickButton(label);
    expect(api[method]).toHaveBeenCalledWith(webhook.id, "tenant_one");
    expect(api.listWebhooks).toHaveBeenCalledTimes(2);
    expect(api.listWebhooks).toHaveBeenLastCalledWith("tenant_one");
  });
});

describe("Webhook 工作台真实租户切换边界", () => {
  it("个人与团队切换卸载弹窗并清除明文，普通父级重绘不重复加载", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      Response.json({
        data:
          init?.method === "POST" ? { webhook, secret: "example_personal_secret" } : { items: [] },
      }),
    );
    const { api, runtime } = workspaceFixture(fetcher);
    await act(async () => root.render(<App apiClient={api} />));
    await clickButton("Webhook 管理");
    runtime.setTenantId("tenant_two");
    await submitWebhook();
    expect(container.textContent).toContain("example_personal_secret");
    expect(fetcher).toHaveBeenCalledTimes(3);
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".team-switcher-summary")?.click(),
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("example_personal_secret");
    for (const [, init] of fetcher.mock.calls)
      expect(new Headers(init?.headers).get("X-Tenant-ID")).toBeNull();

    await switchTeam("tenant_one");
    expect(runtime.getTenantId()).toBe("tenant_one");
    expect(container.querySelector('[aria-labelledby="webhook-title"]')).toBeNull();
    expect(container.textContent).not.toContain("example_personal_secret");
    await clickButton("Webhook 管理");
    expect(new Headers(fetcher.mock.lastCall?.[1]?.headers).get("X-Tenant-ID")).toBe("tenant_one");
    expect(container.textContent).not.toContain("example_personal_secret");
    await submitWebhook();
    expect(container.textContent).toContain("example_personal_secret");
    const personal = container.querySelector<HTMLButtonElement>(".new-thread-button");
    if (personal === null) throw new Error("个人会话入口缺失");
    await act(async () => personal.click());
    expect(runtime.getTenantId()).toBeUndefined();
    expect(container.querySelector('[aria-labelledby="webhook-title"]')).toBeNull();
    expect(container.textContent).not.toContain("example_personal_secret");
    await clickButton("Webhook 管理");
    expect(new Headers(fetcher.mock.lastCall?.[1]?.headers).get("X-Tenant-ID")).toBeNull();
    expect(container.textContent).not.toContain("example_personal_secret");
  });

  it.each(
    ["列表", "创建", "轮换密钥", "停用", "删除"].flatMap((action) =>
      ["成功", "失败"].map((outcome) => ({ action, outcome })),
    ),
  )("团队切换并重新打开后忽略旧$action 请求的迟到$outcome", async ({ action, outcome }) => {
    const pending = deferred<Response>();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const tenantId = new Headers(init?.headers).get("X-Tenant-ID");
      if (
        tenantId === "tenant_one" &&
        ((action === "列表" && init?.method === undefined) || init?.method !== undefined)
      )
        return pending.promise;
      return Response.json({
        data: { items: [{ ...webhook, name: `测试回调 ${tenantId}` }] },
      });
    });
    const { api, runtime } = workspaceFixture(fetcher);
    await act(async () => root.render(<App apiClient={api} />));
    await switchTeam("tenant_one");
    await clickButton("Webhook 管理");
    if (action === "创建") await submitWebhook();
    else if (action !== "列表") await clickButton(action);
    expect(new Headers(fetcher.mock.lastCall?.[1]?.headers).get("X-Tenant-ID")).toBe("tenant_one");
    await switchTeam("tenant_two");
    expect(runtime.getTenantId()).toBe("tenant_two");
    expect(container.querySelector('[aria-labelledby="webhook-title"]')).toBeNull();
    await clickButton("Webhook 管理");
    expect(container.textContent).toContain("测试回调 tenant_two");
    const requestCount = fetcher.mock.calls.length;
    await act(async () =>
      pending.resolve(
        outcome === "失败"
          ? Response.json({ error: { message: "旧团队请求失败" } }, { status: 500 })
          : Response.json({
              data: {
                items: [{ ...webhook, name: "旧团队迟到列表" }],
                webhook,
                secret: "example_stale_secret",
                deleted: true,
              },
            }),
      ),
    );
    expect(fetcher).toHaveBeenCalledTimes(requestCount);
    expect(container.textContent).toContain("测试回调 tenant_two");
    expect(container.textContent).not.toContain("旧团队迟到列表");
    expect(container.textContent).not.toContain("example_stale_secret");
    expect(container.querySelector('[aria-labelledby="webhook-title"] [role="alert"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      false,
    );
    await clickButton("关闭");
    await switchTeam("tenant_one");
    expect(container.querySelector('[aria-labelledby="webhook-title"]')).toBeNull();
  });

  it.each(["关闭重开", "切回原团队"])("同一 Tenant %s 后也忽略旧轮换结果", async (mode) => {
    const pending = deferred<Response>();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST" ? pending.promise : Response.json({ data: { items: [webhook] } }),
    );
    const { api } = workspaceFixture(fetcher);
    await act(async () => root.render(<App apiClient={api} />));
    await switchTeam("tenant_one");
    await clickButton("Webhook 管理");
    await clickButton("轮换密钥");
    if (mode === "关闭重开") await clickButton("关闭");
    else {
      await switchTeam("tenant_two");
      await switchTeam("tenant_one");
    }
    await clickButton("Webhook 管理");
    const requestCount = fetcher.mock.calls.length;
    await act(async () =>
      pending.resolve(Response.json({ data: { secret: "example_old_rotation" } })),
    );
    expect(fetcher).toHaveBeenCalledTimes(requestCount);
    expect(container.textContent).not.toContain("example_old_rotation");
    expect(container.querySelector(".api-key-once")).toBeNull();
  });

  it("团队目录撤销活动团队时关闭弹窗，不自动挂载个人空间管理页", async () => {
    let directory = teams;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      Response.json({
        data: init?.method === "POST" ? { webhook, secret: "example_team_secret" } : { items: [] },
      }),
    );
    const { api, runtime } = workspaceFixture(fetcher, async () => directory);
    await act(async () => root.render(<App apiClient={api} />));
    await switchTeam("tenant_one");
    await clickButton("Webhook 管理");
    await submitWebhook();
    expect(container.textContent).toContain("example_team_secret");
    const requestCount = fetcher.mock.calls.length;
    directory = teams.filter((team) => team.id !== "tenant_one");
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".account-menu-trigger")?.click(),
    );
    const teamCenter = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".account-menu-section button"),
    ).find((button) => button.textContent?.includes("团队中心"));
    if (teamCenter === undefined) throw new Error("团队中心入口缺失");
    await act(async () => teamCenter.click());
    const refresh = container.querySelector<HTMLButtonElement>(".team-center-refresh");
    if (refresh === null) throw new Error("团队刷新入口缺失");
    await act(async () => refresh.click());
    expect(runtime.getTenantId()).toBeUndefined();
    expect(container.querySelector('[aria-labelledby="webhook-title"]')).toBeNull();
    expect(container.textContent).not.toContain("example_team_secret");
    expect(fetcher).toHaveBeenCalledTimes(requestCount);
    const close = container.querySelector<HTMLButtonElement>('[aria-label="关闭团队中心"]');
    if (close === null) throw new Error("团队中心关闭入口缺失");
    await act(async () => close.click());
    await clickButton("Webhook 管理");
    expect(new Headers(fetcher.mock.lastCall?.[1]?.headers).get("X-Tenant-ID")).toBeNull();
    expect(container.textContent).not.toContain("example_team_secret");
  });
});

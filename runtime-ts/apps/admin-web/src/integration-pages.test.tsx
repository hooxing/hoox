// @vitest-environment jsdom

import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { IntegrationApi } from "./integration-api.js";
import { IntegrationApiKeysPage } from "./integration-api-keys.js";
import { IntegrationWebhooksPage } from "./integration-webhooks.js";
import { App } from "./app.js";
import type { SkillAdminApiContract } from "./api.js";
import { button, enter, field, render, settle } from "./testing/admin-component.js";

const key = {
  id: "key_test",
  prefix: "hoox_sk_abcd",
  name: "业务系统",
  scopes: ["threads:read"],
  createdAt: "2026-11-21T00:00:00.000Z",
};
const webhook = {
  id: "wh_test",
  name: "业务回调",
  endpointUrl: "https://events.example.invalid/hooks",
  eventTypes: ["run.succeeded"],
  createdAt: "2026-11-21T00:00:00.000Z",
};
const ok = (data: unknown) => Response.json({ data });
async function click(root: ParentNode, name: string) {
  act(() => button(root, name).click());
  await settle();
}
const tenantItems = [
  { tenantId: "tenant_a", displayName: "admin@example.invalid", kind: "personal", isDefault: true },
  { tenantId: "tenant_b", displayName: "团队空间", kind: "team", isDefault: false },
  { tenantId: "tenant_first", displayName: "第一空间", kind: "team", isDefault: false },
  { tenantId: "tenant_second", displayName: "第二空间", kind: "team", isDefault: false },
];
async function tenant(root: ParentNode, id: string) {
  const combo = root.querySelector<HTMLInputElement>('[role="combobox"]');
  if (!combo) throw new Error("缺少空间选择器");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(combo, id);
    combo.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  const option = [...document.querySelectorAll<HTMLElement>(".ant-select-item-option")].find(
    (item) => item.textContent?.includes(id),
  );
  if (!option) throw new Error(`未找到空间：${id}`);
  act(() => option.click());
  await settle();
}

describe("后台接入页面", () => {
  it.each([
    ["/integration-api-keys", "API Key"],
    ["/integration-webhooks", "Webhook"],
  ])("路由 %s 提供接入分组和 Tenant 选择", async (path, name) => {
    const root = render(<App apiClient={{} as SkillAdminApiContract} initialPath={path} />);
    await settle();
    expect(root.textContent).toContain("接入");
    expect(root.textContent).toContain(name);
    expect(root.querySelector('[aria-label="选择空间"]')).toBeDefined();
  });

  it("按 Tenant 创建、轮换、吊销 Key，关闭明文后刷新不再展示", async () => {
    const token = "hoox_sk_test-once-placeholder";
    const rotated = "hoox_sk_test-rotated-placeholder";
    let items: object[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      if (path.endsWith("/integrations/tenants")) return ok({ items: tenantItems });
      if (init?.method === "GET") return ok({ items });
      if (init?.method === "DELETE") {
        items = [{ ...key, revokedAt: "2026-11-21T01:00:00.000Z" }];
        return ok(items[0]);
      }
      items = [key];
      return ok({ key, token: path.endsWith("/rotate") ? rotated : token });
    });
    const root = render(<IntegrationApiKeysPage api={new IntegrationApi(fetcher)} />);
    await tenant(root, "tenant_a");
    enter(field<HTMLInputElement>(root, "名称"), key.name);
    enter(field<HTMLInputElement>(root, "备注"), "业务服务");
    enter(field<HTMLInputElement>(root, "到期时间"), "2099-01-01T00:00");
    await click(root, "创建 API Key");
    expect(root.textContent?.includes(token)).toBe(true);
    const payload = JSON.parse(
      String(fetcher.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body),
    );
    expect(payload).toMatchObject({
      name: key.name,
      note: "业务服务",
      scopes: ["threads:read", "runs:read"],
    });
    expect(Date.parse(payload.expiresAt)).toBeGreaterThan(Date.now());
    await click(root, "已保存，关闭");
    await click(root, "刷新列表");
    expect(root.textContent?.includes(token)).toBe(false);
    await click(root, "轮换");
    expect(root.textContent?.includes(rotated)).toBe(true);
    await click(root, "吊销");
    expect(root.textContent).toContain("已吊销");
    expect(root.textContent?.includes(rotated)).toBe(false);
    expect(
      fetcher.mock.calls.every(
        ([url]) =>
          String(url).endsWith("/integrations/tenants") ||
          String(url).startsWith("/v1/admin/control/integrations/tenant_a/api-keys"),
      ),
    ).toBe(true);
    expect(fetcher.mock.calls.every(([, init]) => init?.cache === "no-store")).toBe(true);
  });

  it("注册事件订阅、轮换密钥并显示自动停用原因", async () => {
    const secret = "webhook-once-placeholder";
    let items: object[] = [
      { ...webhook, disabledAt: webhook.createdAt, disabledReason: "delivery_attempts_exhausted" },
    ];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/integrations/tenants")) return ok({ items: tenantItems });
      if (init?.method === "GET") return ok({ items });
      if (init?.method === "DELETE") {
        items = [];
        return ok({ deleted: true });
      }
      if (String(url).endsWith("/rotate-secret"))
        return ok({ secret: "webhook-rotated-placeholder" });
      if (String(url).endsWith("/disable")) {
        items = [
          { ...webhook, disabledAt: webhook.createdAt, disabledReason: "disabled_by_owner" },
        ];
        return ok({ webhook: items[0] });
      }
      items = [webhook];
      return ok({ webhook, secret });
    });
    const root = render(<IntegrationWebhooksPage api={new IntegrationApi(fetcher)} />);
    await tenant(root, "tenant_b");
    expect(root.textContent).toContain("delivery_attempts_exhausted");
    enter(field<HTMLInputElement>(root, "名称"), webhook.name);
    enter(field<HTMLInputElement>(root, "公网 HTTPS 地址"), webhook.endpointUrl);
    await click(root, "注册 Webhook");
    expect(root.textContent?.includes(secret)).toBe(true);
    const payload = JSON.parse(
      String(fetcher.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body),
    );
    expect(payload).toMatchObject({
      name: webhook.name,
      endpointUrl: webhook.endpointUrl,
      eventTypes: ["run.succeeded", "run.failed"],
    });
    await click(root, "已保存，关闭");
    await click(root, "刷新列表");
    expect(root.textContent?.includes(secret)).toBe(false);
    await click(root, "轮换密钥");
    expect(root.textContent).toContain("webhook-rotated-placeholder");
    await click(root, "停用");
    expect(root.textContent).toContain("disabled_by_owner");
    await click(root, "删除");
    expect(root.textContent).toContain("暂无 Webhook");
    expect(
      fetcher.mock.calls.every(
        ([url]) =>
          String(url).includes("/integrations/tenants") ||
          /^\/v1\/admin\/control\/integrations\/tenant_[ab]\/webhooks/.test(String(url)),
      ),
    ).toBe(true);
  });

  it.each(["api-key", "webhook"])(
    "切换 Tenant 后迟到的 %s 创建响应不能展示旧秘密",
    async (kind) => {
      let finish!: (response: Response) => void;
      const fetcher = vi.fn<typeof fetch>(async (url, init) =>
        String(url).endsWith("/integrations/tenants")
          ? ok({ items: tenantItems })
          : init?.method === "GET"
            ? ok({ items: [] })
            : new Promise((resolve) => {
                finish = resolve;
              }),
      );
      const api = new IntegrationApi(fetcher);
      const root = render(
        kind === "api-key" ? (
          <IntegrationApiKeysPage api={api} />
        ) : (
          <IntegrationWebhooksPage api={api} />
        ),
      );
      await tenant(root, "tenant_first");
      enter(field<HTMLInputElement>(root, "名称"), "异步创建");
      if (kind === "webhook")
        enter(field<HTMLInputElement>(root, "公网 HTTPS 地址"), webhook.endpointUrl);
      await click(root, kind === "api-key" ? "创建 API Key" : "注册 Webhook");
      await tenant(root, "tenant_second");
      await act(async () => {
        finish(
          ok(
            kind === "api-key"
              ? { key, token: "old-secret-placeholder" }
              : { webhook, secret: "old-secret-placeholder" },
          ),
        );
      });
      await settle();
      expect(root.textContent).toContain("当前空间：第二空间 tenant_second");
      expect(root.textContent).not.toContain("old-secret-placeholder");
      expect(root.textContent).not.toContain("一次性凭据");
    },
  );

  it("服务端拒绝非管理员时不回显响应中的秘密或重试写入", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) =>
      String(url).endsWith("/integrations/tenants")
        ? ok({ items: tenantItems })
        : init?.method === "GET"
          ? ok({ items: [] })
          : Response.json({ error: { message: "must-not-display-secret" } }, { status: 401 }),
    );
    const root = render(<IntegrationApiKeysPage api={new IntegrationApi(fetcher)} />);
    await tenant(root, "tenant_a");
    enter(field<HTMLInputElement>(root, "名称"), "拒绝");
    await click(root, "创建 API Key");
    expect(root.textContent).toContain("仅平台管理员");
    expect(root.textContent).not.toContain("must-not-display-secret");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});

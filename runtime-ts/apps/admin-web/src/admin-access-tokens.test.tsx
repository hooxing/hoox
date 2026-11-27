// @vitest-environment jsdom

import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { AdminAccessTokensPage } from "./admin-access-tokens.js";
import { App } from "./app.js";
import type { SkillAdminApiContract } from "./api.js";
import type {
  AdminAccessTokenApiContract,
  AdminAccessTokenDto,
  AdminControlApiContract,
} from "./control-api.js";
import { button, enter, field, render, settle } from "./testing/admin-component.js";

const accessToken: AdminAccessTokenDto = {
  id: "f670e4a5-9a43-4240-9e93-d39bba5bc9f1",
  name: "CI 配置同步",
  scopes: ["agent-config:read", "agent-config:write"],
  createdBy: "admin_user",
  createdAt: "2026-11-21T00:00:00.000Z",
  lastUsedAt: null,
  expiresAt: "2027-02-19T00:00:00.000Z",
  revokedAt: null,
};

describe("后台访问令牌", () => {
  it("识别访问令牌页顶栏，并给评测菜单项提供可访问名称", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { items: [], nextCursor: null } })),
    );
    const root = render(
      <App
        apiClient={{} as SkillAdminApiContract}
        controlApi={
          { getControlAccess: async () => ({ allowed: true }) } as AdminControlApiContract
        }
        initialPath="/access-tokens"
      />,
    );
    await settle();
    expect(root.querySelector(".platform-page-context strong")?.textContent).toBe("后台访问令牌");
    expect(root.querySelector('[role="menuitem"][aria-label="评测"]')).not.toBeNull();
  });

  it("创建时仅展示一次明文，并允许撤销", async () => {
    const token = "hoox_at_placeholder-token-value";
    let revoked = false;
    const api: AdminAccessTokenApiContract = {
      listAccessTokens: vi.fn(async () => ({
        items: revoked ? [{ ...accessToken, revokedAt: "2026-11-22T00:00:00Z" }] : [accessToken],
        nextCursor: null,
      })),
      createAccessToken: vi.fn(async () => ({ token, accessToken })),
      revokeAccessToken: vi.fn(async () => {
        revoked = true;
        return { revoked: true };
      }),
    };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const root = render(<AdminAccessTokensPage api={api} />);
    await settle();
    enter(field<HTMLInputElement>(root, "名称"), "CI 配置同步");
    await act(async () => {
      root
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle();
    });
    expect(api.createAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ name: "CI 配置同步", scopes: ["agent-config:read"] }),
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(token);
    await act(async () => {
      button(document, "我已保存，关闭").click();
    });
    expect(document.body.textContent).not.toContain(token);
    await act(async () => {
      button(root, "撤销").click();
      await settle();
    });
    expect(api.revokeAccessToken).toHaveBeenCalledWith(accessToken.id);
    expect(root.textContent).toContain("已撤销");
  });

  it("显示 CLI 参考，并在同一标签中显示作用域勾选框及其文字", async () => {
    const api: AdminAccessTokenApiContract = {
      listAccessTokens: vi.fn(async () => ({ items: [], nextCursor: null })),
      createAccessToken: vi.fn(),
      revokeAccessToken: vi.fn(),
    };
    const root = render(<AdminAccessTokensPage api={api} />);
    await settle();
    expect(root.querySelector('a[href$="/docs/reference/cli.md"]')?.textContent).toBe("CLI 参考");
    const read = field<HTMLInputElement>(root, "Agent 配置读取");
    const write = field<HTMLInputElement>(root, "Agent 配置写入");
    expect(write.closest(".ant-checkbox-wrapper")?.textContent).toBe("Agent 配置写入（包含读取）");
    act(() => read.click());
    act(() => write.click());
    expect(read.checked).toBe(true);
    expect(read.disabled).toBe(true);
    act(() => write.click());
    expect(read.checked).toBe(false);
  });

  it("页面停留时令牌到期后更新状态", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-24T00:00:00.000Z") });
    const api: AdminAccessTokenApiContract = {
      listAccessTokens: vi.fn(async () => ({
        items: [{ ...accessToken, expiresAt: new Date(Date.now() + 1_000).toISOString() }],
        nextCursor: null,
      })),
      createAccessToken: vi.fn(),
      revokeAccessToken: vi.fn(),
    };
    try {
      const root = render(<AdminAccessTokensPage api={api} />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(root.textContent).toContain("有效");
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(root.textContent).toContain("已过期");
    } finally {
      vi.useRealTimers();
    }
  });

  it("按状态筛选并使用游标前后翻页", async () => {
    const nextToken = { ...accessToken, id: "second-page-token", name: "第二页令牌" };
    const api: AdminAccessTokenApiContract = {
      listAccessTokens: vi.fn(async ({ status, cursor }) =>
        status === "revoked"
          ? { items: [{ ...accessToken, revokedAt: "2026-11-22T00:00:00Z" }], nextCursor: null }
          : cursor === undefined
            ? { items: [accessToken], nextCursor: "opaque-next-cursor" }
            : { items: [nextToken], nextCursor: null },
      ),
      createAccessToken: vi.fn(),
      revokeAccessToken: vi.fn(),
    };
    const root = render(<AdminAccessTokensPage api={api} />);
    await settle();
    await act(async () => {
      button(root, "下一页").click();
      await settle();
    });
    expect(root.textContent).toContain("第二页令牌");
    expect(api.listAccessTokens).toHaveBeenLastCalledWith({
      status: "active",
      cursor: "opaque-next-cursor",
    });
    await act(async () => {
      button(root, "上一页").click();
      await settle();
    });
    const statusFilter = root.querySelector('[aria-label="令牌状态筛选"]');
    expect(statusFilter).not.toBeNull();
    act(() => statusFilter?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await settle();
    const option = [...document.querySelectorAll<HTMLElement>(".ant-select-item-option")].find(
      (item) => item.textContent === "已撤销",
    );
    expect(option).toBeDefined();
    act(() => option?.click());
    await settle();
    expect(api.listAccessTokens).toHaveBeenLastCalledWith({ status: "revoked" });
    expect(root.textContent).toContain("已撤销");
  });
});

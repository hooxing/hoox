// @vitest-environment jsdom

import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { AdminAccessTokensPage } from "./admin-access-tokens.js";
import type { AdminAccessTokenApiContract, AdminAccessTokenDto } from "./control-api.js";
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
  it("创建时仅展示一次明文，并允许撤销", async () => {
    const token = "hoox_at_placeholder-token-value";
    let revoked = false;
    const api: AdminAccessTokenApiContract = {
      listAccessTokens: vi.fn(async () =>
        revoked ? [{ ...accessToken, revokedAt: "2026-11-22T00:00:00Z" }] : [accessToken],
      ),
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
    expect(root.textContent).toContain(token);
    await act(async () => {
      button(root, "我已保存，关闭").click();
    });
    expect(root.textContent).not.toContain(token);
    await act(async () => {
      button(root, "撤销").click();
      await settle();
    });
    expect(api.revokeAccessToken).toHaveBeenCalledWith(accessToken.id);
    expect(root.textContent).toContain("已撤销");
  });
});

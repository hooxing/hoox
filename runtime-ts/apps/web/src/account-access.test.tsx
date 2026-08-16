// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountAccess,
  AccountMenu,
  clearAccountSession,
  developmentAccount,
  persistAccountSession,
  readAccountSession,
  type AccountProfile,
} from "./account-access.js";

const roots: Root[] = [];

function mount(element: React.ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(element));
  return container;
}

function change(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.localStorage.clear();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe("本地账号会话", () => {
  it("首次进入显示登录注册入口，并能持久化或清除会话", () => {
    expect(readAccountSession(window.localStorage)).toBeUndefined();

    clearAccountSession(window.localStorage);
    expect(readAccountSession(window.localStorage)).toBeUndefined();

    const profile: AccountProfile = {
      id: "local-user",
      displayName: "林晓",
      email: "lin@example.com",
    };
    persistAccountSession(window.localStorage, profile);
    expect(readAccountSession(window.localStorage)).toEqual(profile);
  });

  it("可注册本机账号，并在退出后使用同一邮箱和密码登录", async () => {
    clearAccountSession(window.localStorage);
    const authenticated = vi.fn();
    const container = mount(
      <AccountAccess storage={window.localStorage} onAuthenticated={authenticated} />,
    );

    act(() => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        .find((button) => button.textContent === "注册")
        ?.click();
    });
    const inputs = container.querySelectorAll<HTMLInputElement>(".account-access-form input");
    change(inputs[0] as HTMLInputElement, "林晓");
    change(inputs[1] as HTMLInputElement, "lin@example.com");
    change(inputs[2] as HTMLInputElement, "secret12");
    change(inputs[3] as HTMLInputElement, "secret12");
    act(() => container.querySelector<HTMLFormElement>("form")?.requestSubmit());

    await vi.waitFor(() => expect(authenticated).toHaveBeenCalledTimes(1));
    expect(authenticated.mock.calls[0]?.[0]).toMatchObject({
      displayName: "林晓",
      email: "lin@example.com",
    });

    clearAccountSession(window.localStorage);
    act(() => {
      roots.pop()?.unmount();
      container.remove();
    });
    const login = vi.fn();
    const loginContainer = mount(
      <AccountAccess storage={window.localStorage} onAuthenticated={login} />,
    );
    const loginInputs = loginContainer.querySelectorAll<HTMLInputElement>(
      ".account-access-form input",
    );
    change(loginInputs[0] as HTMLInputElement, "lin@example.com");
    change(loginInputs[1] as HTMLInputElement, "secret12");
    act(() => loginContainer.querySelector<HTMLFormElement>("form")?.requestSubmit());

    await vi.waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    expect(login.mock.calls[0]?.[0]).toMatchObject({ displayName: "林晓" });
  });
});

describe("侧栏用户设置菜单", () => {
  it("展示用户信息，并从弹出菜单进入团队管理或退出登录", () => {
    const openTeamCenter = vi.fn();
    const openTeamManagement = vi.fn();
    const signOut = vi.fn();
    const container = mount(
      <AccountMenu
        profile={developmentAccount}
        activeTeamName="测试团队"
        canManageActiveTeam
        onOpenTeamCenter={openTeamCenter}
        onOpenTeamManagement={openTeamManagement}
        onSignOut={signOut}
      />,
    );

    expect(container.querySelector(".account-menu-trigger")?.textContent).toContain("Hoox");
    act(() => container.querySelector<HTMLButtonElement>(".account-menu-trigger")?.click());
    expect(container.querySelector('[aria-label="用户设置菜单"]')?.textContent).toContain(
      "dev-user-a@local.hoox",
    );

    const actions = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".account-menu-section button"),
    );
    act(() => actions.find((button) => button.textContent?.includes("管理当前团队"))?.click());
    expect(openTeamManagement).toHaveBeenCalledTimes(1);

    act(() => container.querySelector<HTMLButtonElement>(".account-menu-trigger")?.click());
    const reopenedActions = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".account-menu-section button"),
    );
    act(() => reopenedActions.find((button) => button.textContent?.includes("退出登录"))?.click());
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(openTeamCenter).not.toHaveBeenCalled();
  });
});

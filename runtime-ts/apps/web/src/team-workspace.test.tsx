// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamSummary } from "./api.js";
import { TeamCenterDialog, TeamSwitcher } from "./team-workspace.js";

const teams: readonly TeamSummary[] = [
  {
    id: "tenant_product",
    displayName: "产品团队",
    role: "owner",
    joinedAt: "2026-08-09T08:00:00.000Z",
  },
  {
    id: "tenant_sales",
    displayName: "销售团队",
    role: "member",
    joinedAt: "2026-08-09T09:00:00.000Z",
  },
];

describe("团队空间切换器", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("默认折叠且只展示当前团队，展开后不把个人空间列入团队切换", async () => {
    const onSwitch = vi.fn();
    const onNewTeamThread = vi.fn();
    await act(async () =>
      root.render(
        <TeamSwitcher
          teams={teams}
          selectedTeamId="tenant_product"
          loading={false}
          onSwitch={onSwitch}
          onNewTeamThread={onNewTeamThread}
          onOpenTeamCenter={vi.fn()}
          taskCount={1}
        >
          <button type="button">市场分析</button>
        </TeamSwitcher>,
      ),
    );

    expect(container.textContent).toContain("产品团队");
    expect(container.textContent).not.toContain("销售团队");
    expect(container.querySelector("select")).toBeNull();
    const create = container.querySelector<HTMLButtonElement>(".team-new-thread-shortcut");
    expect(create?.textContent).toContain("新增对话");
    expect(container.textContent).not.toContain("新建团队对话");
    await act(async () => create?.click());
    expect(onNewTeamThread).toHaveBeenCalledOnce();

    const summary = container.querySelector<HTMLButtonElement>(".team-switcher-summary");
    await act(async () => summary?.click());
    const select = container.querySelector<HTMLSelectElement>("select");
    expect(select?.options).toHaveLength(2);
    expect(Array.from(select?.options ?? []).map((option) => option.text)).not.toContain(
      "个人空间",
    );
    expect(container.textContent).toContain("销售团队");
    expect(container.textContent).toContain("团队任务1");
    expect(container.textContent).toContain("市场分析");

    await act(async () => {
      if (select !== null) {
        select.value = "tenant_sales";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(onSwitch).toHaveBeenCalledWith("tenant_sales");
  });

  it("刷新组件后保留用户选择的展开状态", async () => {
    const renderSwitcher = () =>
      root.render(
        <TeamSwitcher
          teams={teams}
          selectedTeamId="tenant_product"
          loading={false}
          onSwitch={vi.fn()}
          onNewTeamThread={vi.fn()}
          onOpenTeamCenter={vi.fn()}
          taskCount={1}
        >
          <button type="button">市场分析</button>
        </TeamSwitcher>,
      );

    await act(async () => renderSwitcher());
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".team-switcher-summary")?.click(),
    );
    expect(container.querySelector(".team-switcher-body")).not.toBeNull();

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => renderSwitcher());

    expect(container.querySelector(".team-switcher-body")).not.toBeNull();
    expect(
      container
        .querySelector<HTMLButtonElement>(".team-switcher-summary")
        ?.getAttribute("aria-expanded"),
    ).toBe("true");

    await act(async () =>
      container.querySelector<HTMLButtonElement>(".team-switcher-summary")?.click(),
    );
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => renderSwitcher());

    expect(container.querySelector(".team-switcher-body")).toBeNull();
    expect(
      container
        .querySelector<HTMLButtonElement>(".team-switcher-summary")
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("没有团队时直接打开团队中心，不展开空任务栏", async () => {
    const onOpenTeamCenter = vi.fn();
    await act(async () =>
      root.render(
        <TeamSwitcher
          teams={[]}
          loading={false}
          onSwitch={vi.fn()}
          onNewTeamThread={vi.fn()}
          onOpenTeamCenter={onOpenTeamCenter}
          taskCount={0}
        />,
      ),
    );

    const summary = container.querySelector<HTMLButtonElement>(".team-switcher-summary");
    expect(summary?.textContent).toContain("创建或加入团队");
    await act(async () => summary?.click());
    expect(onOpenTeamCenter).toHaveBeenCalledOnce();
    expect(container.querySelector(".team-switcher-body")).toBeNull();
  });

  it("团队创建与加入说明集中在团队中心", async () => {
    const onCreate = vi.fn(async () => undefined);
    const onRefresh = vi.fn(async () => undefined);
    await act(async () =>
      root.render(
        <TeamCenterDialog
          teams={teams}
          selectedTeamId="tenant_product"
          loading={false}
          onSelectTeam={vi.fn()}
          onCreate={onCreate}
          onRefresh={onRefresh}
          onManage={vi.fn()}
          onClose={vi.fn()}
        />,
      ),
    );

    expect(container.textContent).toContain("创建团队");
    expect(container.textContent).toContain("加入团队");
    const input = container.querySelector<HTMLInputElement>('input[placeholder="团队名称"]');
    await act(async () => {
      if (input !== null) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          input,
          "研发团队",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    const form = input?.closest("form");
    await act(async () =>
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(onCreate).toHaveBeenCalledWith("研发团队");

    const refreshJoin = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("刷新加入状态"),
    );
    await act(async () => refreshJoin?.click());
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});

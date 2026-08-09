// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamSummary } from "./api.js";
import { TeamSwitcher } from "./team-workspace.js";

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
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("默认折叠且只展示当前团队，展开后通过单一下拉切换", async () => {
    const onSwitch = vi.fn();
    const onNewTeamThread = vi.fn();
    await act(async () =>
      root.render(
        <TeamSwitcher
          teams={teams}
          activeTeamId="tenant_product"
          loading={false}
          onSwitch={onSwitch}
          onCreate={vi.fn(async () => undefined)}
          onNewTeamThread={onNewTeamThread}
          onManage={vi.fn()}
        />,
      ),
    );

    expect(container.textContent).toContain("产品团队");
    expect(container.textContent).not.toContain("销售团队");
    expect(container.querySelector("select")).toBeNull();

    const summary = container.querySelector<HTMLButtonElement>(".team-switcher-summary");
    await act(async () => summary?.click());
    const select = container.querySelector<HTMLSelectElement>("select");
    expect(select?.options).toHaveLength(3);
    expect(container.textContent).toContain("销售团队");

    await act(async () => {
      if (select !== null) {
        select.value = "tenant_sales";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(onSwitch).toHaveBeenCalledWith("tenant_sales");

    const create = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("新建团队对话"),
    );
    await act(async () => create?.click());
    expect(onNewTeamThread).toHaveBeenCalledOnce();
  });
});

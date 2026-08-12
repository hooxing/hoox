// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalizationDialog, personalizationSize } from "./personalization.js";

describe("个人个性化弹窗", () => {
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

  it("用户加入团队后显示默认开启的团队任务开关并按版本保存", async () => {
    const update = vi.fn(
      async (input: {
        readonly content: string;
        readonly applyToTeamTasks: boolean;
        readonly expectedVersion: number;
      }) => ({
        content: input.content,
        applyToTeamTasks: input.applyToTeamTasks,
        version: 2,
      }),
    );
    await act(async () =>
      root.render(
        <PersonalizationDialog
          api={{
            getPersonalPersonalization: async () => ({
              content: "默认中文",
              applyToTeamTasks: true,
              version: 1,
            }),
            updatePersonalPersonalization: update,
          }}
          hasTeams
          onClose={vi.fn()}
        />,
      ),
    );
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.checked).toBe(true);
    expect(checkbox?.getAttribute("aria-label")).toBe("应用于团队任务");
    expect(container.textContent).toContain("应用于团队任务");
    expect(container.textContent).toContain("已开启");

    await act(async () => checkbox?.click());
    expect(container.textContent).toContain("已关闭");
    const form = container.querySelector("form");
    await act(async () =>
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(update).toHaveBeenCalledWith({
      content: "默认中文",
      applyToTeamTasks: false,
      expectedVersion: 1,
    });
  });

  it("尚未加入团队时隐藏团队开关，但不改变服务端已有值", async () => {
    await act(async () =>
      root.render(
        <PersonalizationDialog
          api={{
            getPersonalPersonalization: async () => ({
              content: "默认中文",
              applyToTeamTasks: false,
              version: 3,
            }),
            updatePersonalPersonalization: vi.fn(),
          }}
          hasTeams={false}
          onClose={vi.fn()}
        />,
      ),
    );
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.textContent).not.toContain("应用于团队任务");
  });

  it("字符计数按 Unicode code point 而不是 UTF-16 单元", () => {
    expect(personalizationSize("✈️")).toEqual({ characters: 2, bytes: 6 });
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillInstallation } from "./api.js";
import { SkillCenterDialog, type SkillCenterApi } from "./skill-center.js";

const catalog = {
  canonicalKey: "code-review",
  displayName: "代码审阅",
  publisher: "Cube",
  description: "按照团队检查清单审阅代码变更",
  recommendedVersion: "1.2.3",
  compatibility: "runtime >= 1",
  securityStatus: "verified" as const,
};
const installed: SkillInstallation = {
  canonicalKey: catalog.canonicalKey,
  displayName: catalog.displayName,
  publisher: catalog.publisher,
  description: catalog.description,
  skillVersion: catalog.recommendedVersion,
  invocationName: "code-review",
  status: "enabled",
  versionToken: 0,
  installedAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
};

describe("技能中心界面", () => {
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

  it("加载用户安装状态并可安装推荐版本", async () => {
    const api: SkillCenterApi = {
      listSkills: vi.fn(async () => ({ items: [catalog] })),
      listInstalledSkills: vi.fn(async () => []),
      installSkill: vi.fn(async () => installed),
      setSkillEnabled: vi.fn(async (value) => value),
      uninstallSkill: vi.fn(async () => undefined),
    };
    await act(async () => {
      root.render(<SkillCenterDialog api={api} onClose={() => undefined} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("代码审阅");
    const installButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "安装",
    );
    expect(installButton).toBeDefined();
    await act(async () => {
      installButton?.click();
      await Promise.resolve();
    });
    expect(api.installSkill).toHaveBeenCalledWith("code-review", "code-review");
    expect(container.textContent).toContain("/code-review · 已启用");
  });

  it("关闭按钮把控制权交还给工作区", async () => {
    const onClose = vi.fn();
    const api: SkillCenterApi = {
      listSkills: vi.fn(async () => ({ items: [] })),
      listInstalledSkills: vi.fn(async () => []),
      installSkill: vi.fn(async () => installed),
      setSkillEnabled: vi.fn(async (value) => value),
      uninstallSkill: vi.fn(async () => undefined),
    };
    await act(async () => {
      root.render(<SkillCenterDialog api={api} onClose={onClose} />);
      await Promise.resolve();
    });
    const close = container.querySelector<HTMLButtonElement>('[aria-label="关闭技能中心"]');
    close?.click();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

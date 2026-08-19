// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.js";
import type { AdminControlApiContract } from "./control-api.js";

const overview = {
  generation: 3,
  statistics: {
    generatedAt: "2026-08-19T00:00:00.000Z",
    runs: { total: 12, queued: 1, running: 2, succeeded24h: 8, failed24h: 1, cancelled24h: 0 },
    dispatch: { pending: 1, claimed: 2 },
    sandboxes: { active: 2, paused: 1, cleanupPending: 0 },
    memory: { pending: 3, failed: 0 },
    automations: { active: 4, failedOccurrences24h: 0 },
    skills: { published: 5, installed: 6 },
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
  ],
};

function fixture(): AdminControlApiContract {
  return {
    overview: vi.fn(async () => overview),
    listModelProviders: vi.fn(async () => []),
    listMemoryProviders: vi.fn(async () => []),
    listRuntimeSettings: vi.fn(async () => []),
    listAudits: vi.fn(async () => []),
    createModelDraft: vi.fn(),
    createMemoryDraft: vi.fn(),
    createRuntimeSettingsDraft: vi.fn(),
    probe: vi.fn(),
    publish: vi.fn(),
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await act(async () => Promise.resolve());
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

describe("统一平台管理导航", () => {
  it("展示五个模块、聚合统计和环境配置状态，但不展示秘密值", async () => {
    const api = fixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App controlApi={api} />));
    await settle();

    const navigation = [...container.querySelectorAll("nav button")].map(
      (item) => item.textContent,
    );
    expect(navigation).toEqual(["总览", "模型", "记忆", "Skills", "配置"]);
    expect(container.textContent).toContain("运行总数12");
    expect(container.textContent).toContain("MODEL_API_KEY");
    expect(container.textContent).toContain("已配置 · secret");
    expect(container.textContent).not.toContain("production-model-secret");

    const models = [...container.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (item) => item.textContent === "模型",
    );
    if (models === undefined) throw new Error("模型导航缺失");
    act(() => models.click());
    await settle();
    expect(api.listModelProviders).toHaveBeenCalledOnce();

    const settings = [...container.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (item) => item.textContent === "配置",
    );
    if (settings === undefined) throw new Error("配置导航缺失");
    act(() => settings.click());
    await settle();
    expect(api.listRuntimeSettings).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("MODEL_API_KEY");

    act(() => root.unmount());
    container.remove();
  });
});

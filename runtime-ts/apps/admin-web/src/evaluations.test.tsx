// @vitest-environment jsdom

import { act } from "react";
import type { EvaluationSuite } from "@hoox/protocol";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { EvaluationsPage } from "./evaluations.js";
import { button, enter, render, settle } from "./testing/admin-component.js";

describe("评测集页面", () => {
  it("按名称选择草稿 Agent，为该草稿建立带确定性断言的评测集", async () => {
    const saveEvaluationSuite = vi.fn(async (_suite: EvaluationSuite) => null);
    const listEvaluationSuites = vi.fn(async () => []);
    const agentApi = {
      listAgentDefinitions: async () => ({
        items: [
          {
            definition: { id: "agent_default", status: "published" },
            revision: { displayName: "默认 Agent" },
          },
          {
            definition: { id: "agent_draft", status: "draft" },
            revision: { displayName: "订单助手" },
          },
        ],
      }),
      listAgentRevisions: async () => ({ items: [] }),
    };
    const api = {
      listEvaluationSuites,
      saveEvaluationSuite,
      listEvaluationRuns: async () => [],
      startEvaluationRun: async () => ({ id: "run_1" }),
      readEvaluationRun: async () => ({ run: { id: "run_1" }, results: [] }),
      cancelEvaluationRun: async () => true,
      compareEvaluationRuns: async () => ({ cases: [] }),
    };
    const page = render(
      <MemoryRouter>
        <EvaluationsPage agents={agentApi as never} api={api as never} />
      </MemoryRouter>,
    );
    await settle();
    const combo = page.querySelector<HTMLInputElement>('[role="combobox"]');
    if (!combo) throw new Error("缺少 Agent 选择器");
    enter(combo, "订单助手");
    await settle();
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent === "订单助手（草稿）",
    );
    expect(option).toBeDefined();
    act(() => option?.click());
    await settle();
    expect(listEvaluationSuites).toHaveBeenCalledExactlyOnceWith("agent_draft");
    expect(page.textContent).toContain("订单助手（草稿）");
    act(() => button(page, "新建评测集").click());
    const name = page.querySelector<HTMLInputElement>('[aria-label="评测集名称"]');
    const input = page.querySelector<HTMLTextAreaElement>('[aria-label="用户输入"]');
    const assertion = page.querySelector<HTMLInputElement>('[aria-label="断言值"]');
    if (!name || !input || !assertion) throw new Error("评测表单字段缺失");
    enter(name, "验收集");
    enter(input, "查询订单");
    enter(assertion, "订单存在");
    act(() => button(page, "保存评测集").click());
    await settle();
    expect(saveEvaluationSuite.mock.calls[0]?.[0].definitionId).toBe("agent_draft");
    expect(saveEvaluationSuite.mock.calls[0]?.[0].cases[0]?.assertions[0]).toEqual({
      kind: "text_contains",
      value: "订单存在",
    });
  });
});

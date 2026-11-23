// @vitest-environment jsdom

import { act } from "react";
import type { EvaluationSuite } from "@hoox/protocol";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { EvaluationsPage } from "./evaluations.js";
import { button, enter, render, settle } from "./testing/admin-component.js";

describe("评测集页面", () => {
  it("通过控件创建用例并编辑确定性断言", async () => {
    const saveEvaluationSuite = vi.fn(async (_suite: EvaluationSuite) => null);
    const agentApi = {
      listAgentDefinitions: async () => ({ items: [{ definition: { id: "agent_1" } }] }),
      listAgentRevisions: async () => ({ items: [] }),
    };
    const api = {
      listEvaluationSuites: async () => [],
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
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        combo,
        "agent_1",
      );
      combo.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    act(() =>
      Array.from(document.querySelectorAll(".ant-select-item-option"))
        .find((item) => item.textContent?.includes("agent_1"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await settle();
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
    expect(saveEvaluationSuite.mock.calls[0]?.[0].cases[0]?.assertions[0]).toEqual({
      kind: "text_contains",
      value: "订单存在",
    });
  });
});

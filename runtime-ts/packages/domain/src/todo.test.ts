import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.js";
import { applyTodoWrite } from "./todo.js";

describe("Todo 执行清单", () => {
  it("首次写入要求全部 pending，并生成单调修订号", () => {
    const created = applyTodoWrite(undefined, {
      todos: [
        { id: "collect_requirements", content: "确认目标", status: "pending" },
        { id: "deliver_result", content: "完成交付", status: "pending" },
      ],
    });
    const started = applyTodoWrite(created, {
      todos: [
        { id: "collect_requirements", content: "确认目标", status: "in_progress" },
        { id: "deliver_result", content: "完成交付", status: "pending" },
      ],
    });

    expect(created.version).toBe(1);
    expect(started.version).toBe(2);
    expect(started.todos[0]?.status).toBe("in_progress");
  });

  it("允许一次完成当前步骤并开始下一步骤", () => {
    const initial = applyTodoWrite(undefined, {
      todos: [
        { id: "first", content: "第一步", status: "pending" },
        { id: "second", content: "第二步", status: "pending" },
      ],
    });
    const active = applyTodoWrite(initial, {
      todos: [
        { id: "first", content: "第一步", status: "in_progress" },
        { id: "second", content: "第二步", status: "pending" },
      ],
    });

    expect(
      applyTodoWrite(active, {
        todos: [
          { id: "first", content: "第一步", status: "completed" },
          { id: "second", content: "第二步", status: "in_progress" },
        ],
      }).todos,
    ).toEqual([
      { id: "first", content: "第一步", status: "completed" },
      { id: "second", content: "第二步", status: "in_progress" },
    ]);
  });

  it("拒绝首次直接执行、多个执行中步骤和改写已完成步骤", () => {
    expect(() =>
      applyTodoWrite(undefined, {
        todos: [{ id: "first", content: "第一步", status: "in_progress" }],
      }),
    ).toThrow(DomainError);

    const initial = applyTodoWrite(undefined, {
      todos: [
        { id: "first", content: "第一步", status: "pending" },
        { id: "second", content: "第二步", status: "pending" },
      ],
    });
    expect(() =>
      applyTodoWrite(initial, {
        todos: [
          { id: "first", content: "第一步", status: "in_progress" },
          { id: "second", content: "第二步", status: "in_progress" },
        ],
      }),
    ).toThrow(DomainError);

    const completed = applyTodoWrite(initial, {
      todos: [
        { id: "first", content: "第一步", status: "completed" },
        { id: "second", content: "第二步", status: "pending" },
      ],
    });
    expect(() =>
      applyTodoWrite(completed, {
        explanation: "重写已经结束的步骤",
        todos: [
          { id: "first", content: "被改写", status: "pending" },
          { id: "second", content: "第二步", status: "pending" },
        ],
      }),
    ).toThrow(DomainError);
  });

  it("结构调整和执行中回退必须说明原因", () => {
    const initial = applyTodoWrite(undefined, {
      todos: [{ id: "first", content: "第一步", status: "pending" }],
    });
    expect(() =>
      applyTodoWrite(initial, {
        todos: [
          { id: "first", content: "第一步", status: "pending" },
          { id: "second", content: "第二步", status: "pending" },
        ],
      }),
    ).toThrow(DomainError);

    expect(
      applyTodoWrite(initial, {
        explanation: "发现还需要补充交付步骤",
        todos: [
          { id: "first", content: "第一步", status: "pending" },
          { id: "second", content: "第二步", status: "pending" },
        ],
      }).todos,
    ).toHaveLength(2);
  });
});

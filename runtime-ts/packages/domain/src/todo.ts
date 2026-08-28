import { domainInvariant } from "./errors.js";

export const TODO_MAX_ITEMS = 20;
export const TODO_ITEM_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
export const TODO_ITEM_CONTENT_MAX_LENGTH = 240;
export const TODO_EXPLANATION_MAX_LENGTH = 1_000;

export type TodoItemStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: TodoItemStatus;
}

export interface TodoWriteCommand {
  readonly explanation?: string;
  readonly todos: readonly TodoItem[];
}

export interface TodoSnapshot {
  readonly schemaVersion: 1;
  readonly version: number;
  readonly todos: readonly TodoItem[];
  readonly explanation?: string;
}

/**
 * Todo 是 Agent 自主维护的 Run 级执行清单，不是工具授权门禁。这里仅保证清单自身
 * 可审计：同时最多一个 in_progress，已完成项不可被重写或删除。
 */
export function applyTodoWrite(
  previous: TodoSnapshot | undefined,
  command: TodoWriteCommand,
): TodoSnapshot {
  const todos = normalizeTodos(command.todos);
  const explanation = normalizeExplanation(command.explanation);

  if (previous === undefined) {
    return freezeSnapshot({
      version: 1,
      todos,
      ...(explanation === undefined ? {} : { explanation }),
    });
  }

  assertPreviousSnapshot(previous);
  const nextById = new Map(todos.map((todo) => [todo.id, todo]));
  for (const existing of previous.todos) {
    const next = nextById.get(existing.id);
    if (existing.status === "completed") {
      domainInvariant(next !== undefined, "INVALID_STATE_TRANSITION", "已完成的 Todo 不能删除");
      domainInvariant(
        next.content === existing.content && next.status === "completed",
        "INVALID_STATE_TRANSITION",
        "已完成的 Todo 不能修改或回退",
      );
    }
  }

  const structureChanged = todoStructureChanged(previous.todos, todos);
  const movedBackToPending = previous.todos.some((existing) => {
    const next = nextById.get(existing.id);
    return existing.status === "in_progress" && next?.status === "pending";
  });
  domainInvariant(
    (!structureChanged && !movedBackToPending) || explanation !== undefined,
    "INVALID_ARGUMENT",
    "调整 Todo 结构或将执行中步骤退回 pending 时必须说明原因",
  );

  return freezeSnapshot({
    version: previous.version + 1,
    todos,
    ...(explanation === undefined ? {} : { explanation }),
  });
}

function normalizeTodos(input: readonly TodoItem[]): readonly TodoItem[] {
  domainInvariant(input.length > 0, "INVALID_ARGUMENT", "Todo 清单不能为空");
  domainInvariant(input.length <= TODO_MAX_ITEMS, "INVALID_ARGUMENT", "Todo 步骤数量超过上限");

  const ids = new Set<string>();
  let inProgressCount = 0;
  const todos = input.map((raw) => {
    const id = raw.id.trim();
    const content = raw.content.trim();
    domainInvariant(TODO_ITEM_ID_PATTERN.test(id), "INVALID_ARGUMENT", "Todo ID 格式无效");
    domainInvariant(!ids.has(id), "INVALID_ARGUMENT", "Todo ID 不能重复");
    ids.add(id);
    domainInvariant(content.length > 0, "INVALID_ARGUMENT", "Todo 内容不能为空");
    domainInvariant(
      content.length <= TODO_ITEM_CONTENT_MAX_LENGTH,
      "INVALID_ARGUMENT",
      "Todo 内容超过长度上限",
    );
    domainInvariant(
      raw.status === "pending" || raw.status === "in_progress" || raw.status === "completed",
      "INVALID_ARGUMENT",
      "Todo 状态无效",
    );
    if (raw.status === "in_progress") inProgressCount += 1;
    return Object.freeze({ id, content, status: raw.status });
  });
  domainInvariant(inProgressCount <= 1, "INVALID_STATE_TRANSITION", "同时只能有一个执行中步骤");
  return Object.freeze(todos);
}

function normalizeExplanation(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const explanation = value.trim();
  domainInvariant(explanation.length > 0, "INVALID_ARGUMENT", "Todo 调整说明不能为空");
  domainInvariant(
    explanation.length <= TODO_EXPLANATION_MAX_LENGTH,
    "INVALID_ARGUMENT",
    "Todo 调整说明超过长度上限",
  );
  return explanation;
}

function todoStructureChanged(previous: readonly TodoItem[], next: readonly TodoItem[]): boolean {
  if (previous.length !== next.length) return true;
  return previous.some((item, index) => {
    const candidate = next[index];
    return (
      candidate === undefined || candidate.id !== item.id || candidate.content !== item.content
    );
  });
}

function assertPreviousSnapshot(snapshot: TodoSnapshot): void {
  domainInvariant(snapshot.schemaVersion === 1, "INVALID_ARGUMENT", "Todo Snapshot 版本无效");
  domainInvariant(
    Number.isSafeInteger(snapshot.version) && snapshot.version > 0,
    "INVALID_ARGUMENT",
    "Todo Snapshot 修订号无效",
  );
  normalizeTodos(snapshot.todos);
}

function freezeSnapshot(input: {
  readonly version: number;
  readonly todos: readonly TodoItem[];
  readonly explanation?: string;
}): TodoSnapshot {
  return Object.freeze({
    schemaVersion: 1 as const,
    version: input.version,
    todos: Object.freeze([...input.todos]),
    ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
  });
}

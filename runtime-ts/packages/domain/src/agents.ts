import { sealEntity, type Entity } from "./entity.js";
import { assertSameTenant, domainInvariant } from "./errors.js";
import type { Run } from "./execution.js";
import {
  agentThreadId,
  isoTimestamp,
  runId,
  tenantId,
  type AgentThreadId,
  type IsoTimestamp,
  type RunId,
  type TenantId,
} from "./ids.js";
import {
  arrayValue,
  enumValue,
  optionalStringValue,
  recordValue,
  stringValue,
} from "./validation.js";

export type AgentThreadKind = "root" | "subagent";
export type AgentThreadStatus = "active" | "waiting" | "completed" | "failed" | "cancelled";
interface AgentThreadData {
  readonly id: AgentThreadId;
  readonly tenantId: TenantId;
  readonly runId: RunId;
  readonly kind: AgentThreadKind;
  readonly parentId?: AgentThreadId;
  readonly status: AgentThreadStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
export type AgentThread = Entity<"AgentThread", AgentThreadData>;

interface AgentTreeData {
  readonly runId: RunId;
  readonly tenantId: TenantId;
  readonly rootId: AgentThreadId;
  readonly agents: readonly AgentThread[];
}
export type AgentTree = Entity<"AgentTree", AgentTreeData>;

export function createAgentTree(input: {
  readonly run: Run;
  readonly rootId: AgentThreadId;
  readonly now: IsoTimestamp;
}): AgentTree {
  domainInvariant(
    input.run.status === "running",
    "INVALID_STATE_TRANSITION",
    "只有运行中的 Run 可以创建 Agent Tree",
  );
  const root = sealEntity("AgentThread", {
    id: input.rootId,
    tenantId: input.run.tenantId,
    runId: input.run.id,
    kind: "root" as const,
    status: "active" as const,
    createdAt: input.now,
    updatedAt: input.now,
  });
  return sealEntity("AgentTree", {
    runId: input.run.id,
    tenantId: input.run.tenantId,
    rootId: root.id,
    agents: Object.freeze([root]),
  });
}

export function spawnAgentThread(input: {
  readonly tree: AgentTree;
  readonly parentId: AgentThreadId;
  readonly id: AgentThreadId;
  readonly now: IsoTimestamp;
}): AgentTree {
  domainInvariant(
    !input.tree.agents.some((agent) => agent.id === input.id),
    "INVALID_ARGUMENT",
    "Agent Thread ID 已存在",
  );
  const parent = input.tree.agents.find((agent) => agent.id === input.parentId);
  domainInvariant(parent !== undefined, "INVALID_ARGUMENT", "父 Agent Thread 不存在");
  domainInvariant(
    parent.status === "active",
    "INVALID_STATE_TRANSITION",
    "只有活跃 Agent Thread 可以创建子 Agent",
  );
  const agent = sealEntity("AgentThread", {
    id: input.id,
    tenantId: input.tree.tenantId,
    runId: input.tree.runId,
    kind: "subagent" as const,
    parentId: parent.id,
    status: "active" as const,
    createdAt: input.now,
    updatedAt: input.now,
  });
  return sealEntity("AgentTree", {
    ...input.tree,
    agents: Object.freeze([...input.tree.agents, agent]),
  });
}

function isDescendant(tree: AgentTree, candidate: AgentThread, ancestorId: AgentThreadId): boolean {
  let parentId = candidate.parentId;
  const visited = new Set<AgentThreadId>();
  while (parentId !== undefined) {
    if (parentId === ancestorId) return true;
    domainInvariant(!visited.has(parentId), "INVALID_ARGUMENT", "Agent Tree 存在父级环");
    visited.add(parentId);
    parentId = tree.agents.find((agent) => agent.id === parentId)?.parentId;
  }
  return false;
}

function assertNoActiveDescendants(tree: AgentTree, agentId: AgentThreadId): void {
  const unfinished = tree.agents.some(
    (candidate) =>
      (candidate.status === "active" || candidate.status === "waiting") &&
      isDescendant(tree, candidate, agentId),
  );
  // 采用等待策略而非隐式级联：调用者必须显式结束后代，每个后代都产生可审计事件。
  domainInvariant(!unfinished, "INVALID_STATE_TRANSITION", "仍有未结束的后代 Agent");
}

export function transitionAgentThread(input: {
  readonly tree: AgentTree;
  readonly id: AgentThreadId;
  readonly target: AgentThreadStatus;
  readonly now: IsoTimestamp;
}): AgentTree {
  const current = input.tree.agents.find((agent) => agent.id === input.id);
  domainInvariant(current !== undefined, "INVALID_ARGUMENT", "Agent Thread 不存在");
  const transitions: Readonly<Record<AgentThreadStatus, readonly AgentThreadStatus[]>> = {
    active: ["waiting", "completed", "failed", "cancelled"],
    waiting: ["active", "failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
  };
  domainInvariant(
    transitions[current.status].includes(input.target),
    "INVALID_STATE_TRANSITION",
    "Agent Thread 状态转换不被允许",
  );
  if (input.target === "completed" || input.target === "failed" || input.target === "cancelled") {
    assertNoActiveDescendants(input.tree, current.id);
  }
  const agents = input.tree.agents.map((agent) =>
    agent.id === current.id
      ? sealEntity("AgentThread", { ...agent, status: input.target, updatedAt: input.now })
      : agent,
  );
  return sealEntity("AgentTree", { ...input.tree, agents: Object.freeze(agents) });
}

export function rehydrateAgentTree(snapshot: unknown, run: Run): AgentTree {
  const raw = recordValue(snapshot, "AgentTree");
  const restoredTenantId = tenantId(stringValue(raw, "tenantId"));
  assertSameTenant(restoredTenantId, run.tenantId);
  const restoredRunId = runId(stringValue(raw, "runId"));
  domainInvariant(restoredRunId === run.id, "OWNERSHIP_MISMATCH", "Agent Tree 运行关联无效");
  const agents = arrayValue(raw, "agents").map((value) => {
    const agent = recordValue(value, "AgentThread");
    const agentTenantId = tenantId(stringValue(agent, "tenantId"));
    assertSameTenant(agentTenantId, restoredTenantId);
    const agentRunId = runId(stringValue(agent, "runId"));
    domainInvariant(
      agentRunId === restoredRunId,
      "OWNERSHIP_MISMATCH",
      "Agent Thread 运行关联无效",
    );
    const parent = optionalStringValue(agent, "parentId");
    return sealEntity("AgentThread", {
      id: agentThreadId(stringValue(agent, "id")),
      tenantId: agentTenantId,
      runId: agentRunId,
      kind: enumValue(agent, "kind", ["root", "subagent"] as const),
      ...(parent === undefined ? {} : { parentId: agentThreadId(parent) }),
      status: enumValue(agent, "status", [
        "active",
        "waiting",
        "completed",
        "failed",
        "cancelled",
      ] as const),
      createdAt: isoTimestamp(stringValue(agent, "createdAt")),
      updatedAt: isoTimestamp(stringValue(agent, "updatedAt")),
    });
  });
  const rootId = agentThreadId(stringValue(raw, "rootId"));
  domainInvariant(
    agents.length > 0 && new Set(agents.map((agent) => agent.id)).size === agents.length,
    "INVALID_ARGUMENT",
    "Agent Tree 节点无效",
  );
  domainInvariant(
    agents.filter((agent) => agent.kind === "root").length === 1 &&
      agents.some(
        (agent) => agent.id === rootId && agent.kind === "root" && agent.parentId === undefined,
      ),
    "INVALID_ARGUMENT",
    "Agent Tree 根节点无效",
  );
  const tree = sealEntity("AgentTree", {
    runId: restoredRunId,
    tenantId: restoredTenantId,
    rootId,
    agents: Object.freeze(agents),
  });
  for (const agent of agents) {
    if (agent.kind === "subagent") {
      domainInvariant(
        agent.parentId !== undefined && agents.some((candidate) => candidate.id === agent.parentId),
        "INVALID_ARGUMENT",
        "Agent Thread 父节点无效",
      );
      isDescendant(tree, agent, rootId);
    }
    if (agent.status === "completed" || agent.status === "failed" || agent.status === "cancelled") {
      assertNoActiveDescendants(tree, agent.id);
    }
  }
  if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
    domainInvariant(
      agents.every(
        (agent) =>
          agent.status === "completed" || agent.status === "failed" || agent.status === "cancelled",
      ),
      "INVALID_ARGUMENT",
      "终态 Run 不能恢复未结束的 Agent Tree",
    );
  }
  return tree;
}

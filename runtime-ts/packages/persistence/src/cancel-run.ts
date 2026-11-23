import { transitionRun, type IsoTimestamp, type Run } from "@hoox/domain";
import type { RunRepository, TenantScope } from "./ports.js";

export async function cancelScopedRun(
  repository: Pick<RunRepository, "get" | "update">,
  scope: TenantScope,
  threadId: Run["threadId"],
  runId: Run["id"],
  now: () => IsoTimestamp,
): Promise<Run | "not_found" | "conflict"> {
  const current = await repository.get(scope, runId);
  if (!current || current.entity.threadId !== threadId) return "not_found";
  if (current.entity.status === "cancelled") return current.entity;
  const cancelled = transitionRun(current.entity, "cancelled", now());
  const result = await repository.update(scope, cancelled, current.version);
  if (result.outcome === "conflict") {
    const latest = await repository.get(scope, runId);
    if (latest?.entity.status === "cancelled") return latest.entity;
  }
  return result.outcome === "updated" ? cancelled : result.outcome;
}

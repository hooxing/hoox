import { normalizeRuntimeToolSelection, RUNTIME_TOOL_NAMES } from "@hoox/protocol";
import type { ControlOperatorRole } from "./index.js";
export { agentRevisionChangedSections } from "@hoox/protocol";

export function agentDefinitionAccess(role: ControlOperatorRole | undefined) {
  if (role === undefined) return undefined;
  return { canManage: role === "operator" || role === "admin" };
}

export function agentBuiltinToolLimit(enabledTools: unknown): readonly string[] {
  return normalizeRuntimeToolSelection(enabledTools) ?? RUNTIME_TOOL_NAMES;
}

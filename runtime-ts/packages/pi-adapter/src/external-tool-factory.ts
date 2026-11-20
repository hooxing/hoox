import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExternalToolRuntimeSnapshot } from "@hoox/run-contracts";
import { createExternalToolAgentTool, type ExternalToolExecutionPorts } from "@hoox/tool-router";

/** 按已固定快照生成稳定能力数组；此工厂不负责把能力注册进 Pi Session。 */
export function createExternalToolFactory(
  ports: ExternalToolExecutionPorts,
): (snapshots: readonly ExternalToolRuntimeSnapshot[]) => readonly AgentTool[] {
  return (snapshots) => {
    const ordered = [...snapshots].sort((a, b) =>
      a.tool.modelToolName < b.tool.modelToolName
        ? -1
        : a.tool.modelToolName > b.tool.modelToolName
          ? 1
          : 0,
    );
    if (new Set(ordered.map((item) => item.tool.modelToolName)).size !== ordered.length)
      throw new TypeError("EXTERNAL_TOOL_NAME_DUPLICATE");
    if (ordered.length > 64) throw new TypeError("EXTERNAL_TOOL_CAPACITY_EXCEEDED");
    return Object.freeze(
      ordered.map((snapshot) =>
        createExternalToolAgentTool(snapshot.tool, ports, snapshot.credential),
      ),
    );
  };
}

import { DEFAULT_AGENT_OPERATOR_INSTRUCTIONS } from "@hoox/pi-adapter";
import { digestAgentRevisionContent, type RunAgentSnapshot } from "@hoox/run-contracts";

export function fakeAgentSnapshot(
  content: Partial<RunAgentSnapshot["content"]> = {},
): RunAgentSnapshot {
  const revisionContent: RunAgentSnapshot["content"] = {
    displayName: "测试 Agent",
    description: "测试配置",
    suggestedQuestions: [],
    operatorInstructions: DEFAULT_AGENT_OPERATOR_INSTRUCTIONS,
    replyLanguage: "zh-CN",
    model: { mode: "platform_default" },
    tools: { mode: "platform_default" },
    skillVersions: [],
    includeTenantSkills: true,
    sandboxIdleAction: "pause",
    memory: { mode: "configured", longTermEnabled: true },
    ...content,
  };
  return {
    definitionId: "agent_test",
    revisionId: "agent_test_revision_1",
    revisionDigest: digestAgentRevisionContent(revisionContent),
    content: revisionContent,
  };
}

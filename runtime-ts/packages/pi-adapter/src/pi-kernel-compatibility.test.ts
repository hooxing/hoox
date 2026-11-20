import {
  buildRuntimeSystemPrompt,
  DEFAULT_AGENT_OPERATOR_INSTRUCTIONS,
} from "@hoox/prompt-builder";
import { FakeSandboxHandle } from "@hoox/sandbox/testing";
import {
  type Context,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  type StreamOptions,
  type SimpleStreamOptions,
  type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  bindTrustedPiModelContextCapability,
  createSafePiSession,
  digestCanonicalToolInputSchema,
} from "./pi-session.js";

const untrusted = {
  tenant: [{ id: "tenant-private-id", content: "租户参考资料" }],
  skill: [],
  user: [{ id: "user-private-id", content: "低信任用户资料" }],
};

interface CapturedRequest {
  context: Context;
  options: {
    sessionId: StreamOptions["sessionId"];
    timeoutMs: StreamOptions["timeoutMs"];
    maxRetryDelayMs: StreamOptions["maxRetryDelayMs"];
    maxRetries: StreamOptions["maxRetries"];
    reasoning: SimpleStreamOptions["reasoning"];
  };
}

async function sessionFixture(
  withTool: boolean,
  thinkingLevelMap?: Model<string>["thinkingLevelMap"],
) {
  const calls: CapturedRequest[] = [];
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  const responses = [
    ...(withTool
      ? [
          fauxAssistantMessage(
            fauxToolCall("exec_command", { cmd: "echo fixture" }, { id: "fixture-call" }),
            { stopReason: "toolUse" },
          ),
        ]
      : []),
    fauxAssistantMessage("第一轮完成"),
    fauxAssistantMessage("第二轮完成"),
  ];
  faux.setResponses(
    responses.map((response) => (context, options) => {
      calls.push({
        context: JSON.parse(JSON.stringify(context)) as Context,
        options: {
          sessionId: options?.sessionId,
          timeoutMs: options?.timeoutMs,
          maxRetryDelayMs: options?.maxRetryDelayMs,
          maxRetries: options?.maxRetries,
          reasoning: (options as SimpleStreamOptions | undefined)?.reasoning,
        },
      });
      return response;
    }),
  );
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(faux.provider.id, async () => ({
    type: "api_key",
    key: "test-only-key",
  }));
  const modelRuntime = createModels({ credentials });
  modelRuntime.setProvider(faux.provider);
  const model = faux.getModel();
  if (thinkingLevelMap !== undefined) {
    model.reasoning = true;
    model.thinkingLevelMap = thinkingLevelMap;
  }
  const controller = await createSafePiSession({
    model,
    operatorInstructions: DEFAULT_AGENT_OPERATOR_INSTRUCTIONS,
    modelRuntime,
    modelContext: bindTrustedPiModelContextCapability(modelRuntime, model),
    sandbox: new FakeSandboxHandle("pi-kernel-contract"),
    enabledToolNames: ["exec_command"],
    untrustedPromptContent: untrusted,
    authorizeToolEffect: async () => ({
      consumedAtMonotonicMs: performance.now(),
      maxContinuationDelayMs: 250,
    }),
    createToolObservationRecorder: (outputs) => ({
      record: async (call) => {
        const observation = await outputs.readControlledReceipt(call);
        return observation === undefined
          ? { outcome: "conflict" as const }
          : { outcome: "recorded" as const, observation, isTruncated: false };
      },
    }),
  });
  return { controller, calls };
}

describe("Pi 内核替换的 Provider 可见契约", () => {
  it("可信 Prompt 保留固定目录后缀、工具 schema 和低信任 user 角色", async () => {
    const fixture = await sessionFixture(true);
    try {
      await fixture.controller.prompt("执行测试命令");
      expect(fixture.calls).toHaveLength(2);
      const first = fixture.calls[0];
      if (!first) throw new Error("Provider 未收到请求");
      expect(first.context.tools).toHaveLength(1);
      expect(first.context.tools?.[0]).toMatchObject({
        name: "exec_command",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      });
      const built = buildRuntimeSystemPrompt({
        schemaVersion: 1,
        operatorInstructions: DEFAULT_AGENT_OPERATOR_INSTRUCTIONS,
        capabilities: (first.context.tools ?? []).map((tool) => ({
          id: tool.name,
          description: tool.description,
          inputSchemaDigest: digestCanonicalToolInputSchema(tool.parameters),
        })),
        availableSkills: [],
        untrusted,
      });
      for (const call of fixture.calls) {
        expect(call.context.systemPrompt).toBe(
          `${built.systemPrompt}\nCurrent working directory: /workspace`,
        );
        expect(call.context.tools).toEqual(first.context.tools);
        expect(call.context.systemPrompt).not.toContain("租户参考资料");
        expect(call.context.systemPrompt).not.toContain("低信任用户资料");
      }
      for (const entry of built.contextEntries) {
        const matching = first.context.messages.filter((message) =>
          JSON.stringify(message).includes(JSON.stringify(entry.content).slice(1, -1)),
        );
        expect(matching.map((message) => message.role)).toEqual(["user"]);
      }
      expect(first.context.messages.at(-1)).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "执行测试命令" }],
      });
      expect(fixture.calls[1]?.context.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "toolResult",
            toolCallId: "fixture-call",
            isError: false,
          }),
        ]),
      );
    } finally {
      fixture.controller.dispose();
    }
  });

  it("默认 high 超出模型能力时沿用既有裁剪规则", async () => {
    const fixture = await sessionFixture(false, { high: null, xhigh: null, max: null });
    try {
      await fixture.controller.prompt("使用支持的思考级别");
      expect(fixture.calls[0]?.options.reasoning).toBe("medium");
    } finally {
      fixture.controller.dispose();
    }
  });

  it("首轮、工具续轮和后续 prompt 保留传输默认值与各 Session 独立的稳定 ID", async () => {
    const first = await sessionFixture(true);
    const second = await sessionFixture(false);
    try {
      await first.controller.prompt("执行第一轮");
      await first.controller.prompt("继续第二轮");
      await second.controller.prompt("另一个 Session");
      expect(first.calls).toHaveLength(3);
      expect(second.calls).toHaveLength(1);
      const firstId = first.calls[0]?.options.sessionId;
      const secondId = second.calls[0]?.options.sessionId;
      expect(firstId).toEqual(expect.any(String));
      expect(firstId?.length).toBeGreaterThan(0);
      expect(secondId).toEqual(expect.any(String));
      expect(secondId?.length).toBeGreaterThan(0);
      expect(firstId).not.toBe(secondId);
      for (const call of [...first.calls, ...second.calls]) {
        expect(call.options).toMatchObject({ timeoutMs: 300_000, maxRetryDelayMs: 60_000 });
        expect(call.options.maxRetries).toBeUndefined();
        expect(call.context.systemPrompt).not.toContain(call.options.sessionId);
      }
      expect(first.calls.map((call) => call.options.sessionId)).toEqual([
        firstId,
        firstId,
        firstId,
      ]);
      expect(second.calls[0]?.context.systemPrompt).toBe(first.calls[0]?.context.systemPrompt);
    } finally {
      first.controller.dispose();
      second.controller.dispose();
    }
  });
});

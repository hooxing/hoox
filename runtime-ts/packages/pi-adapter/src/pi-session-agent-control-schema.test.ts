import { DEFAULT_AGENT_OPERATOR_INSTRUCTIONS } from "@hoox/prompt-builder";
import { FakeSandboxHandle } from "@hoox/sandbox/testing";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { bindTrustedPiModelContextCapability, createSafePiSession } from "./pi-session.js";

it("真实 Pi 循环只发送公开 schema，合法与非法协作调用均形成对应回执", async () => {
  const wait = vi.fn(async () => ({ updates: [], nextAfterSequence: 0, timedOut: true }));
  const list = vi.fn(async () => []);
  const receipts: string[] = [];
  const schemas: string[] = [];
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  faux.setResponses([
    (context) => {
      schemas.push(JSON.stringify(context.tools));
      expect(context.tools?.find((tool) => tool.name === "wait_agent")?.parameters).toMatchObject({
        properties: { after_sequence: { type: "integer" }, timeout_ms: { type: "integer" } },
        additionalProperties: false,
      });
      expect(context.tools?.find((tool) => tool.name === "list_agents")?.parameters).toMatchObject({
        properties: {},
        additionalProperties: false,
      });
      return fauxAssistantMessage(
        [
          fauxToolCall("wait_agent", { timeout_ms: 1 }),
          fauxToolCall("wait_agent", { after_sequence: 0, timeout_ms: 1 }),
          fauxToolCall("list_agents", {}),
          fauxToolCall("list_agents", { unexpected: true }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      schemas.push(JSON.stringify(context.tools));
      expect(
        context.messages
          .filter((message) => message.role === "toolResult")
          .map((message) => message.isError),
      ).toEqual([true, false, false, true]);
      return fauxAssistantMessage("完成");
    },
  ]);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(faux.provider.id, async () => ({
    type: "api_key",
    key: "test-only-key",
  }));
  const modelRuntime = createModels({ credentials });
  modelRuntime.setProvider(faux.provider);
  const model = faux.getModel();
  const controller = await createSafePiSession({
    model,
    operatorInstructions: DEFAULT_AGENT_OPERATOR_INSTRUCTIONS,
    modelRuntime,
    modelContext: bindTrustedPiModelContextCapability(modelRuntime, model),
    sandbox: new FakeSandboxHandle("schema-test"),
    authorizeToolEffect: async () => {
      throw new Error("协作工具不得申请 Sandbox 副作用许可");
    },
    createToolObservationRecorder: (outputs) => ({
      record: async (input) => {
        const observation = await outputs.readControlledReceipt(input);
        if (observation === undefined) return { outcome: "conflict" as const };
        receipts.push(observation);
        return { outcome: "recorded" as const, observation, isTruncated: false };
      },
    }),
    agentControlToolExecutor: {
      spawn: async () => ({}),
      sendMessage: async () => undefined,
      followUp: async () => ({}),
      interrupt: async () => ({}),
      wait,
      list,
      projectError: () => ({
        status: "failed",
        code: "AGENT_CONTROL_FAILED",
        message: "参数无效",
        correctable: true,
        fatal: false,
      }),
    },
  });
  try {
    await controller.prompt("检查协作工具");
    expect(schemas).toHaveLength(2);
    expect(schemas[0]).toBe(schemas[1]);
    expect(schemas[0]).not.toContain("runtime_invalid_arguments_token");
    expect(wait).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(receipts).toHaveLength(4);
  } finally {
    controller.dispose();
  }
});

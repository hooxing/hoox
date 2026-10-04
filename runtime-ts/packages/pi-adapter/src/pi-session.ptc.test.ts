import {
  createModels,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { FakeSandboxHandle } from "@hoox/sandbox/testing";
import { describe, expect, it } from "vitest";
import type { RuntimeAgentEvent } from "./events.js";
import {
  bindTrustedPiModelContextCapability,
  createSafePiSession,
  deriveSafePiSessionCompatibility,
} from "./pi-session.js";

async function harness(mode: "native" | "ptc", responses: FauxResponseStep[]) {
  const faux = fauxProvider({
    api: `ptc-session-${Math.random()}`,
    provider: `ptc-session-${Math.random()}`,
    tokensPerSecond: 10_000,
  });
  faux.setResponses(responses);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(faux.provider.id, async () => ({
    type: "api_key",
    key: "test-only-key",
  }));
  const modelRuntime = createModels({ credentials });
  modelRuntime.setProvider(faux.provider);
  const model = faux.getModel();
  const facts: string[] = [];
  const sandbox = new FakeSandboxHandle("ptc-session");
  sandbox.command = async () => {
    facts.push("effect");
    return { stdout: "private-middle-data", stderr: "", exitCode: 0 };
  };
  const options: Parameters<typeof createSafePiSession>[0] = {
    model,
    modelRuntime,
    modelContext: bindTrustedPiModelContextCapability(modelRuntime, model),
    sandbox,
    toolCallingMode: mode,
    preparePtcProgram: async (id) => {
      facts.push(`parent:${id}`);
    },
    preparePtcTool: async (call) => {
      facts.push(`child:${call.callId}`);
    },
    authorizeToolEffect: async () => {
      facts.push("authorize");
      return { consumedAtMonotonicMs: performance.now(), maxContinuationDelayMs: 250 };
    },
    createToolObservationRecorder: (outputs) => ({
      record: async (call) => {
        facts.push(`receipt:${call.toolName}`);
        const observation = await outputs.readControlledReceipt(call);
        return observation === undefined
          ? { outcome: "conflict" }
          : { outcome: "recorded", observation, isTruncated: false };
      },
    }),
  };
  const controller = await createSafePiSession(options);
  const events: RuntimeAgentEvent[] = [];
  controller.subscribe((event) => {
    events.push(event);
    if (event.type === "tool.started") facts.push(`started:${event.name}`);
  });
  return { controller, facts, events, options };
}

describe("PTC 模型协议与上下文", () => {
  it("仅公开 run_code；内部调用走真实授权且中间数据不自动进入模型历史", async () => {
    let visible = "";
    const h = await harness("ptc", [
      (context) => {
        expect(context.tools?.map((tool) => tool.name)).toEqual(["run_code"]);
        return fauxAssistantMessage(
          fauxToolCall("run_code", {
            code: 'const r=await tools.exec_command({cmd:"echo test"}); return {ok:r.details.exit_code===0};',
          }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        visible = JSON.stringify(context.messages);
        return fauxAssistantMessage("完成");
      },
    ]);
    try {
      await h.controller.prompt("测试");
      expect(visible).toContain("ok");
      expect(visible).not.toContain("private-middle-data");
      expect(h.controller.getDiagnostics().activeToolNames).toEqual(["run_code"]);
      expect(h.facts.indexOf("started:exec_command")).toBeLessThan(
        h.facts.findIndex((x) => x.startsWith("child:")),
      );
      expect(h.facts.findIndex((x) => x.startsWith("child:"))).toBeLessThan(
        h.facts.indexOf("authorize"),
      );
      expect(h.facts.indexOf("authorize")).toBeLessThan(h.facts.indexOf("effect"));
      expect(h.facts.indexOf("receipt:exec_command")).toBeLessThan(
        h.facts.indexOf("receipt:run_code"),
      );
      expect(
        h.events.some(
          (e) =>
            e.type === "tool.started" && e.name === "exec_command" && e.parentCallId !== undefined,
        ),
      ).toBe(true);
    } finally {
      h.controller.dispose();
    }
  });
  it("native 保持原工具清单，能力兼容标识按模式分离且稳定", async () => {
    const native = await harness("native", [fauxAssistantMessage("正常")]);
    const ptc = await harness("ptc", [fauxAssistantMessage("PTC")]);
    try {
      expect(native.controller.getDiagnostics().activeToolNames).toContain("exec_command");
      expect(native.controller.getDiagnostics().activeToolNames).not.toContain("run_code");
      const a = deriveSafePiSessionCompatibility(native.options);
      const b = deriveSafePiSessionCompatibility(ptc.options);
      expect(a).not.toEqual(b);
      expect(b).toEqual(deriveSafePiSessionCompatibility(ptc.options));
    } finally {
      native.controller.dispose();
      ptc.controller.dispose();
    }
  });
  it("缺少内部开始审计回调拒绝创建，不静默退回 native", async () => {
    const h = await harness("native", []);
    try {
      const { preparePtcTool: _unused, ...options } = h.options;
      await expect(createSafePiSession({ ...options, toolCallingMode: "ptc" })).rejects.toThrow(
        "审计",
      );
    } finally {
      h.controller.dispose();
    }
  });
});

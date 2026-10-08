import { RUNTIME_TOOL_NAMES } from "@hoox/protocol";
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

async function harness(
  mode: "native" | "ptc",
  responses: FauxResponseStep[],
  selection: Partial<Parameters<typeof createSafePiSession>[0]> = {},
) {
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
    ...selection,
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

describe("平台工具选择与执行边界", () => {
  it.each(RUNTIME_TOOL_NAMES)("工具目录 %s 与普通定义及 PTC SDK 一致", async (name) => {
    const unexpectedCall = async (): Promise<never> => {
      throw new Error("目录测试不应执行工具");
    };
    const projectError = (): never => {
      throw new Error("目录测试不应投影执行错误");
    };
    for (const mode of ["native", "ptc"] as const) {
      const h = await harness(
        mode,
        [
          (context) => {
            if (mode === "native") {
              expect(
                context.tools
                  ?.map((tool) => tool.name)
                  .filter((tool) => tool !== "collapse_process_for_final_answer"),
              ).toEqual([name]);
            } else {
              const definitions = JSON.stringify(context.tools);
              for (const tool of RUNTIME_TOOL_NAMES) {
                const schemaName = `\\"name\\":\\"${tool}\\"`;
                if (tool === name) expect(definitions).toContain(schemaName);
                else expect(definitions).not.toContain(schemaName);
              }
            }
            return fauxAssistantMessage("目录检查完成");
          },
        ],
        {
          enabledTools: [name],
          todoWriteToolExecutor: { write: unexpectedCall, projectError },
          deliverFileToolRouter: { deliverFile: unexpectedCall, projectError },
          automationUpdateToolExecutor: { apply: unexpectedCall, projectError },
          agentControlToolExecutor: {
            spawn: unexpectedCall,
            sendMessage: unexpectedCall,
            followUp: unexpectedCall,
            interrupt: unexpectedCall,
            list: unexpectedCall,
            wait: unexpectedCall,
            projectError,
          },
        },
      );
      try {
        await h.controller.prompt("验证工具目录");
      } finally {
        h.controller.dispose();
      }
    }
  });
  it.each(["native", "ptc"] as const)("%s 不曝光关闭的工具且不能强行调用命令", async (mode) => {
    let result = "";
    const h = await harness(
      mode,
      [
        (context) => {
          if (mode === "native")
            expect(context.tools?.map((t) => t.name)).toEqual([
              "read",
              "collapse_process_for_final_answer",
            ]);
          else {
            const definitions = JSON.stringify(context.tools);
            expect(definitions).toContain('\\"name\\":\\"read\\"');
            expect(definitions).not.toContain('\\"name\\":\\"exec_command\\"');
          }
          return fauxAssistantMessage(
            mode === "ptc"
              ? fauxToolCall("run_code", {
                  code: 'return await tools.exec_command({cmd:"echo forbidden"});',
                })
              : fauxToolCall("exec_command", { cmd: "echo forbidden" }),
            { stopReason: "toolUse" },
          );
        },
        (context) => {
          result = JSON.stringify(context.messages);
          return fauxAssistantMessage("完成");
        },
      ],
      { enabledTools: ["read"] },
    );
    try {
      await h.controller.prompt("尝试关闭的工具");
      expect(h.facts).not.toContain("effect");
      expect(h.facts).not.toContain("authorize");
      expect(
        h.events.some(
          (e) =>
            e.type === "tool.started" && e.name === "exec_command" && e.parentCallId !== undefined,
        ),
      ).toBe(false);
      expect(result).toContain('"isError":true');
    } finally {
      h.controller.dispose();
    }
  });
  it.each(["native", "ptc"] as const)("%s 显式空选择不授予任何业务工具", async (mode) => {
    const h = await harness(mode, [fauxAssistantMessage("完成")], { enabledTools: [] });
    try {
      expect(h.controller.getDiagnostics().activeToolNames).toEqual(
        mode === "native" ? ["collapse_process_for_final_answer"] : ["run_code"],
      );
      expect(h.facts).not.toContain("effect");
    } finally {
      h.controller.dispose();
    }
  });
  it.each(["native", "ptc"] as const)(
    "%s 委派不能恢复平台关闭能力，能力身份随真实交集改变",
    async (mode) => {
      const h = await harness(mode, [fauxAssistantMessage("完成")], {
        enabledTools: ["read"],
        enabledToolNames: ["exec_command", "read"],
      });
      try {
        expect(h.controller.getDiagnostics().activeToolNames).toEqual(
          mode === "native" ? ["read"] : ["run_code"],
        );
        expect(deriveSafePiSessionCompatibility(h.options)).toEqual(
          deriveSafePiSessionCompatibility({ ...h.options, enabledToolNames: ["read"] }),
        );
        expect(deriveSafePiSessionCompatibility(h.options)).not.toEqual(
          deriveSafePiSessionCompatibility({ ...h.options, enabledTools: [] }),
        );
      } finally {
        h.controller.dispose();
      }
    },
  );
  it("选择顺序不改变提示词、Schema 与恢复兼容身份", async () => {
    const h = await harness("ptc", [fauxAssistantMessage("完成")], {
      enabledTools: ["read", "exec_command"],
    });
    try {
      expect(deriveSafePiSessionCompatibility(h.options)).toEqual(
        deriveSafePiSessionCompatibility({ ...h.options, enabledTools: ["exec_command", "read"] }),
      );
    } finally {
      h.controller.dispose();
    }
  });
});

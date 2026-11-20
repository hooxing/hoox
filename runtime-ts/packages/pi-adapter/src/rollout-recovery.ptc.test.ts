import { DEFAULT_AGENT_OPERATOR_INSTRUCTIONS } from "@hoox/prompt-builder";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import type { RolloutCompatibilityIdentity } from "@hoox/domain";
import { FakeSandboxHandle } from "@hoox/sandbox/testing";
import { describe, expect, it, vi } from "vitest";
import {
  bindTrustedPiModelContextCapability,
  type CreateSafePiSessionOptions,
  deriveSafePiSessionCompatibility,
  ModelContinuationRejectedError,
} from "./pi-session.js";
import { recoverSafePiSession } from "./rollout-recovery.js";

type SessionOptions = Omit<CreateSafePiSessionOptions, "rolloutProjection">;

async function harness() {
  const faux = fauxProvider({
    api: `ptc-recovery-${Math.random()}`,
    provider: `ptc-recovery-${Math.random()}`,
    tokensPerSecond: 10_000,
  });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(faux.provider.id, async () => ({
    type: "api_key",
    key: "test-only-key",
  }));
  const modelRuntime = createModels({ credentials });
  modelRuntime.setProvider(faux.provider);
  const model = faux.getModel();
  const sandbox = new FakeSandboxHandle("ptc-recovery");
  const command = vi.fn(async () => ({ stdout: "测试结果", stderr: "", exitCode: 0 }));
  sandbox.command = command;
  const authorize = vi.fn(async () => ({
    consumedAtMonotonicMs: performance.now(),
    maxContinuationDelayMs: 250,
  }));
  const options: SessionOptions = {
    model,
    operatorInstructions: DEFAULT_AGENT_OPERATOR_INSTRUCTIONS,
    modelRuntime,
    modelContext: bindTrustedPiModelContextCapability(modelRuntime, model),
    sandbox,
    toolCallingMode: "ptc",
    preparePtcProgram: async () => undefined,
    preparePtcTool: async () => undefined,
    authorizeToolEffect: authorize,
    createToolObservationRecorder: (outputs) => ({
      record: async (call) => {
        const observation = await outputs.readControlledReceipt(call);
        return observation === undefined
          ? { outcome: "conflict" }
          : { outcome: "recorded", observation, isTruncated: false };
      },
    }),
  };
  return { faux, command, authorize, options };
}

describe("PTC Session 恢复安全选项", () => {
  it.each(["started", "receipt"] as const)(
    "内部 %s UNKNOWN 被 guest 捕获后，禁止第二个 child 和下一次模型请求",
    async (unknownAt) => {
      const h = await harness();
      let blocked = false;
      let providerCalls = 0;
      const closedParents: string[] = [];
      const guard = vi.fn(() => {
        if (blocked) throw new ModelContinuationRejectedError("tool_observation_incomplete");
      });
      const prepareTool = vi.fn(async () => {
        if (unknownAt === "started") {
          blocked = true;
          throw new Error("PTC_START_UNKNOWN");
        }
      });
      const options: SessionOptions = {
        ...h.options,
        assertModelRequestAllowed: guard,
        preparePtcTool: prepareTool,
        createToolObservationRecorder: (outputs) => ({
          record: async (call) => {
            if (call.toolName === "exec_command" && unknownAt === "receipt") {
              blocked = true;
              return { outcome: "unknown" };
            }
            const observation = await outputs.readControlledReceipt(call);
            if (observation === undefined) return { outcome: "conflict" };
            if (call.toolName === "run_code") closedParents.push(observation);
            return { outcome: "recorded", observation, isTruncated: false };
          },
        }),
      };
      h.faux.setResponses([
        () => {
          providerCalls += 1;
          return fauxAssistantMessage(
            fauxToolCall("run_code", {
              code: `
                try { await tools.exec_command({cmd:"first"}); } catch {}
                try { await tools.exec_command({cmd:"second"}); } catch {}
                return "guest-caught";
              `,
            }),
            { stopReason: "toolUse" },
          );
        },
        () => {
          providerCalls += 1;
          return fauxAssistantMessage("不应继续请求模型");
        },
      ]);
      const result = await recoverSafePiSession({
        ...options,
        loadRecovery: async (current) => ({
          outcome: "loaded",
          recordedCompatibility: current,
          tail: [],
        }),
      });
      expect(result.outcome).toBe("session_created");
      if (result.outcome !== "session_created") throw new Error("未创建恢复 Session");
      try {
        await expect(result.controller.prompt("恢复执行测试")).rejects.toMatchObject({
          code: "MODEL_CONTINUATION_REJECTED",
          reason: "tool_observation_incomplete",
        });
        expect(blocked).toBe(true);
        expect(guard).toHaveBeenCalled();
        expect(prepareTool).toHaveBeenCalledTimes(1);
        expect(h.command).toHaveBeenCalledTimes(unknownAt === "started" ? 0 : 1);
        expect(h.authorize).toHaveBeenCalledTimes(unknownAt === "started" ? 0 : 1);
        expect(providerCalls).toBe(1);
        // 外层 failed receipt 成功闭合，也不能撤销内层 UNKNOWN 的 continuation 拒绝。
        expect(closedParents).toHaveLength(1);
        expect(JSON.parse(closedParents[0] ?? "{}")).toMatchObject({ outcome: "failed" });
      } finally {
        result.controller.dispose();
      }
    },
  );

  for (const mode of ["native", "ptc"] as const) {
    it.each([
      { label: "空", enabledToolNames: [] },
      { label: "平台关闭命令", enabledToolNames: ["exec_command"], enabledTools: [] },
      { label: "窄", enabledToolNames: ["exec_command"] },
    ] as const)(
      `${mode} 恢复保留$label allowlist 的兼容身份及实际能力，不扩大工具集合`,
      async (selection) => {
        const { enabledToolNames } = selection;
        const platformSelection =
          "enabledTools" in selection ? { enabledTools: selection.enabledTools } : {};
        const effectiveNames = "enabledTools" in selection ? [] : enabledToolNames;
        const h = await harness();
        const options: SessionOptions = {
          ...h.options,
          toolCallingMode: mode,
          enabledToolNames,
          ...platformSelection,
        };
        const expected = deriveSafePiSessionCompatibility(options);
        expect(expected.toolSchemaHash).not.toBe(
          deriveSafePiSessionCompatibility({ ...h.options, toolCallingMode: mode }).toolSchemaHash,
        );
        let exposedNames: string[] = [];
        let guestResult = "";
        h.faux.setResponses([
          (context) => {
            exposedNames = (context.tools ?? []).map((tool) => tool.name);
            if (mode === "native") return fauxAssistantMessage("恢复完成");
            const schema = context.tools?.[0]?.parameters as
              | { properties?: { code?: { description?: string } } }
              | undefined;
            const sdk = schema?.properties?.code?.description;
            exposedNames = (
              JSON.parse(String(sdk).split("\n").at(-1) ?? "[]") as {
                name: string;
              }[]
            ).map((tool) => tool.name);
            return fauxAssistantMessage(
              fauxToolCall("run_code", {
                code: "return {toolNames:Object.keys(tools).sort()};",
              }),
              { stopReason: "toolUse" },
            );
          },
          (context) => {
            guestResult = context.messages
              .filter((message) => message.role === "toolResult")
              .flatMap((message) => message.content)
              .filter((content) => content.type === "text")
              .map((content) => content.text)
              .join("\n");
            return fauxAssistantMessage("恢复完成");
          },
        ]);
        const loadRecovery = vi.fn(async (current: RolloutCompatibilityIdentity) => {
          expect(current).toEqual(expected);
          return { outcome: "loaded" as const, recordedCompatibility: expected, tail: [] };
        });
        const result = await recoverSafePiSession({ ...options, loadRecovery });
        expect(loadRecovery).toHaveBeenCalledTimes(1);
        expect(result.outcome).toBe("session_created");
        if (result.outcome !== "session_created") throw new Error("未创建恢复 Session");
        try {
          expect(result.controller.getDiagnostics().activeToolNames).toEqual(
            mode === "ptc" ? ["run_code"] : effectiveNames,
          );
          await result.controller.prompt("恢复 allowlist 测试");
          expect(exposedNames).toEqual(effectiveNames);
          if (mode === "ptc") {
            expect(JSON.parse(guestResult)).toEqual({
              logs: [],
              value: { toolNames: effectiveNames },
            });
          }
          expect(h.command).not.toHaveBeenCalled();
          expect(h.authorize).not.toHaveBeenCalled();
        } finally {
          result.controller.dispose();
        }
      },
    );
  }
});

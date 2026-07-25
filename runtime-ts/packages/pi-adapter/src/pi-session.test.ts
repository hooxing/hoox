import { FakeSandboxHandle } from "@cube-runtime/sandbox";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  type FauxProviderHandle,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { EmptyResourceLoader } from "./empty-resource-loader.js";
import type { RuntimeAgentEvent } from "./events.js";
import {
  assertLinuxWorkerPlatform,
  createSafePiSession,
  type PiSessionController,
} from "./pi-session.js";
import { SANDBOX_TOOL_NAMES } from "./tools.js";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
});

describe("Pi 安全适配", () => {
  it.runIf(process.platform === "linux")(
    "Linux 下只发布 assistant 成功终态，并保持模型逻辑 cwd 为 /workspace",
    async () => {
      const sandbox = new FakeSandboxHandle("pi-fake");
      let modelContext = "";
      const { controller, events, toolAuthorizationCount } = await harness(
        [
          (context) => {
            modelContext = JSON.stringify(context);
            return fauxAssistantMessage(
              fauxToolCall("sandbox_write_file", { path: "/tmp/pi.txt", content: "pi-safe" }),
              { stopReason: "toolUse" },
            );
          },
          fauxAssistantMessage("完成"),
        ],
        sandbox,
      );

      await controller.prompt("把内容写入隔离环境");

      expect(sandbox.files.get("/tmp/pi.txt")).toBe("pi-safe");
      expect(toolAuthorizationCount()).toBe(1);
      expect(events.filter((event) => event.type === "message.completed")).toEqual([
        { type: "message.completed", stopReason: "toolUse" },
        { type: "message.completed", stopReason: "stop" },
      ]);
      expect(events.some((event) => event.type === "tool.completed")).toBe(true);
      expect(events.some((event) => event.type === "compaction.forbidden")).toBe(false);
      expect(controller.getDiagnostics()).toEqual({
        logicalCwd: "/workspace",
        activeToolNames: expect.arrayContaining([...SANDBOX_TOOL_NAMES]),
        compactionEnabled: false,
        hasCompactionEntry: false,
      });
      expect("compact" in controller).toBe(false);
      expect("session" in controller).toBe(false);
      expect(modelContext).toContain("你是受控 Agent");
      expect(modelContext).toContain("/workspace");
      expect(modelContext).not.toMatch(hostPathPattern(process.cwd()));
      expect(modelContext).not.toMatch(hostPathPattern(process.cwd().replaceAll("\\", "/")));
    },
  );

  it.runIf(process.platform === "linux")("Tool Router 在 DB 许可拒绝时不触碰 Sandbox", async () => {
    const sandbox = new FakeSandboxHandle("pi-denied-tool");
    const { controller, events } = await harness(
      [
        fauxAssistantMessage(
          fauxToolCall("sandbox_write_file", { path: "/tmp/denied.txt", content: "no" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("已处理"),
      ],
      sandbox,
      undefined,
      async () => {
        throw new Error("DB 拒绝外部副作用许可");
      },
    );

    await controller.prompt("尝试写入");

    expect(sandbox.files.has("/tmp/denied.txt")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool.completed", isError: true }),
    );
  });

  it.runIf(process.platform === "linux")(
    "把 Faux Provider 真实失败映射为稳定 PROVIDER，且不发布 completed",
    async () => {
      const { controller, events } = await harness([
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "测试 Provider 私有错误" }),
      ]);
      await controller.prompt("触发失败");
      expect(events).toContainEqual({
        type: "error",
        code: "PROVIDER",
        message: "模型 Provider 调用失败",
      });
      expect(events.some((event) => event.type === "message.completed")).toBe(false);
      expect(JSON.stringify(events)).not.toContain("测试 Provider 私有错误");
      expect(events.findIndex((event) => event.type === "agent.started")).toBeLessThan(
        events.findIndex((event) => event.type === "error"),
      );
      expect(events.findIndex((event) => event.type === "error")).toBeLessThan(
        events.findIndex((event) => event.type === "agent.settled"),
      );
    },
  );

  it.runIf(process.platform === "linux")(
    "Faux Provider 流式处理中 abort 产生 ABORTED 终态",
    async () => {
      const delayedAbort: FauxResponseStep = async (_context, options) =>
        new Promise((resolve) => {
          const finish = () => resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
          if (options?.signal?.aborted) finish();
          else options?.signal?.addEventListener("abort", finish, { once: true });
        });
      const { controller, events, started } = await harness([delayedAbort]);
      const prompting = controller.prompt("等待中止");
      await started;
      await controller.abort();
      await prompting;
      expect(events).toContainEqual({ type: "error", code: "ABORTED", message: "模型调用已中止" });
      expect(events.some((event) => event.type === "message.completed")).toBe(false);
      expect(events.findIndex((event) => event.type === "agent.started")).toBeLessThan(
        events.findIndex((event) => event.type === "error"),
      );
      expect(events.findIndex((event) => event.type === "error")).toBeLessThan(
        events.findIndex((event) => event.type === "agent.settled"),
      );
    },
  );

  it.runIf(process.platform === "linux")(
    "Faux Provider 真实验证 steer/follow-up 队列和事件顺序",
    async () => {
      let queuedContext = "";
      const first: FauxResponseStep = async () => {
        await delay(40);
        return fauxAssistantMessage("第一步");
      };
      const queued: FauxResponseStep = (context) => {
        queuedContext = JSON.stringify(context.messages);
        return fauxAssistantMessage("队列消息已处理");
      };
      const { controller, events, started, faux } = await harness([first, queued]);
      const prompting = controller.prompt("开始");
      await started;
      await controller.steer("转向消息");
      await controller.followUp("追问消息");
      await prompting;

      const queueEvents = events.filter((event) => event.type === "queue.updated");
      expect(queueEvents.some((event) => event.steering.includes("转向消息"))).toBe(true);
      expect(queueEvents.some((event) => event.followUp.includes("追问消息"))).toBe(true);
      // Pi 会把同一安全点的 steer/follow-up 合并进下一次模型上下文，而不是强制各发一次请求。
      expect(faux.state.callCount).toBe(2);
      expect(queuedContext).toContain("转向消息");
      expect(queuedContext).toContain("追问消息");
      expect(events.at(-1)?.type).toBe("agent.settled");
    },
  );

  it.runIf(process.platform === "linux")(
    "waiting 恢复把受控 RolloutProjection 投影到新 Session，并用 prompt 真正启动模型",
    async () => {
      let resumedContext = "";
      const { controller, faux } = await harness(
        [
          (context) => {
            resumedContext = JSON.stringify(context.messages);
            return fauxAssistantMessage("已按补充信息继续");
          },
        ],
        new FakeSandboxHandle("pi-resume-fake"),
        {
          schemaVersion: 1,
          checkpointId: "checkpoint-waiting-1",
          turns: [
            { role: "user", text: "生成报告" },
            { role: "assistant", text: "请补充报告范围" },
          ],
        },
      );

      await controller.prompt("只处理 Markdown");

      expect(faux.state.callCount).toBe(1);
      expect(resumedContext).toContain("checkpoint-waiting-1");
      expect(resumedContext).toContain("生成报告");
      expect(resumedContext).toContain("请补充报告范围");
      expect(resumedContext).toContain("只处理 Markdown");
    },
  );

  it.runIf(process.platform === "linux")(
    "拒绝非法 role、空文本和宿主绝对路径的 RolloutProjection",
    async () => {
      const invalidTurns = [
        [{ role: "system", text: "越权" }],
        [{ role: "user", text: "   " }],
        [{ role: "assistant", text: "读取 C:\\Users\\host\\secret" }],
        [{ role: "assistant", text: "读取 /var/lib/runtime/secret" }],
      ] as const;
      for (const turns of invalidTurns) {
        await expect(
          harness([], new FakeSandboxHandle("invalid-projection"), {
            schemaVersion: 1,
            checkpointId: "invalid",
            turns: turns as never,
          }),
        ).rejects.toThrow("RolloutProjection");
      }
    },
  );

  it("Windows Worker 在创建 Pi Session 前明确失败", async () => {
    expect(() => assertLinuxWorkerPlatform("win32")).toThrow("仅支持 Linux");
    if (process.platform !== "linux") {
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
      });
      const faux = fauxProvider({ api: "faux-platform", provider: "faux-platform" });
      modelRuntime.registerNativeProvider(faux.provider);
      await expect(
        createSafePiSession({
          model: faux.getModel(),
          modelRuntime,
          sandbox: new FakeSandboxHandle("platform-guard"),
          authorizeToolEffect: async () => undefined,
        }),
      ).rejects.toThrow("仅支持 Linux");
    }
  });

  it("零发现 ResourceLoader 不接受宿主路径或扩展资源", async () => {
    const loader = new EmptyResourceLoader("固定提示词");
    await loader.reload();
    loader.extendResources({
      skillPaths: [
        {
          path: "C:/host/secret",
          metadata: { source: "host", scope: "project", origin: "top-level" },
        },
      ],
    });
    expect(loader.getSystemPrompt()).toBe("固定提示词");
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getAppendSystemPrompt()).toEqual([]);
  });
});

async function harness(
  responses: FauxResponseStep[],
  sandbox = new FakeSandboxHandle("pi-fake"),
  rolloutProjection?: Parameters<typeof createSafePiSession>[0]["rolloutProjection"],
  authorizeToolEffect?: () => Promise<unknown>,
): Promise<{
  controller: PiSessionController;
  events: RuntimeAgentEvent[];
  started: Promise<void>;
  faux: FauxProviderHandle;
  toolAuthorizationCount: () => number;
}> {
  const suffix = `${Date.now()}-${Math.random()}`;
  const faux = fauxProvider({
    api: `faux-m0-${suffix}`,
    provider: `faux-m0-${suffix}`,
    tokensPerSecond: 10_000,
  });
  faux.setResponses(responses);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only-key");
  let authorizationCount = 0;
  const controller = await createSafePiSession({
    model: faux.getModel(),
    modelRuntime,
    sandbox,
    authorizeToolEffect: async () => {
      authorizationCount += 1;
      return authorizeToolEffect?.();
    },
    ...(rolloutProjection === undefined ? {} : { rolloutProjection }),
  });
  disposers.push(() => controller.dispose());
  const events: RuntimeAgentEvent[] = [];
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  controller.subscribe((event) => {
    events.push(event);
    if (event.type === "agent.started") resolveStarted?.();
  });
  return { controller, events, started, faux, toolAuthorizationCount: () => authorizationCount };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hostPathPattern(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 以边界匹配宿主 cwd，避免 Linux 测试目录 /work 与逻辑路径 /workspace 的前缀误判。
  return new RegExp(`${escaped}(?:[/\\\\"]|$)`);
}

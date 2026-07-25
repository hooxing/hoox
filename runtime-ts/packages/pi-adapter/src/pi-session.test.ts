import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeSandboxHandle } from "@cube-runtime/sandbox";
import { PiSessionController, createSafePiSession, type PiSessionPort } from "./pi-session.js";
import type { RuntimeAgentEvent } from "./events.js";
import { SANDBOX_TOOL_NAMES } from "./tools.js";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
});

describe("Pi 安全适配", () => {
  it("使用 Fake Provider 完成自定义 Sandbox Tool Call，且不触发 Pi compaction", async () => {
    const faux = fauxProvider({
      api: `faux-m0-${Date.now()}`,
      provider: "faux-m0",
      tokensPerSecond: 10_000,
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("sandbox_write_file", { path: "/tmp/pi.txt", content: "pi-safe" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("完成"),
    ]);

    const sandbox = new FakeSandboxHandle("pi-fake");
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey("faux-m0", "test-only-key");
    const { controller, piSession, settingsManager } = await createSafePiSession({
      model: faux.getModel(),
      modelRuntime,
      sandbox,
    });
    disposers.push(() => controller.dispose());

    const events: RuntimeAgentEvent[] = [];
    controller.subscribe((event) => events.push(event));
    await controller.prompt("把内容写入隔离环境");

    expect(sandbox.files.get("/tmp/pi.txt")).toBe("pi-safe");
    expect(settingsManager.getCompactionEnabled()).toBe(false);
    expect(piSession.agent.state.tools.map((tool) => tool.name).sort()).toEqual(
      [...SANDBOX_TOOL_NAMES].sort(),
    );
    expect(events.some((event) => event.type === "tool.completed")).toBe(true);
    expect(events.some((event) => event.type === "compaction.forbidden")).toBe(false);
    expect(piSession.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(
      false,
    );
  });

  it("abort、steer 和 follow-up 仅委托给 Pi Session，不自行改写语义", async () => {
    const port: PiSessionPort = {
      prompt: vi.fn(async () => undefined),
      steer: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      subscribe: vi.fn((_listener: (event: AgentSessionEvent) => void) => () => undefined),
      dispose: vi.fn(),
    };
    const controller = new PiSessionController(port);
    await controller.steer("转向");
    await controller.followUp("追问");
    await controller.abort();
    expect(port.steer).toHaveBeenCalledWith("转向");
    expect(port.followUp).toHaveBeenCalledWith("追问");
    expect(port.abort).toHaveBeenCalledOnce();
  });
});

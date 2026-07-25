import type { SandboxHandle } from "@cube-runtime/sandbox";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { mapPiEvent, type RuntimeAgentEvent } from "./events.js";
import { createSandboxTools, SANDBOX_TOOL_NAMES } from "./tools.js";

export interface PiSessionPort {
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  dispose(): void;
}

export class PiSessionController {
  constructor(private readonly session: PiSessionPort) {}

  prompt(text: string): Promise<void> {
    return this.session.prompt(text);
  }
  steer(text: string): Promise<void> {
    return this.session.steer(text);
  }
  followUp(text: string): Promise<void> {
    return this.session.followUp(text);
  }
  abort(): Promise<void> {
    return this.session.abort();
  }
  dispose(): void {
    this.session.dispose();
  }

  subscribe(listener: (event: RuntimeAgentEvent) => void): () => void {
    return this.session.subscribe((event) => {
      const mapped = mapPiEvent(event);
      if (mapped) listener(mapped);
    });
  }
}

export interface CreateSafePiSessionOptions {
  model: Model<Api>;
  modelRuntime: ModelRuntime;
  sandbox: SandboxHandle;
  systemPrompt?: string;
  cwd?: string;
}

export interface SafePiSession {
  controller: PiSessionController;
  /** 仅供启动检查与测试，不作为持久化真相。 */
  piSession: AgentSession;
  settingsManager: SettingsManager;
}

export async function createSafePiSession(
  options: CreateSafePiSessionOptions,
): Promise<SafePiSession> {
  const cwd = options.cwd ?? process.cwd();
  const settingsManager = SettingsManager.inMemory(
    {
      compaction: { enabled: false },
      retry: { enabled: false },
    },
    { projectTrusted: false },
  );

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt:
      options.systemPrompt ??
      "你是受控 Agent，只能通过已注册的 CubeSandbox 工具操作文件与执行代码。",
    appendSystemPrompt: [],
  });
  await resourceLoader.reload();

  const customTools = createSandboxTools(options.sandbox);
  const { session } = await createAgentSession({
    cwd,
    model: options.model,
    modelRuntime: options.modelRuntime,
    thinkingLevel: "off",
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    resourceLoader,
    customTools,
    // 双重白名单：即便 Pi 将来新增默认工具，也不会把宿主机工具暴露给模型。
    noTools: "all",
    tools: [...SANDBOX_TOOL_NAMES],
    excludeTools: ["bash", "read", "write", "edit", "grep", "find", "ls"],
  });

  return { controller: new PiSessionController(session), piSession: session, settingsManager };
}

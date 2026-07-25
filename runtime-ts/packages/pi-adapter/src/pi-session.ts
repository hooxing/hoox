import type { SandboxHandle } from "@cube-runtime/sandbox";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { EmptyResourceLoader } from "./empty-resource-loader.js";
import { mapPiEvent, type RuntimeAgentEvent } from "./events.js";
import { createSandboxTools, SANDBOX_TOOL_NAMES } from "./tools.js";

interface PiSessionPort {
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  dispose(): void;
}

export interface PiSessionDiagnostics {
  logicalCwd: "/workspace";
  activeToolNames: string[];
  compactionEnabled: false;
  hasCompactionEntry: boolean;
}

export interface PiSessionController {
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: RuntimeAgentEvent) => void): () => void;
  getDiagnostics(): Readonly<PiSessionDiagnostics>;
}

class PiSessionControllerImpl implements PiSessionController {
  readonly #session: PiSessionPort;
  readonly #diagnostics: () => PiSessionDiagnostics;

  constructor(session: PiSessionPort, diagnostics: () => PiSessionDiagnostics) {
    this.#session = session;
    this.#diagnostics = diagnostics;
  }

  prompt(text: string): Promise<void> {
    return this.#session.prompt(text);
  }

  steer(text: string): Promise<void> {
    return this.#session.steer(text);
  }

  followUp(text: string): Promise<void> {
    return this.#session.followUp(text);
  }

  abort(): Promise<void> {
    return this.#session.abort();
  }

  dispose(): void {
    this.#session.dispose();
  }

  subscribe(listener: (event: RuntimeAgentEvent) => void): () => void {
    return this.#session.subscribe((event) => {
      const mapped = mapPiEvent(event);
      if (mapped) listener(mapped);
    });
  }

  getDiagnostics(): Readonly<PiSessionDiagnostics> {
    return Object.freeze(this.#diagnostics());
  }
}

export interface CreateSafePiSessionOptions {
  model: Model<Api>;
  modelRuntime: ModelRuntime;
  sandbox: SandboxHandle;
  systemPrompt?: string;
}

const LOGICAL_WORKSPACE = "/workspace" as const;

export async function createSafePiSession(
  options: CreateSafePiSessionOptions,
): Promise<PiSessionController> {
  const settingsManager = SettingsManager.inMemory(
    {
      compaction: { enabled: false },
      retry: { enabled: false },
    },
    { projectTrusted: false },
  );

  const resourceLoader = new EmptyResourceLoader(
    options.systemPrompt ?? "你是受控 Agent，只能通过已注册的 CubeSandbox 工具操作文件与执行代码。",
  );
  await resourceLoader.reload();

  const customTools = createSandboxTools(options.sandbox);
  const { session } = await createAgentSession({
    cwd: LOGICAL_WORKSPACE,
    model: options.model,
    modelRuntime: options.modelRuntime,
    thinkingLevel: "off",
    sessionManager: SessionManager.inMemory(LOGICAL_WORKSPACE),
    settingsManager,
    resourceLoader,
    customTools,
    // 双重白名单：即便 Pi 将来新增默认工具，也不会把宿主机工具暴露给模型。
    noTools: "all",
    tools: [...SANDBOX_TOOL_NAMES],
    excludeTools: ["bash", "read", "write", "edit", "grep", "find", "ls"],
  });

  // 对外只返回窄能力对象；AgentSession（含 compact）保留在闭包和 #private 字段内。
  return new PiSessionControllerImpl(session, () => ({
    logicalCwd: LOGICAL_WORKSPACE,
    activeToolNames: session.agent.state.tools.map((tool) => tool.name),
    compactionEnabled: false,
    hasCompactionEntry: session.sessionManager
      .getEntries()
      .some((entry) => entry.type === "compaction"),
  }));
}

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
import {
  createSandboxTools,
  SANDBOX_TOOL_NAMES,
  type SandboxToolEffectAuthorizer,
} from "./tools.js";
import { createArtifactPiTools, PI_ARTIFACT_TOOL_NAMES } from "./artifact-tools.js";
import type { ArtifactPiToolExecutorPort } from "./artifact-tools.js";

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
  rolloutProjection?: ControlledRolloutProjection;
  /** 生产 Tool Router 在每次 Sandbox 工具执行前回到 DB 重验双栅栏。 */
  authorizeToolEffect: SandboxToolEffectAuthorizer["authorizeToolEffect"];
  /** 只有生产装配显式提供真实 Artifact/Resource 依赖时才注册，缺失时不伪造发布能力。 */
  artifactToolRouter?: ArtifactPiToolExecutorPort;
}

/**
 * Runtime 持久化并审计的受控上下文投影。它不是 Pi Session 文件，也不允许携带工具结果、
 * 宿主路径或任意 Pi 内部 entry；恢复时只把经过裁剪的文本上下文重新投影给新 Session。
 */
export interface ControlledRolloutProjection {
  readonly schemaVersion: 1;
  readonly checkpointId: string;
  readonly turns: readonly {
    readonly role: "user" | "assistant";
    readonly text: string;
  }[];
}

const LOGICAL_WORKSPACE = "/workspace" as const;

/**
 * Pi 0.82.1 会对 cwd 使用宿主平台 path.resolve；Windows 会把 /workspace 改写为宿主盘符路径。
 * 当前生产 Worker 因此明确只支持 Linux，并在创建任何 Session 前失败，避免宿主路径进入模型上下文。
 */
export function assertLinuxWorkerPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "linux") {
    throw new Error(`Pi Runtime Worker 仅支持 Linux；当前平台为 ${platform}`);
  }
}

export async function createSafePiSession(
  options: CreateSafePiSessionOptions,
): Promise<PiSessionController> {
  assertLinuxWorkerPlatform();
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

  const customTools = [
    ...createSandboxTools(options.sandbox, {
      authorizeToolEffect: options.authorizeToolEffect,
    }),
    ...(options.artifactToolRouter === undefined
      ? []
      : createArtifactPiTools(options.artifactToolRouter)),
  ];
  const sessionManager = SessionManager.inMemory(LOGICAL_WORKSPACE);
  const projectedContext = formatRolloutProjection(options.rolloutProjection);
  if (projectedContext !== undefined) {
    sessionManager.appendCustomMessageEntry(
      "runtime.controlled_rollout_projection.v1",
      projectedContext,
      false,
      { checkpointId: options.rolloutProjection?.checkpointId },
    );
  }
  const { session } = await createAgentSession({
    cwd: LOGICAL_WORKSPACE,
    model: options.model,
    modelRuntime: options.modelRuntime,
    thinkingLevel: "off",
    sessionManager,
    settingsManager,
    resourceLoader,
    customTools,
    // 双重白名单：即便 Pi 将来新增默认工具，也不会把宿主机工具暴露给模型。
    noTools: "all",
    tools: [
      ...SANDBOX_TOOL_NAMES,
      ...(options.artifactToolRouter === undefined ? [] : PI_ARTIFACT_TOOL_NAMES),
    ],
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

function formatRolloutProjection(
  projection: ControlledRolloutProjection | undefined,
): string | undefined {
  if (projection === undefined || projection.turns.length === 0) return undefined;
  if (
    projection.schemaVersion !== 1 ||
    !projection.checkpointId.trim() ||
    projection.checkpointId.length > 200 ||
    projection.turns.length > 200
  ) {
    throw new Error("RolloutProjection 版本或 checkpointId 无效");
  }
  const lines = projection.turns.map((turn) => {
    if (turn.role !== "user" && turn.role !== "assistant") {
      throw new Error("RolloutProjection role 无效");
    }
    const text = turn.text.trim();
    if (!text || text.length > 16_000) throw new Error("RolloutProjection 文本长度无效");
    if (/(?:[A-Za-z]:[\\/]|\/(?:home|Users|var\/lib|opt|srv)\/)/u.test(text)) {
      throw new Error("RolloutProjection 不能包含宿主机路径");
    }
    return `${turn.role === "user" ? "用户" : "助手"}：${text}`;
  });
  const rendered = `以下是 Runtime 审核并持久化的历史上下文投影（checkpoint=${projection.checkpointId}）：\n${lines.join("\n")}`;
  if (new TextEncoder().encode(rendered).byteLength > 64 * 1024) {
    throw new Error("RolloutProjection 超过 64 KiB 上限");
  }
  return rendered;
}

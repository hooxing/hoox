import type { SandboxHandle } from "@cube-runtime/sandbox";
import { createHash } from "node:crypto";
import { buildRuntimeSystemPrompt, type RuntimePromptInput } from "@cube-runtime/prompt-builder";
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
  promptSchemaVersion: 1;
  promptVersion: string;
  capabilityManifestDigest: string;
  promptDigest: string;
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
  /** Tenant/Skill/User 只能进入低信任数据分区，不能直接替换系统 Harness。 */
  untrustedPromptContent?: RuntimePromptInput["untrusted"];
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

  const customTools = [
    ...createSandboxTools(options.sandbox, {
      authorizeToolEffect: options.authorizeToolEffect,
    }),
    ...(options.artifactToolRouter === undefined
      ? []
      : createArtifactPiTools(options.artifactToolRouter)),
  ];
  // 能力清单从即将传给 Pi 的同一组真实工具派生，不能维护第二份易漂移的硬编码列表。
  const builtPrompt = buildRuntimeSystemPrompt({
    schemaVersion: 1,
    capabilities: customTools.map((tool) => ({
      id: tool.name,
      description: tool.description,
      inputSchemaDigest: digestToolInputSchema(tool.parameters),
    })),
    untrusted: options.untrustedPromptContent ?? { tenant: [], skill: [], user: [] },
  });
  const resourceLoader = new EmptyResourceLoader(builtPrompt.systemPrompt);
  await resourceLoader.reload();
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
  const activeToolNames = session.agent.state.tools.map((tool) => tool.name).sort();
  const manifestedToolNames = builtPrompt.manifest.capabilities.map((tool) => tool.id).sort();
  if (JSON.stringify(activeToolNames) !== JSON.stringify(manifestedToolNames)) {
    // Pi 升级或装配漂移时宁可拒绝 Session，也不能让模型依据虚假的能力清单继续执行。
    session.dispose();
    throw new Error("Pi 实际工具与 capability manifest 不一致");
  }

  // 对外只返回窄能力对象；AgentSession（含 compact）保留在闭包和 #private 字段内。
  return new PiSessionControllerImpl(session, () => ({
    logicalCwd: LOGICAL_WORKSPACE,
    activeToolNames: session.agent.state.tools.map((tool) => tool.name),
    promptSchemaVersion: builtPrompt.schemaVersion,
    promptVersion: builtPrompt.version,
    capabilityManifestDigest: builtPrompt.manifest.digest,
    promptDigest: builtPrompt.promptDigest,
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

/** 参数 Schema 摘要覆盖 Provider 可见的可枚举 JSON 结构；TypeBox 的内部 Symbol 标记不进入协议。 */
function digestToolInputSchema(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalSchema(value)))
    .digest("hex")}`;
}

function canonicalSchema(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("工具参数 Schema 含非法数值");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalSchema);
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("工具参数 Schema 不是规范 JSON 对象");
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalSchema(item)]),
  );
}

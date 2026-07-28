import { createHash } from "node:crypto";
import {
  assertControlledToolObservation,
  encodeControlledToolReceipt,
  parseControlledToolReceipt,
} from "@cube-runtime/context-policy";
import { types } from "node:util";
import { type RolloutCompatibilityIdentity, sha256Digest } from "@cube-runtime/domain";
import {
  buildRuntimeSystemPrompt,
  buildToolCapabilityManifest,
  type RuntimePromptInput,
  type ToolCapabilityManifest,
} from "@cube-runtime/prompt-builder";
import type { SandboxHandle } from "@cube-runtime/sandbox";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import {
  type AgentSessionEvent,
  createAgentSession,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ArtifactPiToolExecutorPort } from "./artifact-tools.js";
import { createArtifactPiTools, PI_ARTIFACT_TOOL_NAMES } from "./artifact-tools.js";
import { EmptyResourceLoader } from "./empty-resource-loader.js";
import { mapPiEvent, type RuntimeAgentEvent } from "./events.js";
import {
  createObservedSandboxTools,
  SANDBOX_TOOL_NAMES,
  type SandboxToolEffectAuthorizer,
} from "./tools.js";

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
  /** 必须绑定当前 Tenant/Attempt 的 durable Observation recorder；生产缺失时拒绝创建 Session。 */
  createToolObservationRecorder: Parameters<typeof createObservedSandboxTools>[2];
}

/**
 * Runtime 持久化并审计的受控上下文投影。它不是 Pi Session 文件，也不允许携带工具结果、
 * 宿主路径或任意 Pi 内部 entry；恢复时只把经过裁剪的文本上下文重新投影给新 Session。
 */
export interface ControlledRolloutProjection {
  readonly schemaVersion: 2;
  readonly checkpointId: string;
  readonly items: readonly (
    | { readonly kind: "turn"; readonly role: "user" | "assistant"; readonly text: string }
    | {
        readonly kind: "tool_receipt";
        readonly toolCallId: string;
        readonly toolName: string;
        readonly outcome: "succeeded" | "failed";
        readonly observation: string;
        readonly isTruncated: boolean;
        readonly modelVisibleBytes: number;
        readonly reason?: "model_utf8_budget_or_rollout_body_budget";
      }
  )[];
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
  if (typeof options.createToolObservationRecorder !== "function") {
    throw new Error("生产 Pi Session 缺少 durable Tool Observation recorder");
  }
  const settingsManager = SettingsManager.inMemory(
    {
      compaction: { enabled: false },
      retry: { enabled: false },
    },
    { projectTrusted: false },
  );

  const { customTools, builtPrompt } = buildSafeSessionMaterial(options);
  const resourceLoader = new EmptyResourceLoader(builtPrompt.systemPrompt);
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(LOGICAL_WORKSPACE);
  for (const entry of builtPrompt.contextEntries) {
    sessionManager.appendCustomMessageEntry(entry.customType, entry.content, false, entry.source);
  }
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
  assertPiSessionCapabilityManifest({
    readTools: () => session.agent.state.tools,
    expected: builtPrompt.manifest,
    dispose: () => session.dispose(),
  });

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

/**
 * 恢复兼容身份只能由本次实际 Model、可信 Prompt Builder、真实 Tool Schema 与 Skill 分区派生。
 * 调用方不能自行传入“期望摘要”来绕过数据库的兼容判断。
 */
export function deriveSafePiSessionCompatibility(
  options: CreateSafePiSessionOptions,
): RolloutCompatibilityIdentity {
  const { builtPrompt } = buildSafeSessionMaterial(options);
  const model = options.model;
  return Object.freeze({
    modelId: model.id,
    modelCompatibilityHash: digestProtocolValue({
      id: model.id,
      provider: model.provider,
      api: model.api,
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      compat: model.compat,
    }),
    promptPolicyHash: digestProtocolValue({
      schemaVersion: builtPrompt.schemaVersion,
      version: builtPrompt.version,
      systemPrompt: builtPrompt.systemPrompt,
    }),
    toolSchemaHash: digestProtocolValue(builtPrompt.manifest),
    skillManifestHash: digestProtocolValue({
      schemaVersion: 1,
      entries: builtPrompt.contextEntries
        .filter((entry) => entry.source.kind === "skill")
        .map((entry) => ({
          ordinal: entry.source.ordinal,
          publicAlias: entry.source.publicAlias,
          contentDigest: entry.source.contentDigest,
        })),
    }),
  });
}

function buildSafeSessionMaterial(options: CreateSafePiSessionOptions) {
  const observedSandboxTools = createObservedSandboxTools(
    options.sandbox,
    {
      authorizeToolEffect: options.authorizeToolEffect,
    },
    options.createToolObservationRecorder,
  );
  const customTools = [
    ...observedSandboxTools.tools,
    ...(options.artifactToolRouter === undefined
      ? []
      : createArtifactPiTools(
          options.artifactToolRouter,
          observedSandboxTools.recordControlledReceipt,
        )),
  ];
  // 能力清单从即将传给 Pi 的同一组真实工具派生，不能维护第二份易漂移的硬编码列表。
  const builtPrompt = buildRuntimeSystemPrompt({
    schemaVersion: 1,
    capabilities: customTools.map((tool) => ({
      id: tool.name,
      description: tool.description,
      inputSchemaDigest: digestCanonicalToolInputSchema(tool.parameters),
    })),
    untrusted: options.untrustedPromptContent ?? { tenant: [], skill: [], user: [] },
  });
  return { customTools, builtPrompt };
}

function digestProtocolValue(value: unknown) {
  const encoded = JSON.stringify(canonicalProtocolValue(value));
  return sha256Digest(createHash("sha256").update(encoded, "utf8").digest("hex"));
}

function canonicalProtocolValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("恢复兼容身份含非法数值");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalProtocolValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalProtocolValue(item)]),
    );
  }
  throw new Error("恢复兼容身份只接受协议 JSON 值");
}

function formatRolloutProjection(
  projection: ControlledRolloutProjection | undefined,
): string | undefined {
  if (projection === undefined || projection.items.length === 0) return undefined;
  if (
    projection.schemaVersion !== 2 ||
    !projection.checkpointId.trim() ||
    projection.checkpointId.length > 200 ||
    projection.items.length > 200
  ) {
    throw new Error("RolloutProjection 版本或 checkpointId 无效");
  }
  const lines = projection.items.map((item) => {
    if (item.kind === "tool_receipt") {
      try {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(item.toolCallId)) throw new Error();
        const receipt = parseControlledToolReceipt(
          encodeControlledToolReceipt(item.toolName, item.outcome),
        );
        assertControlledToolObservation({
          receipt,
          observation: item.observation,
          isTruncated: item.isTruncated,
          modelVisibleBytes: item.modelVisibleBytes,
          ...(item.reason === undefined ? {} : { reason: item.reason }),
        });
      } catch {
        throw new Error("RolloutProjection 工具 Observation 无效");
      }
      return `工具 ${item.toolCallId} 的低信任观察：${item.observation}`;
    }
    if (item.role !== "user" && item.role !== "assistant") {
      throw new Error("RolloutProjection role 无效");
    }
    const text = item.text.trim();
    if (!text || text.length > 16_000) throw new Error("RolloutProjection 文本长度无效");
    if (/(?:[A-Za-z]:[\\/]|\/(?:home|Users|var\/lib|opt|srv)\/)/u.test(text)) {
      throw new Error("RolloutProjection 不能包含宿主机路径");
    }
    return `${item.role === "user" ? "用户" : "助手"}：${text}`;
  });
  const rendered = `以下是 Runtime 审核并持久化的历史上下文投影（checkpoint=${projection.checkpointId}）：\n${lines.join("\n")}`;
  if (new TextEncoder().encode(rendered).byteLength > 64 * 1024) {
    throw new Error("RolloutProjection 超过 64 KiB 上限");
  }
  return rendered;
}

/** 参数 Schema 摘要覆盖 Provider 可见的可枚举 JSON 结构；TypeBox 的内部 Symbol 标记不进入协议。 */
export function digestCanonicalToolInputSchema(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalSchema(value, new WeakSet<object>())))
    .digest("hex")}`;
}

export function assertPiSessionCapabilityManifest(input: {
  readonly readTools: () => readonly {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  }[];
  readonly expected: ToolCapabilityManifest;
  readonly dispose: () => void;
}): void {
  try {
    // tools 属性读取、tuple 字段读取、Schema 规范化和 manifest 构造必须共享同一个释放边界。
    const activeManifest = buildToolCapabilityManifest(
      input.readTools().map((tool) => ({
        id: tool.name,
        description: tool.description,
        inputSchemaDigest: digestCanonicalToolInputSchema(tool.parameters),
      })),
    );
    if (
      activeManifest.digest !== input.expected.digest ||
      JSON.stringify(activeManifest.capabilities) !== JSON.stringify(input.expected.capabilities)
    ) {
      throw new Error("manifest mismatch");
    }
  } catch {
    try {
      input.dispose();
    } catch {
      // dispose 失败不能覆盖稳定的能力不一致错误；Session 已不再返回给调用方。
    }
    throw new Error("Pi 实际工具与 capability manifest 不一致");
  }
}

const TYPEBOX_SCHEMA_SYMBOLS = new Set([
  Symbol.for("TypeBox.Kind"),
  Symbol.for("TypeBox.Transform"),
]);

function canonicalSchema(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("工具参数 Schema 含非法数值");
    return value;
  }
  if (typeof value !== "object" || types.isProxy(value)) {
    throw new Error("工具参数 Schema 不是规范 JSON 对象");
  }
  if (ancestors.has(value)) throw new Error("工具参数 Schema 不能循环引用");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return canonicalSchemaArray(value, ancestors);
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error("工具参数 Schema 不是普通 JSON 对象");
    }
    // null prototype 避免 JSON Schema 中的 "__proto__" 在规范化阶段改变临时对象原型。
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const stringKeys: string[] = [];
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error("工具参数 Schema 不能包含访问器");
      }
      if (typeof key === "symbol") {
        // TypeBox 历史版本以这两个全局 Symbol 标记 Kind/Transform；Provider JSON 不传输它们。
        if (!TYPEBOX_SCHEMA_SYMBOLS.has(key)) throw new Error("工具参数 Schema 含未知 Symbol");
        continue;
      }
      if (!descriptor.enumerable) {
        if (isAllowedTypeBoxMetadata(key, descriptor.value)) continue;
        throw new Error("工具参数 Schema 含非枚举字段");
      }
      stringKeys.push(key);
    }
    for (const key of stringKeys.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error("工具参数 Schema 不能包含访问器");
      }
      output[key] = canonicalSchema(descriptor.value, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function isAllowedTypeBoxMetadata(key: string, value: unknown): boolean {
  return (
    (key === "~kind" && typeof value === "string" && value.length > 0) ||
    ((key === "~optional" || key === "~readonly") && value === true)
  );
}

function canonicalSchemaArray(value: unknown[], ancestors: WeakSet<object>): unknown[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error("工具参数 Schema 数组原型无效");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) =>
        typeof key === "symbol" ||
        (key !== "length" && (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length)),
    ) ||
    Object.keys(value).length !== value.length
  ) {
    throw new Error("工具参数 Schema 必须使用稠密数组且不能含附加字段");
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("工具参数 Schema 数组不能包含访问器或非枚举元素");
    }
    result.push(canonicalSchema(descriptor.value, ancestors));
  }
  return result;
}

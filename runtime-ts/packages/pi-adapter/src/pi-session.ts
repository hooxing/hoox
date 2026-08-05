import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  assertControlledToolObservation,
  type ContextBudgetDecision,
  decideModelAwareContextBudget,
  encodeControlledToolReceipt,
  type ModelBudgetDescriptor,
  parseControlledToolReceipt,
  type TokenizerPort,
} from "@cube-runtime/context-policy";
import { type RolloutCompatibilityIdentity, sha256Digest } from "@cube-runtime/domain";
import {
  type AvailableSkillPromptInput,
  buildRuntimeSystemPrompt,
  buildToolCapabilityManifest,
  type RuntimePromptInput,
  type ToolCapabilityManifest,
} from "@cube-runtime/prompt-builder";
import type { SandboxHandle } from "@cube-runtime/sandbox";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  Model,
  Provider,
  SimpleStreamOptions,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai/compat";
import {
  type AgentSessionEvent,
  createAgentSession,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  isTrustedModelTokenizerCapability,
  type TrustedModelTokenizerCapability,
} from "./deepseek-v4-tokenizer.js";
import {
  createDeliverFilePiTool,
  type DeliverFilePiToolExecutorPort,
} from "./deliver-file-tool.js";
import { EmptyResourceLoader } from "./empty-resource-loader.js";
import { mapPiEvent, type RuntimeAgentEvent } from "./events.js";
import { createSkillPiTool, type SkillPiToolExecutorPort } from "./skill-tool.js";
import { createTodoWritePiTool, type TodoWritePiToolExecutorPort } from "./todo-write-tool.js";
import {
  assertThreadActiveHistory,
  providerVisibleThreadHistoryMessages,
  type ThreadActiveHistoryV1,
} from "./thread-history.js";
import {
  createObservedSandboxTools,
  SANDBOX_TOOL_NAMES,
  type SandboxToolEffectAuthorizer,
  type SandboxToolHandleProvider,
  type ToolContinuationFailure,
} from "./tools.js";

interface PiSessionPort {
  readonly isStreaming: boolean;
  prompt(text: string, options?: { readonly images?: ImageContent[] }): Promise<void>;
  steer(text: string, images?: ImageContent[]): Promise<void>;
  followUp(text: string, images?: ImageContent[]): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  dispose(): void;
}

const THINKING_DELTA_FLUSH_INTERVAL_MS = 100;
const THINKING_DELTA_FLUSH_BYTES = 1_024;

export interface PiContextBudgetDiagnostics {
  readonly outcome: ContextBudgetDecision["outcome"];
  readonly reason?: "reserved_context_exceeds_window" | "single_atomic_entry_exceeds_budget";
  readonly tokenizerIdentity: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly systemPromptTokens: number;
  readonly toolSchemaTokens: number;
  readonly additionalFixedInputTokens: number;
  readonly outputReserveTokens: number;
  readonly recoveryMarginTokens: number;
  readonly safetyMarginTokens: number;
  readonly providerOverheadTokens: number;
  readonly availableHistoryTokens: number;
  readonly activeEntryTokens?: number;
  readonly requiredTokens?: number;
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
  activeAgentMessageCount: number;
  activeSessionEntryCount: number;
  pendingMessageCount: number;
  contextBudget: Readonly<PiContextBudgetDiagnostics>;
}

export interface PiSessionController {
  prompt(text: string, images?: readonly ImageContent[]): Promise<void>;
  steer(text: string, images?: readonly ImageContent[]): Promise<void>;
  followUp(text: string, images?: readonly ImageContent[]): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: RuntimeAgentEvent) => void): () => void;
  getDiagnostics(): Readonly<PiSessionDiagnostics>;
}

export class ContextBudgetAdmissionError extends Error {
  readonly code = "CONTEXT_TOO_LARGE" as const;
  readonly outcome = "context_too_large" as const;
  readonly action = "rebuild_context" as const;

  constructor(readonly reason: "reserved_context_exceeds_window" | "active_history_would_change") {
    super("CONTEXT_TOO_LARGE");
    this.name = "ContextBudgetAdmissionError";
  }
}

/** Sandbox 数据面熔断后由 Provider 同步入口携带回 Worker，不能伪装成模型故障。 */
export class SandboxToolCircuitOpenError extends Error {
  readonly code = "SANDBOX_FAILED" as const;

  constructor() {
    super("SANDBOX_FAILED");
    this.name = "SandboxToolCircuitOpenError";
  }
}

class ProviderBindingDriftError extends Error {
  readonly code = "PROVIDER_BINDING_DRIFT" as const;

  constructor() {
    super("PROVIDER_BINDING_DRIFT");
    this.name = "ProviderBindingDriftError";
  }
}

class DeferredProviderFailure {
  readonly #failures = new Map<
    number,
    ContextBudgetAdmissionError | ProviderBindingDriftError | SandboxToolCircuitOpenError
  >();
  #activeGeneration: number | undefined;

  begin(generation: number): void {
    if (this.#activeGeneration !== undefined) throw new Error("PI_SESSION_TRANSACTION_ACTIVE");
    this.#activeGeneration = generation;
  }

  reject<T>(
    failure: ContextBudgetAdmissionError | ProviderBindingDriftError | SandboxToolCircuitOpenError,
  ): T {
    const generation = this.#activeGeneration;
    if (generation === undefined) throw new ProviderBindingDriftError();
    if (!this.#failures.has(generation)) this.#failures.set(generation, failure);
    throw failure;
  }

  consume(
    generation: number,
  ):
    | ContextBudgetAdmissionError
    | ProviderBindingDriftError
    | SandboxToolCircuitOpenError
    | undefined {
    const failure = this.#failures.get(generation);
    this.#failures.delete(generation);
    return failure;
  }

  end(generation: number): void {
    this.#failures.delete(generation);
    if (this.#activeGeneration === generation) this.#activeGeneration = undefined;
  }
}

class PiSessionControllerImpl implements PiSessionController {
  readonly #session: PiSessionPort;
  readonly #diagnostics: () => PiSessionDiagnostics;
  readonly #admitInput: (text: string) => void;
  readonly #providerFailure: DeferredProviderFailure;
  readonly #checkpoint: () => {
    readonly leafId: string | null;
    readonly messages: readonly unknown[];
  };
  readonly #rollback: (checkpoint: {
    readonly leafId: string | null;
    readonly messages: readonly unknown[];
  }) => void;
  #activeGeneration: number | undefined;
  #activeTransaction:
    | {
        readonly generation: number;
        readonly completion: Promise<void>;
        readonly resolve: () => void;
      }
    | undefined;
  #nextGeneration = 1;

  constructor(
    session: PiSessionPort,
    diagnostics: () => PiSessionDiagnostics,
    admitInput: (text: string) => void,
    providerFailure: DeferredProviderFailure,
    checkpoint: () => { readonly leafId: string | null; readonly messages: readonly unknown[] },
    rollback: (checkpoint: {
      readonly leafId: string | null;
      readonly messages: readonly unknown[];
    }) => void,
  ) {
    this.#session = session;
    this.#diagnostics = diagnostics;
    this.#admitInput = admitInput;
    this.#providerFailure = providerFailure;
    this.#checkpoint = checkpoint;
    this.#rollback = rollback;
  }

  async prompt(text: string, images: readonly ImageContent[] = []): Promise<void> {
    if (this.#activeGeneration !== undefined) throw new Error("PI_SESSION_TRANSACTION_ACTIVE");
    this.#admitInput(text);
    await this.#runTransactional(() =>
      this.#session.prompt(text, images.length === 0 ? undefined : { images: [...images] }),
    );
  }

  async steer(text: string, images: readonly ImageContent[] = []): Promise<void> {
    if (!this.#session.isStreaming) throw new Error("PI_SESSION_NOT_ACTIVE");
    this.#admitInput(text);
    await this.#session.steer(text, [...images]);
  }

  async followUp(text: string, images: readonly ImageContent[] = []): Promise<void> {
    if (!this.#session.isStreaming) throw new Error("PI_SESSION_NOT_ACTIVE");
    this.#admitInput(text);
    await this.#session.followUp(text, [...images]);
  }

  async #runTransactional(action: () => Promise<void>): Promise<void> {
    const generation = this.#nextGeneration++;
    this.#providerFailure.begin(generation);
    this.#activeGeneration = generation;
    let resolveCompletion: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    this.#activeTransaction = {
      generation,
      completion,
      resolve: resolveCompletion,
    };
    try {
      const checkpoint = this.#checkpoint();
      try {
        await action();
      } catch (error) {
        const providerFailure = this.#providerFailure.consume(generation);
        if (providerFailure) {
          this.#rollback(checkpoint);
          throw providerFailure;
        }
        throw error;
      }
      const providerFailure = this.#providerFailure.consume(generation);
      if (providerFailure) {
        this.#rollback(checkpoint);
        throw providerFailure;
      }
    } finally {
      this.#providerFailure.end(generation);
      if (this.#activeGeneration === generation) this.#activeGeneration = undefined;
      if (this.#activeTransaction?.generation === generation) {
        const transaction = this.#activeTransaction;
        this.#activeTransaction = undefined;
        transaction.resolve();
      }
    }
  }

  async abort(): Promise<void> {
    // 只捕获调用 abort 时的 transaction；之后启动的新事务不属于本次同步屏障。
    const transaction = this.#activeTransaction;
    try {
      await this.#session.abort();
    } finally {
      await transaction?.completion;
    }
  }

  dispose(): void {
    this.#session.dispose();
  }

  subscribe(listener: (event: RuntimeAgentEvent) => void): () => void {
    let thinkingBuffer = "";
    let thinkingFlushTimer: ReturnType<typeof setTimeout> | undefined;
    let subscribed = true;
    const flushThinking = () => {
      if (thinkingFlushTimer !== undefined) {
        clearTimeout(thinkingFlushTimer);
        thinkingFlushTimer = undefined;
      }
      if (!subscribed || thinkingBuffer.length === 0) return;
      const delta = thinkingBuffer;
      thinkingBuffer = "";
      listener({ type: "thinking.delta", delta });
    };
    const scheduleThinkingFlush = () => {
      thinkingFlushTimer ??= setTimeout(flushThinking, THINKING_DELTA_FLUSH_INTERVAL_MS);
    };
    const unsubscribe = this.#session.subscribe((event) => {
      const mapped = mapPiEvent(event);
      if (!mapped) return;
      if (mapped.type === "thinking.delta") {
        thinkingBuffer += mapped.delta;
        if (new TextEncoder().encode(thinkingBuffer).byteLength >= THINKING_DELTA_FLUSH_BYTES) {
          flushThinking();
        } else {
          scheduleThinkingFlush();
        }
        return;
      }
      // thinking_end、message_end 和 turn_end 都必须先发布残余增量，再发布自己的终态。
      flushThinking();
      listener(mapped);
    });
    return () => {
      subscribed = false;
      if (thinkingFlushTimer !== undefined) clearTimeout(thinkingFlushTimer);
      thinkingFlushTimer = undefined;
      thinkingBuffer = "";
      unsubscribe();
    };
  }

  getDiagnostics(): Readonly<PiSessionDiagnostics> {
    return Object.freeze(this.#diagnostics());
  }
}

const UTF8_BYTE_TOKENIZER = Object.freeze<TokenizerPort>({
  identity: "utf8-byte-upper-bound-v1",
  countTokens: Object.freeze((text: string) => new TextEncoder().encode(text).byteLength),
});
const TRUSTED_MODEL_CAPABILITIES = new WeakMap<
  object,
  Readonly<{ modelRuntime: ModelRuntime; registeredCompatibilityHash: string }>
>();
export interface TrustedPiModelContextCapability {
  readonly model: Model<Api>;
  readonly descriptor: ModelBudgetDescriptor;
  readonly tokenizer: TokenizerPort;
  readonly tokenizerProbe: number;
}

/** Provider/model registry 的唯一绑定入口；Session 不接受独立 descriptor 或裸 tokenizer。 */
export function bindTrustedPiModelContextCapability(
  modelRuntime: ModelRuntime,
  model: Model<Api>,
  tokenizer?: TrustedModelTokenizerCapability,
): TrustedPiModelContextCapability {
  if (tokenizer !== undefined && !isTrustedModelTokenizerCapability(tokenizer)) {
    throw new TypeError("公开绑定入口不接受外部 tokenizer");
  }
  return bindModelContextCapability(modelRuntime, model, tokenizer ?? UTF8_BYTE_TOKENIZER);
}

/** @internal 仅供本包测试构造极端预算；未从包入口导出。 */
export function bindTestingPiModelContextCapability(
  modelRuntime: ModelRuntime,
  model: Model<Api>,
  tokenizer: TokenizerPort,
): TrustedPiModelContextCapability {
  return bindModelContextCapability(modelRuntime, model, tokenizer);
}

function bindModelContextCapability(
  modelRuntime: ModelRuntime,
  model: Model<Api>,
  selected: TokenizerPort,
): TrustedPiModelContextCapability {
  const registeredModel = modelRuntime.getModel(model.provider, model.id);
  const compatibilityHash = modelCompatibilityHash(model);
  if (
    registeredModel === undefined ||
    modelCompatibilityHash(registeredModel) !== compatibilityHash
  )
    throw new TypeError("模型未绑定当前 Provider registry");
  const probe = selected.countTokens("可信探针🙂 entropy-0123456789");
  if (!selected.identity.trim() || !Number.isSafeInteger(probe) || probe <= 0)
    throw new TypeError("Provider tokenizer capability 无效");
  const modelSnapshot = freezeModelSnapshot(model);
  const descriptor = Object.freeze({
    modelId: model.id,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    compatibilityHash,
  });
  // 保存探针结果而非只在绑定时检查；Provider 注册表若在运行中替换 tokenizer，必须失败关闭。
  const capability = Object.freeze({
    model: modelSnapshot,
    descriptor,
    tokenizer: selected,
    tokenizerProbe: probe,
  });
  TRUSTED_MODEL_CAPABILITIES.set(
    capability,
    Object.freeze({
      modelRuntime,
      registeredCompatibilityHash: modelCompatibilityHash(registeredModel),
    }),
  );
  return capability;
}

export interface CreateSafePiSessionOptions {
  model: Model<Api>;
  modelContext: TrustedPiModelContextCapability;
  modelRuntime: ModelRuntime;
  /** 固定 Sandbox 只供测试和独立 smoke；生产 Worker 使用按需准备能力。 */
  sandbox?: SandboxHandle;
  prepareSandboxTool?: SandboxToolHandleProvider["prepareSandboxTool"];
  /** Tenant/Skill/User 只能进入低信任数据分区，不能直接替换系统 Harness。 */
  untrustedPromptContent?: RuntimePromptInput["untrusted"];
  /** 只接受 Worker 从 RunSkillSnapshot 投影出的名称与一句描述。 */
  availableSkills?: readonly AvailableSkillPromptInput[];
  /** 内部兼容身份；不进入模型可见 AVAILABLE_SKILLS。 */
  skillSnapshotDigest?: string;
  /** 显式 Slash/结构化调用在首个模型请求前由后端读取并固定。 */
  explicitSkillInstruction?: Readonly<{
    readonly name: string;
    readonly version: string;
    readonly digest: string;
    readonly modelText: string;
  }>;
  /** 从既有 durable invocation 恢复；正文仍由后端按固定版本重新校验读取。 */
  recoveredSkillInstructions?: readonly Readonly<{
    readonly name: string;
    readonly version: string;
    readonly digest: string;
    readonly modelText: string;
  }>[];
  /** 固定注册 skill schema；未配置时只返回稳定的服务不可用结果。 */
  skillToolExecutor?: SkillPiToolExecutorPort;
  /** Run 级 Todo 写入器；生产 Session 必须提供，独立适配器测试可省略。 */
  todoWriteToolExecutor?: TodoWritePiToolExecutorPort;
  rolloutProjection?: ControlledRolloutProjection;
  /** Thread 级历史只接受 Runtime 从持久事实重建的窄协议，不接受客户端 messages。 */
  threadActiveHistory?: ThreadActiveHistoryV1;
  /** 生产 Tool Router 在每次 Sandbox 工具执行前回到 DB 重验双栅栏。 */
  authorizeToolEffect: SandboxToolEffectAuthorizer["authorizeToolEffect"];
  /** 只有生产装配提供真实交付依赖时才注册。 */
  deliverFileToolRouter?: DeliverFilePiToolExecutorPort;
  /** 必须绑定当前 Tenant/Attempt 的 durable Observation recorder；生产缺失时拒绝创建 Session。 */
  createToolObservationRecorder: Parameters<typeof createObservedSandboxTools>[2];
  /** durable Tool 配对失败后，在 Pi 发起下一次 Provider 请求前同步失败关闭。 */
  assertModelRequestAllowed?: () => void;
  /** Runtime 独占的 turn_end 安全点；Pi 自带 compaction 仍保持关闭。 */
  prepareNextTurnHistory?: (
    event: Extract<RuntimeAgentEvent, { type: "turn.completed" }>,
  ) => Promise<ThreadActiveHistoryV1 | undefined>;
  /** 每次真实 Provider stream 创建前进入；适配器不依赖具体诊断实现。 */
  withProviderInvocation?<T>(operation: () => T): T;
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

export async function createSafePiSession(
  options: CreateSafePiSessionOptions,
): Promise<PiSessionController> {
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

  const material = buildSafeSessionMaterial(options);
  const { customTools, builtPrompt } = material;
  const budget = assessSafePiSessionContext(options, material);
  let latestContextBudgetDecision = budget;
  if (budget.outcome !== "ready") {
    throw new ContextBudgetAdmissionError("reserved_context_exceeds_window");
  }
  const activeProjection = selectActiveProjection(options.rolloutProjection, budget.activeEntries);
  const resourceLoader = new EmptyResourceLoader(builtPrompt.systemPrompt);
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(LOGICAL_WORKSPACE);
  for (const entry of builtPrompt.contextEntries) {
    sessionManager.appendCustomMessageEntry(entry.customType, entry.content, false, entry.source);
  }
  for (const instruction of options.recoveredSkillInstructions ?? []) {
    sessionManager.appendCustomMessageEntry(
      "runtime.skill_instruction.v1",
      instruction.modelText,
      false,
      {
        name: instruction.name,
        version: instruction.version,
        digest: instruction.digest,
        recovered: true,
      },
    );
  }
  if (options.explicitSkillInstruction !== undefined) {
    sessionManager.appendCustomMessageEntry(
      "runtime.skill_instruction.v1",
      options.explicitSkillInstruction.modelText,
      false,
      {
        name: options.explicitSkillInstruction.name,
        version: options.explicitSkillInstruction.version,
        digest: options.explicitSkillInstruction.digest,
      },
    );
  }
  let activeThreadHistory = options.threadActiveHistory;
  if (activeThreadHistory !== undefined) {
    assertThreadActiveHistory(activeThreadHistory);
    for (const message of providerVisibleThreadHistoryMessages(activeThreadHistory.messages)) {
      sessionManager.appendMessage(toPiHistoryMessage(message));
    }
  }
  const projectedContext = formatRolloutProjection(activeProjection);
  if (projectedContext !== undefined) {
    sessionManager.appendCustomMessageEntry(
      "runtime.controlled_rollout_projection.v1",
      projectedContext,
      false,
      { checkpointId: activeProjection?.checkpointId },
    );
  }
  const providerFailure = new DeferredProviderFailure();
  const providerBinding = await resolveProviderBinding(options);
  const { session } = await createAgentSession({
    // Pi 会按宿主平台规范化 cwd；本 Runtime 禁用其全部文件/命令内建工具，实际 I/O 只经
    // 受控的 CubeSandbox 自定义工具执行，因此该值仅是 Session 的逻辑标签，不能用于宿主 I/O。
    cwd: LOGICAL_WORKSPACE,
    model: options.modelContext.model,
    modelRuntime: providerGatedRuntime(
      options,
      providerBinding,
      providerFailure,
      material.assertModelRequestAllowed,
      (decision) => {
        latestContextBudgetDecision = decision;
      },
    ),
    thinkingLevel: "off",
    sessionManager,
    settingsManager,
    resourceLoader,
    customTools,
    // 双重白名单：即便 Pi 将来新增默认工具，也不会把宿主机工具暴露给模型。
    noTools: "all",
    tools: [
      ...SANDBOX_TOOL_NAMES,
      "skill",
      ...(options.todoWriteToolExecutor === undefined ? [] : ["todo_write"]),
      ...(options.deliverFileToolRouter === undefined ? [] : ["deliver_file"]),
    ],
    excludeTools: ["bash", "grep", "find", "ls"],
  });
  assertPiSessionCapabilityManifest({
    readTools: () => session.agent.state.tools,
    expected: builtPrompt.manifest,
    dispose: () => session.dispose(),
  });
  if (options.prepareNextTurnHistory !== undefined) {
    const previousPrepareNextTurn = session.agent.prepareNextTurnWithContext;
    session.agent.prepareNextTurnWithContext = async (turn, signal) => {
      const previous = await previousPrepareNextTurn?.(turn, signal);
      const mapped = mapPiEvent({
        type: "turn_end",
        message: turn.message,
        toolResults: turn.toolResults,
      });
      if (mapped?.type !== "turn.completed") throw new TypeError("Pi turn 安全点事件无效");
      const replacement = await options.prepareNextTurnHistory?.(mapped);
      if (replacement === undefined) return previous;
      assertThreadActiveHistory(replacement);
      if (
        activeThreadHistory !== undefined &&
        replacement.throughSequence < activeThreadHistory.throughSequence
      ) {
        throw new TypeError("Thread Active History cursor 回退");
      }
      const messages = providerVisibleThreadHistoryMessages(replacement.messages).map(
        toPiHistoryMessage,
      );
      session.agent.state.messages = messages;
      activeThreadHistory = replacement;
      const previousContext = previous?.context ?? turn.context;
      return {
        ...previous,
        context: { ...previousContext, messages },
      };
    };
  }

  // 对外只返回窄能力对象；AgentSession（含 compact）保留在闭包和 #private 字段内。
  return new PiSessionControllerImpl(
    session,
    () => ({
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
      activeAgentMessageCount: session.agent.state.messages.length,
      activeSessionEntryCount: session.sessionManager.buildContextEntries().length,
      pendingMessageCount: session.pendingMessageCount,
      contextBudget: contextBudgetDiagnostics(latestContextBudgetDecision),
    }),
    (text) =>
      assertCurrentInputFits(
        activeThreadHistory === undefined
          ? options
          : { ...options, threadActiveHistory: activeThreadHistory },
        material,
        activeProjection,
        [],
        text,
        (decision) => {
          latestContextBudgetDecision = decision;
        },
      ),
    providerFailure,
    () => ({
      leafId: session.sessionManager.getLeafId(),
      messages: session.agent.state.messages.slice(),
    }),
    (checkpoint) => {
      session.clearQueue();
      session.agent.state.messages = [
        ...checkpoint.messages,
      ] as typeof session.agent.state.messages;
      if (checkpoint.leafId === null) session.sessionManager.resetLeaf();
      else session.sessionManager.branch(checkpoint.leafId);
    },
  );
}

/**
 * 恢复兼容身份只能由本次实际 Model、可信 Prompt Builder、真实 Tool Schema 与 Skill 分区派生。
 * 调用方不能自行传入“期望摘要”来绕过数据库的兼容判断。
 */
export function deriveSafePiSessionCompatibility(
  options: CreateSafePiSessionOptions,
): RolloutCompatibilityIdentity {
  const material = buildSafeSessionMaterial(options);
  const { builtPrompt } = material;
  const budget = assessSafePiSessionContext(options, material);
  const model = options.model;
  return Object.freeze({
    modelId: model.id,
    modelCompatibilityHash: modelCompatibilityHash(model),
    // 预算策略是 prompt 可见历史窗口的协议组成部分，必须进入恢复兼容身份。
    promptPolicyHash: digestProtocolValue({
      schemaVersion: builtPrompt.schemaVersion,
      version: builtPrompt.version,
      systemPrompt: builtPrompt.systemPrompt,
      contextBudgetPolicyHash: budget.policy.policyHash,
    }),
    toolSchemaHash: digestProtocolValue(builtPrompt.manifest),
    skillManifestHash: digestProtocolValue({
      schemaVersion: 1,
      untrustedContextEntries: builtPrompt.contextEntries
        .filter((entry) => entry.source.kind === "skill")
        .map((entry) => ({
          ordinal: entry.source.ordinal,
          publicAlias: entry.source.publicAlias,
          contentDigest: entry.source.contentDigest,
        })),
      availableEntries: [...(options.availableSkills ?? [])].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      ),
      snapshotDigest: options.skillSnapshotDigest ?? null,
      explicitInstruction:
        options.explicitSkillInstruction === undefined
          ? null
          : {
              name: options.explicitSkillInstruction.name,
              version: options.explicitSkillInstruction.version,
              digest: options.explicitSkillInstruction.digest,
            },
      recoveredInstructions: (options.recoveredSkillInstructions ?? []).map((instruction) => ({
        name: instruction.name,
        version: instruction.version,
        digest: instruction.digest,
      })),
    }),
  });
}

/**
 * 在创建 Pi Session 前评估模型实际 metadata 与可信 prompt/tool schema；纯决策不改变事实。
 * Projection 已被恢复器验证过工具配对；预算按最终格式化文本逐项计入，不能漏算低信任工具回执。
 */
export function assessSafePiSessionContext(
  options: CreateSafePiSessionOptions,
  material = buildSafeSessionMaterial(options),
  sessionInputs: readonly string[] = [],
  priorOutputReserveTokens = 0,
): ContextBudgetDecision {
  assertTrustedModelCapability(options);
  const { builtPrompt } = material;
  const projectionHeader = projectionProtocolHeader(options.rolloutProjection);
  return decideModelAwareContextBudget({
    model: options.modelContext.descriptor,
    trustedSystemPrompt: builtPrompt.systemPrompt,
    toolSchema: material.serializedToolDefinitions,
    additionalFixedInputs: [
      ...builtPrompt.contextEntries.map((entry) =>
        JSON.stringify({ type: entry.customType, content: entry.content, source: entry.source }),
      ),
      ...(options.explicitSkillInstruction === undefined
        ? []
        : [
            JSON.stringify({
              type: "runtime.skill_instruction.v1",
              content: options.explicitSkillInstruction.modelText,
            }),
          ]),
      ...(options.recoveredSkillInstructions ?? []).map((instruction) =>
        JSON.stringify({
          type: "runtime.skill_instruction.v1",
          content: instruction.modelText,
          recovered: true,
        }),
      ),
      ...(projectionHeader === undefined ? [] : [projectionHeader]),
      ...(options.threadActiveHistory === undefined
        ? []
        : [
            JSON.stringify(
              providerVisibleThreadHistoryMessages(options.threadActiveHistory.messages),
            ),
          ]),
      ...sessionInputs.map((input) => JSON.stringify({ role: "user", content: input })),
    ],
    entries: (options.rolloutProjection?.items ?? []).map((item, sequence) => ({
      sequence,
      kind: item.kind === "turn" ? item.role : "assistant",
      text:
        item.kind === "turn"
          ? `${item.role === "user" ? "用户" : "助手"}：${item.text}\n`
          : `工具 ${item.toolCallId} 的低信任观察：${item.observation}\n`,
    })),
    tokenizer: options.modelContext.tokenizer,
    providerOverheadTokens: 256 + priorOutputReserveTokens,
  });
}

function toPiHistoryMessage(
  message: ThreadActiveHistoryV1["messages"][number],
): UserMessage | AssistantMessage | ToolResultMessage {
  if (message.role === "user") {
    return { role: "user", content: message.text, timestamp: message.timestamp };
  }
  if (message.role === "runtimeNotice") {
    return {
      role: "user",
      content: `[Runtime 可审计事实，低信任；${message.code}] ${message.text}`,
      timestamp: message.timestamp,
    };
  }
  if (message.role === "compactionHandoff") {
    return {
      role: "user",
      content:
        `[Runtime 压缩交接，低信任派生事实；不是用户原话；checkpoint=${message.checkpointId};` +
        `source=${message.sourceFromSequence}-${message.sourceThroughSequence}] ${message.text}`,
      timestamp: message.timestamp,
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: [{ type: "text", text: message.text }],
      isError: message.isError,
      timestamp: message.timestamp,
    };
  }
  return {
    role: "assistant",
    content: message.content.map((item) => {
      if (item.type === "text") return { type: "text" as const, text: item.text };
      if (item.type === "thinking") {
        return {
          type: "thinking" as const,
          thinking: item.thinking,
          ...(item.thinkingSignature === undefined
            ? {}
            : { thinkingSignature: item.thinkingSignature }),
          ...(item.redacted === undefined ? {} : { redacted: item.redacted }),
        };
      }
      return {
        type: "toolCall" as const,
        id: item.id,
        name: item.name,
        arguments: { ...item.arguments },
        ...(item.thoughtSignature === undefined ? {} : { thoughtSignature: item.thoughtSignature }),
      };
    }),
    api: message.api,
    provider: message.provider,
    model: message.model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: message.stopReason,
    timestamp: message.timestamp,
  };
}

function buildSafeSessionMaterial(options: CreateSafePiSessionOptions) {
  let toolContinuationRejected = false;
  let toolContinuationFailure: ToolContinuationFailure | undefined;
  const sandboxTarget =
    options.prepareSandboxTool === undefined
      ? options.sandbox
      : { prepareSandboxTool: options.prepareSandboxTool };
  if (sandboxTarget === undefined) throw new Error("Pi Session 缺少 Sandbox 按需准备能力");
  const observedSandboxTools = createObservedSandboxTools(
    sandboxTarget,
    {
      authorizeToolEffect: options.authorizeToolEffect,
    },
    options.createToolObservationRecorder,
    (failure) => {
      toolContinuationRejected = true;
      toolContinuationFailure ??= failure;
    },
  );
  const customTools = [
    ...observedSandboxTools.tools,
    createSkillPiTool(
      options.skillToolExecutor ?? unavailableSkillToolExecutor,
      observedSandboxTools.recordControlledReceipt,
      () => {
        toolContinuationRejected = true;
      },
    ),
    ...(options.todoWriteToolExecutor === undefined
      ? []
      : [
          createTodoWritePiTool(
            options.todoWriteToolExecutor,
            observedSandboxTools.recordControlledReceipt,
            () => {
              toolContinuationRejected = true;
            },
          ),
        ]),
    ...(options.deliverFileToolRouter === undefined
      ? []
      : [
          createDeliverFilePiTool(
            options.deliverFileToolRouter,
            observedSandboxTools.recordControlledReceipt,
            () => {
              toolContinuationRejected = true;
            },
          ),
        ]),
  ];
  // 能力清单从即将传给 Pi 的同一组真实工具派生，不能维护第二份易漂移的硬编码列表。
  const builtPrompt = buildRuntimeSystemPrompt({
    schemaVersion: 1,
    capabilities: customTools.map((tool) => ({
      id: tool.name,
      description: tool.description,
      inputSchemaDigest: digestCanonicalToolInputSchema(tool.parameters),
    })),
    availableSkills: options.availableSkills ?? [],
    untrusted: options.untrustedPromptContent ?? { tenant: [], skill: [], user: [] },
  });
  const serializedToolDefinitions = JSON.stringify(
    customTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: canonicalSchema(tool.parameters, new WeakSet<object>()),
    })),
  );
  return {
    customTools,
    builtPrompt,
    serializedToolDefinitions,
    assertModelRequestAllowed: () => {
      if (toolContinuationRejected) {
        if (toolContinuationFailure === "SANDBOX_FAILED") {
          throw new SandboxToolCircuitOpenError();
        }
        throw new Error("Tool durable 失败回执完成后禁止继续模型轮次");
      }
    },
  };
}

const unavailableSkillToolExecutor: SkillPiToolExecutorPort = Object.freeze({
  async invoke(): Promise<string> {
    throw new Error("SKILL_CONTENT_UNAVAILABLE");
  },
  projectError: () =>
    Object.freeze({
      status: "failed" as const,
      code: "SKILL_CONTENT_UNAVAILABLE",
      message: "Skill 内容暂时不可用",
      correctable: false,
      fatal: false,
    }),
});

function modelCompatibilityHash(model: Model<Api>) {
  return digestProtocolValue({
    id: model.id,
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    headers: model.headers,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: model.compat,
  });
}

interface ProviderBinding {
  readonly provider: Provider;
  readonly streamSimple: Provider["streamSimple"];
  readonly model: Model<Api>;
  readonly routeDigest: string;
  readonly auth: Readonly<{
    apiKey?: string;
    headers?: Readonly<Record<string, string | null>>;
    env?: Readonly<Record<string, string>>;
  }>;
}

async function resolveProviderBinding(
  options: CreateSafePiSessionOptions,
): Promise<ProviderBinding> {
  assertTrustedModelCapability(options);
  const provider = options.modelRuntime.getProvider(options.model.provider);
  const resolution = await options.modelRuntime.getAuth(options.modelContext.model);
  if (provider === undefined || resolution === undefined) throw new ProviderBindingDriftError();
  const model = freezeModelSnapshot(
    resolution.auth.baseUrl === undefined
      ? options.modelContext.model
      : { ...options.modelContext.model, baseUrl: resolution.auth.baseUrl },
  );
  const auth = Object.freeze({
    ...(resolution.auth.apiKey === undefined ? {} : { apiKey: resolution.auth.apiKey }),
    ...(resolution.auth.headers === undefined
      ? {}
      : { headers: freezeProtocolRecord(resolution.auth.headers) }),
    ...(resolution.env === undefined ? {} : { env: freezeProtocolRecord(resolution.env) }),
  });
  return Object.freeze({
    provider,
    streamSimple: provider.streamSimple,
    model,
    routeDigest: resolvedRouteDigest(provider, model, auth),
    auth,
  });
}

function resolvedRouteDigest(
  provider: Provider,
  model: Model<Api>,
  auth: ProviderBinding["auth"],
): string {
  return digestProtocolValue({
    providerId: provider.id,
    model: modelCompatibilityHash(model),
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
  });
}

function freezeProtocolRecord<T extends Record<string, unknown>>(value: T): Readonly<T> {
  return Object.freeze(structuredClone(value));
}

function assertResolvedProviderBinding(expected: ProviderBinding, current: ProviderBinding): void {
  if (
    current.provider !== expected.provider ||
    current.streamSimple !== expected.streamSimple ||
    current.routeDigest !== expected.routeDigest
  )
    throw new ProviderBindingDriftError();
}

/** 每次 Pi 真正请求 Provider 前解析并冻结路由，再按最终 Context 计量。 */
function providerGatedRuntime(
  options: CreateSafePiSessionOptions,
  binding: ProviderBinding,
  providerFailure: DeferredProviderFailure,
  assertInternalModelRequestAllowed: () => void,
  onContextBudgetDecision: (decision: ContextBudgetDecision) => void,
): ModelRuntime {
  const runtime = options.modelRuntime;
  return new Proxy(runtime, {
    get(target, property, receiver) {
      if (property === "streamSimple") {
        return (
          model: Model<Api>,
          context: Context,
          streamOptions?: SimpleStreamOptions & {
            transformHeaders?: (
              headers: Record<string, string | null>,
            ) => Promise<Record<string, string | null>>;
            env?: Record<string, string>;
          },
        ) =>
          lazyStream(model, async () => {
            try {
              // Tool executor 内不能 await 当前 Session 的 abort，否则会与本轮完成屏障互相等待；
              // 因此在下一模型轮次的同步入口再次检查 durable Observation 恢复闩锁。
              assertInternalModelRequestAllowed();
              options.assertModelRequestAllowed?.();
              assertTrustedModelCapability(options);
              if (model !== options.modelContext.model) throw new ProviderBindingDriftError();
              const { transformHeaders, apiKey, headers, env, ...dynamicOptions } =
                streamOptions ?? {};
              if (apiKey !== undefined || headers !== undefined || env !== undefined)
                throw new ProviderBindingDriftError();
              const beforeTransform = await resolveProviderBinding(options);
              assertResolvedProviderBinding(binding, beforeTransform);
              const transformedHeaders = transformHeaders
                ? await transformHeaders({ ...(beforeTransform.auth.headers ?? {}) })
                : beforeTransform.auth.headers;
              // transformHeaders 是唯一异步窗口；其后重新解析，再同步调用已捕获的实现。
              const finalBinding = await resolveProviderBinding(options);
              assertResolvedProviderBinding(binding, finalBinding);
              const decision = decideModelAwareContextBudget({
                model: options.modelContext.descriptor,
                trustedSystemPrompt: context.systemPrompt ?? "",
                toolSchema: JSON.stringify(context.tools ?? []),
                additionalFixedInputs: context.messages.map((message) => JSON.stringify(message)),
                entries: [],
                tokenizer: options.modelContext.tokenizer,
              });
              onContextBudgetDecision(decision);
              if (decision.outcome !== "ready")
                return providerFailure.reject(
                  new ContextBudgetAdmissionError("reserved_context_exceeds_window"),
                );
              const preparedOptions = Object.freeze({
                ...dynamicOptions,
                ...(binding.auth.apiKey === undefined ? {} : { apiKey: binding.auth.apiKey }),
                ...(transformedHeaders === undefined
                  ? {}
                  : { headers: freezeProtocolRecord(transformedHeaders) }),
                ...(binding.auth.env === undefined ? {} : { env: binding.auth.env }),
              });
              const invoke = () =>
                binding.streamSimple.call(
                  binding.provider,
                  binding.model,
                  context,
                  preparedOptions,
                );
              return options.withProviderInvocation === undefined
                ? invoke()
                : options.withProviderInvocation(invoke);
            } catch (error) {
              if (
                error instanceof ContextBudgetAdmissionError ||
                error instanceof SandboxToolCircuitOpenError
              ) {
                return providerFailure.reject(error);
              }
              return providerFailure.reject(
                error instanceof ProviderBindingDriftError
                  ? error
                  : new ProviderBindingDriftError(),
              );
            }
          });
      }
      if (property === "hasConfiguredAuth")
        return (providerId: string) =>
          providerId === binding.model.provider || runtime.hasConfiguredAuth(providerId);
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function freezeModelSnapshot(model: Model<Api>): Model<Api> {
  const clone = structuredClone(model);
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(clone);
  return clone;
}

function assertTrustedModelCapability(options: CreateSafePiSessionOptions): void {
  const binding = TRUSTED_MODEL_CAPABILITIES.get(options.modelContext);
  const liveRegisteredModel = options.modelRuntime.getModel(
    options.model.provider,
    options.model.id,
  );
  if (
    binding === undefined ||
    binding.modelRuntime !== options.modelRuntime ||
    options.modelContext.descriptor.modelId !== options.model.id ||
    options.modelContext.descriptor.contextWindow !== options.model.contextWindow ||
    options.modelContext.descriptor.maxOutputTokens !== options.model.maxTokens ||
    options.modelContext.descriptor.compatibilityHash !== modelCompatibilityHash(options.model) ||
    liveRegisteredModel === undefined ||
    binding.registeredCompatibilityHash !== modelCompatibilityHash(liveRegisteredModel) ||
    options.modelContext.descriptor.compatibilityHash !==
      modelCompatibilityHash(liveRegisteredModel) ||
    options.modelContext.tokenizer.countTokens("可信探针🙂 entropy-0123456789") !==
      options.modelContext.tokenizerProbe
  )
    throw new TypeError("Model Context capability 未绑定当前可信 Provider model");
}

function selectActiveProjection(
  projection: ControlledRolloutProjection | undefined,
  entries: readonly { sequence: number }[],
): ControlledRolloutProjection | undefined {
  if (projection === undefined) return undefined;
  const items = entries
    .map((entry) => projection.items[entry.sequence])
    .filter((item) => item !== undefined);
  return Object.freeze({ ...projection, items: Object.freeze(items) });
}

function assertCurrentInputFits(
  options: CreateSafePiSessionOptions,
  material: ReturnType<typeof buildSafeSessionMaterial>,
  activeProjection: ControlledRolloutProjection | undefined,
  admittedInputs: readonly string[],
  text: string,
  onContextBudgetDecision: (decision: ContextBudgetDecision) => void,
): void {
  // Pi 会保留此前每轮 user 输入和 assistant 输出。assistant 文本无法在窄控制器上读取，
  // 因而为每个已接受输入额外保留一次最大输出，宁可提前拒绝也不能低估最终 Provider 请求。
  const priorOutputReserve =
    admittedInputs.length * options.modelContext.descriptor.maxOutputTokens;
  const assessed = assessSafePiSessionContext(
    activeProjection === undefined ? options : { ...options, rolloutProjection: activeProjection },
    material,
    [...admittedInputs, text],
    priorOutputReserve,
  );
  onContextBudgetDecision(assessed);
  if (
    assessed.outcome !== "ready" ||
    assessed.activeEntries.length !== (activeProjection?.items.length ?? 0)
  )
    throw new ContextBudgetAdmissionError(
      assessed.outcome === "ready"
        ? "active_history_would_change"
        : "reserved_context_exceeds_window",
    );
}

function contextBudgetDiagnostics(
  decision: ContextBudgetDecision,
): Readonly<PiContextBudgetDiagnostics> {
  const { policy } = decision;
  return Object.freeze({
    outcome: decision.outcome,
    ...(decision.outcome === "ready"
      ? { activeEntryTokens: decision.activeEntryTokens }
      : { reason: decision.reason, requiredTokens: decision.requiredTokens }),
    tokenizerIdentity: policy.tokenizerIdentity,
    contextWindow: policy.model.contextWindow,
    maxOutputTokens: policy.model.maxOutputTokens,
    systemPromptTokens: policy.systemPromptTokens,
    toolSchemaTokens: policy.toolSchemaTokens,
    additionalFixedInputTokens: policy.additionalFixedInputTokens,
    outputReserveTokens: policy.outputReserveTokens,
    recoveryMarginTokens: policy.recoveryMarginTokens,
    safetyMarginTokens: policy.safetyMarginTokens,
    providerOverheadTokens: policy.providerOverheadTokens,
    availableHistoryTokens: policy.availableHistoryTokens,
  });
}

function projectionProtocolHeader(
  projection: ControlledRolloutProjection | undefined,
): string | undefined {
  return projection === undefined || projection.items.length === 0
    ? undefined
    : `以下是 Runtime 审核并持久化的历史上下文投影（checkpoint=${projection.checkpointId}）：\n`;
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

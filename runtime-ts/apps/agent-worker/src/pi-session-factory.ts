import { normalizeRuntimeToolSelection, type RuntimeToolName } from "@hoox/protocol";
import { measureExecutionPhase } from "@hoox/domain";
import { createHash } from "node:crypto";
import type { ArtifactExecutionAuthorizationIssuerPort } from "@hoox/artifact";
import type { ScheduledTask, ScheduledTaskMutation } from "@hoox/automation";
import {
  type ControlledToolReceiptSource,
  type ToolObservationBinding,
  ToolObservationPipeline,
  type ToolObservationPolicy,
  type ToolObservationResult,
  type ToolObservationRolloutPort,
  type TraceBlobPersistencePort,
} from "@hoox/context-policy";
import {
  assertRunPersonalizationSnapshot,
  DomainError,
  sha256Digest,
  type TenantId,
  type TodoWriteCommand,
} from "@hoox/domain";
import {
  assessSafePiSessionContext,
  AutomationUpdateArgumentError,
  automationToolMutation,
  bindTrustedPiModelContextCapability,
  ContextBudgetAdmissionError,
  type AutomationUpdateToolArguments,
  type ControlledRolloutProjection,
  createSafePiSession,
  deriveSafePiSessionCompatibility,
  ModelContinuationRejectedError,
  type PiSessionController,
  providerVisibleUserInputTokens,
  type ThreadActiveHistoryV1,
  type TrustedPiModelContextCapability,
  type ToolCallingMode,
} from "@hoox/pi-adapter";
import {
  assertRunSkillSnapshot,
  digestRunSkillSnapshot,
  type RunSkillSnapshot,
  type SkillExecutionBinding,
  SkillRuntimeError,
  type SkillRuntimeService,
} from "@hoox/skill";
import type { DeliverFileToolRouterFactoryPort } from "@hoox/tool-router";
import {
  InternalTrajectoryAttemptRecorder,
  type InternalTrajectoryDiagnosticsPort,
} from "@hoox/trajectory";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { Models } from "@earendil-works/pi-ai";
import type { ModelWireTraceSession } from "./model-wire-trace.js";
import { digestCanonical } from "./mutation-protocol.js";
import type {
  AgentSessionFactoryPort,
  AgentTurnOutcome,
  AgentUserInput,
  ModelUsageMetricsPort,
  PreparedAgentUserInput,
  SandboxSessionRef,
  UserInputAttachmentReference,
  WorkerAgentSessionPort,
} from "./ports.js";

const AGENT_CONTROL_ERROR_MESSAGES = Object.freeze({
  AGENT_NOT_FOUND: "目标子 Agent 不存在，请检查 target 或先调用 list_agents。",
  AGENT_NOT_RUNNING: "目标子 Agent 当前没有运行中的 turn，不能执行该操作。",
  AGENT_BUSY: "目标子 Agent 正在运行，请等待或中断当前 turn 后再追加任务。",
  AGENT_CONTROL_INVALID_ARGUMENTS: "子 Agent 控制工具参数无效，请根据工具 schema 修正后重试。",
  AGENT_CAPACITY_EXCEEDED: "子 Agent 数量或并发数已达到上限，请等待现有任务结束后重试。",
  AGENT_TASK_INVALID: "子 Agent 任务不能为空或超出允许长度。",
  AGENT_TOOLS_INVALID: "子 Agent 工具清单包含不支持的工具。",
  AGENT_FORK_TURNS_INVALID: "fork_turns 必须是 none、all 或允许范围内的正整数。",
} as const);

export function projectAgentControlError(error: unknown): Readonly<{
  status: "failed";
  code: string;
  message: string;
  correctable: boolean;
  fatal: boolean;
}> {
  const internalCode = error instanceof Error ? error.message : undefined;
  const knownCode =
    internalCode !== undefined && internalCode in AGENT_CONTROL_ERROR_MESSAGES
      ? (internalCode as keyof typeof AGENT_CONTROL_ERROR_MESSAGES)
      : undefined;
  if (knownCode !== undefined) {
    return Object.freeze({
      status: "failed",
      code: knownCode,
      message: AGENT_CONTROL_ERROR_MESSAGES[knownCode],
      correctable: true,
      fatal: false,
    });
  }
  return Object.freeze({
    status: "failed",
    code: "AGENT_CONTROL_FAILED",
    message: "子 Agent 控制面暂时不可用，请稍后重试。",
    correctable: true,
    fatal: false,
  });
}
const AUTOMATION_STATE_ERROR_MESSAGES = Object.freeze({
  AUTOMATION_NOT_FOUND: "定时任务不存在，请检查 task_id 后重试。",
  AUTOMATION_INVALID_STATE: "当前定时任务状态不允许该操作，请刷新状态后重试。",
  AUTOMATION_KEY_CONFLICT: "同一工具调用已绑定不同请求，请重新发起一次操作。",
} as const);

export function projectAutomationUpdateError(error: unknown): Readonly<{
  status: "failed";
  code: string;
  message: string;
  correctable: boolean;
  fatal: boolean;
  details?: readonly { readonly field: string; readonly reason: string }[];
}> {
  if (error instanceof AutomationUpdateArgumentError) {
    return Object.freeze({
      status: "failed",
      code: error.code,
      message: "定时任务字段值无效，请按 details 修正后重试。",
      correctable: true,
      fatal: false,
      details: error.details,
    });
  }
  const internalCode = error instanceof Error ? error.message : undefined;
  if (internalCode === "AUTOMATION_NOT_AUTHORIZED") {
    return Object.freeze({
      status: "failed",
      code: internalCode,
      message: "当前会话无权管理该定时任务。",
      correctable: false,
      fatal: false,
    });
  }
  const knownCode =
    internalCode !== undefined && internalCode in AUTOMATION_STATE_ERROR_MESSAGES
      ? (internalCode as keyof typeof AUTOMATION_STATE_ERROR_MESSAGES)
      : undefined;
  if (knownCode !== undefined) {
    return Object.freeze({
      status: "failed",
      code: knownCode,
      message: AUTOMATION_STATE_ERROR_MESSAGES[knownCode],
      correctable: true,
      fatal: false,
    });
  }
  return Object.freeze({
    status: "failed",
    code: "AUTOMATION_PERSISTENCE_UNAVAILABLE",
    message: "定时任务服务暂时不可用，请稍后重试。",
    correctable: false,
    fatal: true,
  });
}
export interface PromptImageLoaderPort {
  load(input: {
    readonly tenantId: TenantId;
    readonly attachments: readonly UserInputAttachmentReference[];
  }): Promise<PreparedAgentUserInput["images"]>;
}

/**
 * Worker 的生产 Pi 绑定只返回应用层窄接口；原始 AgentSession 和 compact() 从未跨越适配层。
 * waiting 未来由 request_user_input 工具适配器产生；本阶段只实现持久 RolloutProjection 的恢复机制，
 * 再用 prompt 真正启动模型，绝不对空 Session 调 followUp。
 */
export class PiWorkerSessionFactory implements AgentSessionFactoryPort {
  readonly toolRejectionReceiptBarrier = "durable" as const;
  private readonly modelContext;

  constructor(
    private readonly model: Model<Api>,
    private readonly modelRuntime: Models,
    private readonly createObservationRecorder: (
      input: Parameters<AgentSessionFactoryPort["create"]>[0],
      outputs: ControlledToolReceiptSource,
    ) => {
      recordStarted(call: {
        readonly toolCallId: string;
        readonly toolName: string;
        readonly parentToolCallId?: string;
      }): Promise<ToolObservationResult["outcome"]>;
      record(call: {
        readonly toolCallId: string;
        readonly toolName: string;
        readonly parentToolCallId?: string;
      }): Promise<ToolObservationResult>;
    },
    private readonly artifactAuthorizationIssuer?: ArtifactExecutionAuthorizationIssuerPort,
    private readonly prepareObservationSession?: (
      input: Parameters<AgentSessionFactoryPort["create"]>[0],
      compatibility: ReturnType<typeof deriveSafePiSessionCompatibility>,
    ) => Promise<ControlledRolloutProjection | undefined>,
    private readonly modelWireTraces?: ModelWireTraceSession,
    private readonly deliverFileTools?: DeliverFileToolRouterFactoryPort,
    private readonly prepareThreadHistory?: (
      input: Parameters<AgentSessionFactoryPort["create"]>[0],
      compatibility: ReturnType<typeof deriveSafePiSessionCompatibility>,
    ) => Promise<ThreadActiveHistoryV1 | undefined>,
    private readonly prepareRuntimeCompaction?: (
      input: Parameters<AgentSessionFactoryPort["create"]>[0],
      compatibility: ReturnType<typeof deriveSafePiSessionCompatibility>,
      history: ThreadActiveHistoryV1,
      availableHistoryTokens: number,
      additionalVisibleTokens: number,
    ) => Promise<ThreadActiveHistoryV1>,
    private readonly promptImages?: PromptImageLoaderPort,
    private readonly skillRuntime?: SkillRuntimeService,
    modelContext?: TrustedPiModelContextCapability,
    private readonly internalTrajectoryDiagnostics?: InternalTrajectoryDiagnosticsPort,
    private readonly updateScheduledTask?: (input: {
      readonly tenantId: string;
      readonly threadId: string;
      readonly runId: string;
      readonly commandId: string;
      readonly mutation: ScheduledTaskMutation;
    }) => Promise<ScheduledTask>,
    private readonly modelUsageMetrics?: ModelUsageMetricsPort,
    private readonly toolCallingMode: ToolCallingMode = "native",
    private readonly enabledTools?: readonly RuntimeToolName[],
  ) {
    this.enabledTools = normalizeRuntimeToolSelection(enabledTools);
    this.modelContext = modelContext ?? bindTrustedPiModelContextCapability(modelRuntime, model);
  }

  /** 复用工具、持久化和恢复边界，只替换由 Run 固定配置决定的模型相关能力。 */
  withModel(input: {
    readonly toolCallingMode?: ToolCallingMode;
    readonly enabledTools?: readonly RuntimeToolName[];
    readonly model: Model<Api>;
    readonly modelRuntime: Models;
    readonly modelContext: TrustedPiModelContextCapability;
    readonly modelWireTraces: ModelWireTraceSession | undefined;
    readonly prepareRuntimeCompaction:
      | ((
          target: Parameters<AgentSessionFactoryPort["create"]>[0],
          compatibility: ReturnType<typeof deriveSafePiSessionCompatibility>,
          history: ThreadActiveHistoryV1,
          availableHistoryTokens: number,
          additionalVisibleTokens: number,
        ) => Promise<ThreadActiveHistoryV1>)
      | undefined;
  }): PiWorkerSessionFactory {
    return new PiWorkerSessionFactory(
      input.model,
      input.modelRuntime,
      this.createObservationRecorder,
      this.artifactAuthorizationIssuer,
      this.prepareObservationSession,
      input.modelWireTraces,
      this.deliverFileTools,
      this.prepareThreadHistory,
      input.prepareRuntimeCompaction,
      this.promptImages,
      this.skillRuntime,
      input.modelContext,
      this.internalTrajectoryDiagnostics,
      this.updateScheduledTask,
      this.modelUsageMetrics,
      input.toolCallingMode ?? this.toolCallingMode,
      input.enabledTools ?? this.enabledTools,
    );
  }

  async create(
    input: Parameters<AgentSessionFactoryPort["create"]>[0],
  ): Promise<WorkerAgentSessionPort> {
    const runtimeCallId = (providerCallId: string): string => {
      if (input.agent === undefined || input.agent.agentKind === "root") return providerCallId;
      const providerCallDigest = createHash("sha256").update(providerCallId, "utf8").digest("hex");
      return `${input.agent.agentThreadId}:${input.agent.agentTurnId}:${providerCallDigest.slice(0, 32)}`;
    };
    const measureStartup = async <T>(
      phase: Parameters<NonNullable<typeof input.startupTiming>["record"]>[0],
      operation: () => Promise<T>,
    ): Promise<T> => {
      if (input.startupTiming === undefined) return await operation();
      const startedAt = performance.now();
      try {
        return await operation();
      } finally {
        input.startupTiming.record(phase, Math.max(0, performance.now() - startedAt));
      }
    };

    const attemptWireTraces = this.modelWireTraces?.createAttempt(input.attemptId);
    const trajectoryRecorder =
      this.internalTrajectoryDiagnostics === undefined
        ? undefined
        : new InternalTrajectoryAttemptRecorder(
            {
              tenantId: input.scope.tenantId,
              threadId: input.scope.threadId,
              runId: input.scope.runId,
              attemptId: input.attemptId,
              ...(input.agent?.agentKind === "subagent"
                ? {
                    agentThreadId: input.agent.agentThreadId,
                    agentTurnId: input.agent.agentTurnId,
                  }
                : {}),
            },
            this.internalTrajectoryDiagnostics,
          );
    const wireTraceContext = Object.freeze({
      tenantId: input.scope.tenantId,
      threadId: input.scope.threadId,
      runId: input.scope.runId,
      attemptId: input.attemptId,
      ...(input.agent?.agentKind === "subagent"
        ? {
            agentThreadId: input.agent.agentThreadId,
            agentTurnId: input.agent.agentTurnId,
          }
        : {}),
    });
    const skillEnabled =
      (this.enabledTools?.includes("skill") ?? true) &&
      (input.enabledToolNames?.includes("skill") ?? true);
    const agentControl = input.agentControl;
    let attachmentSandboxPreparation: Promise<SandboxSessionRef> | undefined;
    const startAttachmentSandboxPreparation = () => {
      attachmentSandboxPreparation ??= input.ensureSandboxReady({ reason: "attachment" });
      // 附件只负责提前启动准备；真正的等待点在 Sandbox 工具执行前或本次 prompt 收口时。
      // 立即挂拒绝处理，避免 Provider 仍在运行时出现未处理的后台 Promise rejection。
      void attachmentSandboxPreparation.catch(() => undefined);
    };
    const drainAttachmentSandboxPreparation = async () => {
      if (attachmentSandboxPreparation !== undefined) {
        await attachmentSandboxPreparation;
      }
    };
    const prepareInput = async (userInput: AgentUserInput): Promise<PreparedAgentUserInput> => {
      let images: PreparedAgentUserInput["images"] = Object.freeze([]);
      if (this.model.input.includes("image") && userInput.attachments.length > 0) {
        if (this.promptImages === undefined) {
          throw new Error("视觉模型缺少当前 user turn 图片加载器");
        }
        images = await this.promptImages.load({
          tenantId: input.scope.tenantId,
          attachments: userInput.attachments,
        });
      }
      // 全部附件都已作为视觉输入直送 Provider 时不需要文件系统；其余附件提前准备 /resources，
      // 但不能阻塞首个模型请求。依赖 Sandbox 的工具仍通过 ensureSandboxReady 等待同一准备任务。
      if (images.length !== userInput.attachments.length) {
        startAttachmentSandboxPreparation();
      }
      return Object.freeze({ text: userInput.text, images: Object.freeze([...images]) });
    };
    const runRuntimeCompaction = async (
      targetInput: Parameters<AgentSessionFactoryPort["create"]>[0],
      compatibility: ReturnType<typeof deriveSafePiSessionCompatibility>,
      history: ThreadActiveHistoryV1,
      availableHistoryTokens: number,
      additionalVisibleTokens = 0,
    ) => {
      const invoke = () =>
        this.prepareRuntimeCompaction?.(
          targetInput,
          compatibility,
          history,
          availableHistoryTokens,
          additionalVisibleTokens,
        );
      const result =
        attemptWireTraces === undefined
          ? await invoke()
          : await attemptWireTraces.run(wireTraceContext, invoke);
      return result ?? history;
    };
    const startedToolCalls = new Map<string, string>();
    const ptcParents = new Map<string, string>();
    const parentBinding = (callId: string): { readonly parentToolCallId?: string } => {
      const parentToolCallId = ptcParents.get(callId);
      return parentToolCallId === undefined ? {} : { parentToolCallId };
    };
    const invalidToolCalls = new Set<string>();
    const effectAuthorizationRequested = new Set<string>();
    const sandboxPreparationRequested = new Set<string>();
    const durableToolCalls = new Set<string>();
    const rejectedToolReceipts = new Map<
      string,
      { readonly completed: Promise<void>; readonly resolve: () => void }
    >();
    let observationRecorder:
      | ReturnType<PiWorkerSessionFactory["createObservationRecorder"]>
      | undefined;
    let controller: PiSessionController | undefined;
    let observationRecoveryCode: "PERSISTENCE_UNAVAILABLE" | "IDEMPOTENCY_CONFLICT" | undefined;
    let toolEffectRejected = false;
    const skillSnapshot: RunSkillSnapshot =
      input.skillSnapshot ??
      Object.freeze({
        schemaVersion: 1 as const,
        digest: digestRunSkillSnapshot({ items: [] }),
        items: Object.freeze([]),
      });
    assertRunSkillSnapshot(skillSnapshot);
    const personalizationSnapshot =
      input.personalizationSnapshot === undefined
        ? undefined
        : assertRunPersonalizationSnapshot(input.personalizationSnapshot);
    const skillBinding: SkillExecutionBinding = Object.freeze({
      tenantId: input.scope.tenantId,
      threadId: input.scope.threadId,
      runId: input.scope.runId,
      rootRunId: input.scope.rootRunId,
      workspaceId: input.scope.workspaceId,
      ...(input.scope.baseRevisionId === undefined
        ? {}
        : { baseRevisionId: input.scope.baseRevisionId }),
      attemptId: input.attemptId,
      runClaimToken: input.fence.runClaim.token,
      runClaimEpoch: input.fence.runClaim.epoch,
      workspaceLeaseRootRunId: input.fence.workspaceLease.rootRunId,
      workspaceLeaseEpoch: input.fence.workspaceLease.epoch,
    });
    const skillRuntime = this.skillRuntime;
    const recoveredSkillInstructions =
      !skillEnabled || skillRuntime === undefined
        ? Object.freeze([])
        : await measureStartup("skill_recovery", () =>
            skillRuntime.recoverLoadedInstructions({ binding: skillBinding }),
          );
    const explicitInvocation = skillSnapshot.explicitInvocation;
    const explicitSkillInstruction =
      !skillEnabled || explicitInvocation === undefined
        ? undefined
        : await measureStartup("explicit_skill_load", () =>
            this.requireSkillRuntime().loadInstruction({
              binding: skillBinding,
              source: "explicit",
              invocationName: explicitInvocation.invocationName,
              args: explicitInvocation.args,
            }),
          );
    const recoveredForSession = recoveredSkillInstructions.filter(
      (instruction) =>
        explicitSkillInstruction === undefined ||
        instruction.name !== explicitSkillInstruction.name ||
        instruction.version !== explicitSkillInstruction.version ||
        instruction.digest !== explicitSkillInstruction.digest,
    );
    const requireObservationRecovery = (outcome?: ToolObservationResult["outcome"]) => {
      observationRecoveryCode =
        outcome === "conflict" ? "IDEMPOTENCY_CONFLICT" : "PERSISTENCE_UNAVAILABLE";
      // 立即停止本轮，避免模型在缺失 durable Tool 事实后继续发起其他副作用。
      void controller?.abort().catch(() => undefined);
    };
    const recordStartedTool = async (call: {
      readonly toolCallId: string;
      readonly toolName: string;
    }) => {
      if (
        invalidToolCalls.has(call.toolCallId) ||
        durableToolCalls.has(call.toolCallId) ||
        startedToolCalls.get(call.toolCallId) !== call.toolName
      ) {
        throw new Error("Pi 工具缺少唯一且匹配的 tool.started");
      }
      // 先占住 callId；写入结果未知时必须转恢复，不得在本 Attempt 重放。
      durableToolCalls.add(call.toolCallId);
      let recorded: ToolObservationResult["outcome"] | undefined;
      try {
        recorded = await measureExecutionPhase(
          input.phaseTiming,
          "tool_call_persist",
          async () =>
            observationRecorder?.recordStarted({ ...call, ...parentBinding(call.toolCallId) }),
          call,
        );
      } catch {
        requireObservationRecovery();
        throw new Error("Tool Rollout 前驱持久化状态未知");
      }
      if (recorded !== "recorded" && recorded !== "replayed") {
        requireObservationRecovery(recorded);
        throw new Error("Tool Rollout 前驱未能持久化");
      }
    };
    const authorizeStartedTool = async (call: {
      readonly callId: string;
      readonly toolName: string;
      readonly argsDigest: string;
    }) => {
      const startedName = startedToolCalls.get(call.callId);
      if (
        invalidToolCalls.has(call.callId) ||
        effectAuthorizationRequested.has(call.callId) ||
        startedName !== call.toolName
      ) {
        throw new Error("Pi 工具许可缺少匹配的 tool.started");
      }
      // 不删除 gate：callId 在整个 Attempt 内永久一次性，失败后的相同调用也不可重试。
      effectAuthorizationRequested.add(call.callId);
      if (!durableToolCalls.has(call.callId)) {
        await recordStartedTool({ toolCallId: call.callId, toolName: call.toolName });
      }
      // durable tool_call 已完成后才领取并消费一次性许可，返回后下一步直接触碰副作用端口。
      try {
        return await measureExecutionPhase(
          input.phaseTiming,
          "tool_authorize",
          () =>
            input.authorizeToolEffect({
              ...call,
              callId: runtimeCallId(call.callId),
              argsDigest: sha256Digest(call.argsDigest),
            }),
          { toolCallId: call.callId, toolName: call.toolName },
        );
      } catch (error) {
        let resolve: () => void = () => undefined;
        const completed = new Promise<void>((done) => {
          resolve = done;
        });
        rejectedToolReceipts.set(call.callId, { completed, resolve });
        throw error;
      }
    };
    const prepareStartedSandboxTool = async (call: {
      readonly callId: string;
      readonly toolName: string;
      readonly argsDigest: ReturnType<typeof sha256Digest>;
    }) => {
      const startedName = startedToolCalls.get(call.callId);
      if (
        invalidToolCalls.has(call.callId) ||
        sandboxPreparationRequested.has(call.callId) ||
        effectAuthorizationRequested.has(call.callId) ||
        startedName !== call.toolName
      ) {
        throw new Error("Pi 工具 Sandbox 准备缺少匹配的 tool.started");
      }
      sandboxPreparationRequested.add(call.callId);
      if (!durableToolCalls.has(call.callId))
        await recordStartedTool({ toolCallId: call.callId, toolName: call.toolName });
      try {
        return await measureExecutionPhase(
          input.phaseTiming,
          "tool_prepare",
          () =>
            input.ensureSandboxReady({
              reason: "tool",
              call: { ...call, callId: runtimeCallId(call.callId) },
            }),
          { toolCallId: call.callId, toolName: call.toolName },
        );
      } catch (error) {
        let resolve: () => void = () => undefined;
        const completed = new Promise<void>((done) => {
          resolve = done;
        });
        rejectedToolReceipts.set(call.callId, { completed, resolve });
        throw error;
      }
    };
    const artifactAuthorizationIssuer = this.artifactAuthorizationIssuer;
    const deliverFileTools = this.deliverFileTools;
    let activeDeliverFileRouter:
      | ReturnType<NonNullable<typeof deliverFileTools>["create"]>
      | undefined;
    const deliverFileToolRouter =
      deliverFileTools === undefined || artifactAuthorizationIssuer === undefined
        ? undefined
        : {
            deliverFile: async (request: {
              readonly callId: string;
              readonly arguments: unknown;
              readonly signal?: AbortSignal;
            }) => {
              const prepared = await prepareStartedSandboxTool({
                callId: request.callId,
                toolName: "deliver_file",
                argsDigest: digestCanonical(request.arguments),
              });
              activeDeliverFileRouter ??= deliverFileTools.create({
                ...(input.phaseTiming === undefined ? {} : { phaseTiming: input.phaseTiming }),
                binding: {
                  scope: input.scope,
                  attemptId: input.attemptId,
                  sandbox: prepared,
                },
                authorizer: {
                  authorizeToolEffect: async (call) =>
                    artifactAuthorizationIssuer.issue({
                      consumed: await authorizeStartedTool(call),
                      attemptId: input.attemptId,
                    }),
                },
              });
              return await activeDeliverFileRouter.deliverFile(request);
            },
            projectError: (error: unknown) =>
              activeDeliverFileRouter?.projectError(error) ??
              Object.freeze({
                status: "failed" as const,
                code: "SERVICE_UNAVAILABLE",
                message: "Sandbox 未能准备，文件无法交付",
                correctable: false,
                fatal: true,
              }),
          };
    const skillToolExecutor = {
      invoke: async (request: {
        readonly callId: string;
        readonly skill: string;
        readonly args?: string;
      }) => {
        if (startedToolCalls.get(request.callId) !== "skill") {
          throw new SkillRuntimeError("SKILL_PROTOCOL");
        }
        if (!durableToolCalls.has(request.callId)) {
          await recordStartedTool({ toolCallId: request.callId, toolName: "skill" });
        }
        const instruction = await this.requireSkillRuntime().loadInstruction({
          binding: skillBinding,
          source: "tool",
          callId: runtimeCallId(request.callId),
          invocationName: request.skill,
          ...(request.args === undefined ? {} : { args: request.args }),
        });
        return instruction.modelText;
      },
      projectError: (error: unknown) => {
        const code = error instanceof SkillRuntimeError ? error.code : "SKILL_CONTENT_UNAVAILABLE";
        return Object.freeze({
          status: "failed" as const,
          code,
          message: skillErrorMessage(code),
          correctable: code === "SKILL_NOT_INSTALLED" || code === "SKILL_ARGUMENTS_INVALID",
          fatal: code === "SKILL_PROTOCOL",
        });
      },
    };
    const updateScheduledTask = this.updateScheduledTask;
    const automationUpdateToolExecutor =
      updateScheduledTask === undefined || input.agent?.agentKind === "subagent"
        ? undefined
        : {
            apply: async (request: {
              readonly callId: string;
              readonly arguments: AutomationUpdateToolArguments;
              readonly signal?: AbortSignal;
            }) => {
              await authorizeStartedTool({
                callId: request.callId,
                toolName: "automation_update",
                argsDigest: digestCanonical(request.arguments),
              });
              // 授权等待不是副作用开始；等待中取消或丢失续行许可后不得启动写入。
              sessionMaterial.assertModelRequestAllowed();
              if (request.signal?.aborted) throw new Error("定时任务工具已取消");
              return updateScheduledTask({
                tenantId: input.scope.tenantId,
                threadId: input.scope.threadId,
                runId: input.scope.runId,
                commandId: runtimeCallId(request.callId),
                mutation: automationToolMutation(request.arguments, input.scope.threadId),
              });
            },
            projectError: projectAutomationUpdateError,
          };
    const todoWriteToolExecutor = {
      write: async (request: { readonly callId: string; readonly command: TodoWriteCommand }) => {
        if (startedToolCalls.get(request.callId) !== "todo_write") {
          throw new Error("TODO_PROTOCOL");
        }
        if (!durableToolCalls.has(request.callId)) {
          await recordStartedTool({ toolCallId: request.callId, toolName: "todo_write" });
        }
        return await input.writeTodo(request);
      },
      projectError: (error: unknown) => {
        const correctable = error instanceof DomainError;
        return Object.freeze({
          status: "failed" as const,
          code: correctable ? "TODO_INVALID_STATE" : "TODO_PERSISTENCE_UNAVAILABLE",
          message: correctable ? error.message : "任务清单暂时无法保存",
          correctable,
          fatal: !correctable,
        });
      },
    };
    const sessionMaterial = {
      toolCallingMode: this.toolCallingMode,
      ...(this.enabledTools === undefined ? {} : { enabledTools: this.enabledTools }),
      preparePtcProgram: async (callId: string) => {
        await recordStartedTool({ toolCallId: callId, toolName: "run_code" });
      },
      preparePtcTool: async (call: {
        readonly callId: string;
        readonly toolName: string;
        readonly parentCallId: string;
      }) => {
        if (
          this.toolCallingMode !== "ptc" ||
          ptcParents.get(call.callId) !== call.parentCallId ||
          !durableToolCalls.has(call.parentCallId)
        )
          throw new Error("PTC 子调用缺少受控父调用");
        await recordStartedTool({ toolCallId: call.callId, toolName: call.toolName });
      },
      ...(input.phaseTiming === undefined ? {} : { phaseTiming: input.phaseTiming }),
      model: this.model,
      modelContext: this.modelContext,
      modelRuntime: this.modelRuntime,
      prepareSandboxTool: async (call: {
        readonly callId: string;
        readonly toolName: string;
        readonly argsDigest: string;
        readonly signal?: AbortSignal;
      }) => {
        const prepared = await prepareStartedSandboxTool({
          callId: call.callId,
          toolName: call.toolName,
          argsDigest: sha256Digest(call.argsDigest),
        });
        return prepared.sandbox;
      },
      authorizeToolEffect: authorizeStartedTool,
      createToolObservationRecorder: (outputs: ControlledToolReceiptSource) => {
        const recorder = this.createObservationRecorder(input, outputs);
        observationRecorder = recorder;
        return {
          record: async (call: {
            readonly toolCallId: string;
            readonly toolName: string;
            readonly parentToolCallId?: string;
          }) => {
            try {
              // schema 级错误与 Router 在许可前拒绝都不会进入 authorizer；在失败
              // tool_result 前补齐 durable tool_call，但不消费外部副作用许可。
              if (!durableToolCalls.has(call.toolCallId)) await recordStartedTool(call);
              const result = await measureExecutionPhase(
                input.phaseTiming,
                "tool_receipt_persist",
                () => recorder.record({ ...call, ...parentBinding(call.toolCallId) }),
                { toolCallId: call.toolCallId, toolName: call.toolName },
              );
              if (result.outcome !== "recorded" && result.outcome !== "replayed") {
                requireObservationRecovery(result.outcome);
              }
              return result;
            } catch (error) {
              requireObservationRecovery();
              throw error;
            } finally {
              const rejected = rejectedToolReceipts.get(call.toolCallId);
              if (rejected !== undefined) toolEffectRejected = true;
              rejected?.resolve();
              rejectedToolReceipts.delete(call.toolCallId);
            }
          },
        };
      },
      availableSkills: skillSnapshot.items.map((item) => ({
        name: item.invocationName,
        description: item.description,
      })),
      ...(personalizationSnapshot === undefined
        ? {}
        : {
            personalizationPromptContent: {
              ...(personalizationSnapshot.team === undefined
                ? {}
                : {
                    team: {
                      id: `team-personalization.v${personalizationSnapshot.team.version}`,
                      content: personalizationSnapshot.team.content,
                    },
                  }),
              ...(personalizationSnapshot.user === undefined
                ? {}
                : {
                    user: {
                      id: `user-personalization.v${personalizationSnapshot.user.version}`,
                      content: personalizationSnapshot.user.content,
                    },
                  }),
            },
          }),
      skillSnapshotDigest: skillSnapshot.digest,
      skillToolExecutor,
      todoWriteToolExecutor,
      ...(automationUpdateToolExecutor === undefined ? {} : { automationUpdateToolExecutor }),
      ...(input.enabledToolNames === undefined ? {} : { enabledToolNames: input.enabledToolNames }),
      ...(agentControl === undefined || input.agent?.agentKind === "subagent"
        ? {}
        : {
            agentControlToolExecutor: {
              spawn: (call: Parameters<NonNullable<typeof agentControl>["spawn"]>[0]) =>
                agentControl.spawn(call),
              sendMessage: (call: Parameters<NonNullable<typeof agentControl>["sendMessage"]>[0]) =>
                agentControl.sendMessage(call),
              followUp: (call: Parameters<NonNullable<typeof agentControl>["followUp"]>[0]) =>
                agentControl.followUp(call),
              interrupt: (call: Parameters<NonNullable<typeof agentControl>["interrupt"]>[0]) =>
                agentControl.interrupt(call),
              list: () => agentControl.list(),
              wait: (call: Parameters<NonNullable<typeof agentControl>["wait"]>[0]) =>
                agentControl.wait(call),
              projectError: projectAgentControlError,
            },
          }),
      recoveredSkillInstructions: skillEnabled
        ? recoveredForSession.map((instruction) => ({
            name: instruction.name,
            version: instruction.version,
            digest: instruction.digest,
            modelText: instruction.modelText,
          }))
        : [],
      ...(!skillEnabled || explicitSkillInstruction === undefined
        ? {}
        : {
            explicitSkillInstruction: {
              name: explicitSkillInstruction.name,
              version: explicitSkillInstruction.version,
              digest: explicitSkillInstruction.digest,
              modelText: explicitSkillInstruction.modelText,
            },
          }),
      assertModelRequestAllowed: () => {
        if (observationRecoveryCode !== undefined) {
          throw new ModelContinuationRejectedError("tool_observation_incomplete");
        }
        if (toolEffectRejected) {
          throw new ModelContinuationRejectedError("tool_effect_rejected");
        }
      },
      ...(attemptWireTraces === undefined
        ? {}
        : {
            withProviderInvocation: <T>(operation: () => T) =>
              attemptWireTraces.run(wireTraceContext, operation),
          }),
      ...(deliverFileToolRouter === undefined ? {} : { deliverFileToolRouter }),
    };
    // 兼容身份只由实际模型/Prompt/Tool schema 派生；占位 recorder 不执行任何写入。
    const compatibility = deriveSafePiSessionCompatibility({
      ...sessionMaterial,
      createToolObservationRecorder: () => ({
        record: async () => ({ outcome: "unknown" as const }),
      }),
    });
    const prepareObservationSession = this.prepareObservationSession;
    const recoveredProjection =
      prepareObservationSession === undefined
        ? undefined
        : await measureStartup("observation_projection", () =>
            prepareObservationSession(input, compatibility),
          );
    const activeRolloutProjection = recoveredProjection ?? input.rolloutProjection;
    const baselineBudget = assessSafePiSessionContext({
      ...sessionMaterial,
      rolloutProjection: activeRolloutProjection,
    });
    if (baselineBudget.outcome !== "ready") {
      throw new ContextBudgetAdmissionError("reserved_context_exceeds_window");
    }
    const availableThreadHistoryTokens =
      baselineBudget.policy.availableHistoryTokens - baselineBudget.activeEntryTokens;
    if (availableThreadHistoryTokens < 1) {
      throw new ContextBudgetAdmissionError("reserved_context_exceeds_window");
    }
    const prepareThreadHistory = this.prepareThreadHistory;
    const recoveredThreadHistory =
      input.agent?.agentKind === "subagent"
        ? input.threadActiveHistory
        : (input.threadActiveHistory ??
          (prepareThreadHistory === undefined
            ? undefined
            : await measureStartup("thread_history_read", () =>
                prepareThreadHistory(input, compatibility),
              )));
    const initialThreadHistory =
      recoveredThreadHistory === undefined ||
      this.prepareRuntimeCompaction === undefined ||
      input.agent?.agentKind === "subagent"
        ? recoveredThreadHistory
        : await measureStartup("runtime_compaction", () =>
            runRuntimeCompaction(
              input,
              compatibility,
              recoveredThreadHistory,
              availableThreadHistoryTokens,
              input.initialInputText === undefined
                ? 0
                : providerVisibleUserInputTokens(
                    input.initialInputText,
                    this.modelContext.tokenizer,
                  ),
            ),
          );
    input.agentControl?.setParentHistory(initialThreadHistory);
    controller = await measureStartup("pi_session_create", () =>
      createSafePiSession({
        ...sessionMaterial,
        rolloutProjection: activeRolloutProjection,
        ...(initialThreadHistory === undefined
          ? {}
          : { threadActiveHistory: initialThreadHistory }),
        ...(input.onTurnSafePoint === undefined
          ? {}
          : {
              prepareNextTurnHistory: async (
                event: Extract<
                  import("@hoox/pi-adapter").RuntimeAgentEvent,
                  { type: "turn.completed" }
                >,
              ) => {
                const persisted = await input.onTurnSafePoint?.(event);
                if (persisted === undefined) return undefined;
                let replacement: ThreadActiveHistoryV1 | undefined;
                if (this.prepareThreadHistory !== undefined) {
                  const nextInput = { ...input, contextThroughSequence: persisted.throughSequence };
                  const rebuilt = await this.prepareThreadHistory(nextInput, compatibility);
                  if (rebuilt === undefined) throw new Error("Thread Context 安全点重建失败");
                  replacement =
                    this.prepareRuntimeCompaction === undefined
                      ? rebuilt
                      : await runRuntimeCompaction(
                          nextInput,
                          compatibility,
                          rebuilt,
                          availableThreadHistoryTokens,
                          (persisted.steers ?? []).reduce(
                            (tokens, steer) =>
                              tokens +
                              providerVisibleUserInputTokens(
                                steer.inputText,
                                this.modelContext.tokenizer,
                              ),
                            0,
                          ),
                        );
                }
                if ((persisted.steers?.length ?? 0) > 0) {
                  if (controller === undefined) throw new Error("Pi Session steer 安全点尚未就绪");
                  // replacement 截止到完整 assistant/tool turn；同一安全点已持久消费的 steer
                  // 按 input_sequence 依次进入 Pi 原生队列，由下一次 Provider 请求一起读取。
                  for (const steer of persisted.steers ?? []) {
                    const preparedSteer = await prepareInput({
                      text: steer.inputText,
                      attachments: steer.attachments ?? [],
                    });
                    await controller.steer(preparedSteer.text, preparedSteer.images);
                  }
                }
                return replacement;
              },
            }),
      }),
    );
    try {
      // Pi 构造可能执行异步初始化；返回可用 Session 前再次以同一 fence 进入 PG，关闭接管竞态窗口。
      if (prepareObservationSession !== undefined) {
        await measureStartup("observation_revalidation", () =>
          prepareObservationSession(input, compatibility),
        );
      }
    } catch (error) {
      controller.dispose();
      throw error;
    }
    trajectoryRecorder?.record("runtime", "session_created", {
      type: "session_created",
      threadId: input.scope.threadId,
      runId: input.scope.runId,
      model: {
        api: this.model.api,
        provider: this.model.provider,
        id: this.model.id,
      },
      diagnostics: controller.getDiagnostics(),
      agent: input.agent ?? { agentKind: "root" },
    });
    const modelUsageWrites = new Set<Promise<void>>();
    let modelUsageSequence = 0;
    let activeModelGeneration:
      | Readonly<{ readonly sequence: number; readonly startedAt: number }>
      | undefined;
    const modelUsageNamespace =
      input.agent?.agentKind === "subagent"
        ? createHash("sha256")
            .update(`${input.agent.agentThreadId}:${input.agent.agentTurnId}`, "utf8")
            .digest("hex")
            .slice(0, 16)
        : "root";
    const unsubscribeModelUsage =
      this.modelUsageMetrics === undefined
        ? undefined
        : controller.subscribeInternal((event) => {
            if (event.type === "message_start" && event.message.role === "assistant") {
              modelUsageSequence += 1;
              activeModelGeneration = {
                sequence: modelUsageSequence,
                startedAt: performance.now(),
              };
              return;
            }
            if (event.type !== "message_end" || event.message.role !== "assistant") return;
            const generation = activeModelGeneration;
            activeModelGeneration = undefined;
            if (generation === undefined) return;
            const usage = event.message.usage;
            if (usage.input + usage.output + usage.cacheRead === 0) return;
            const write = this.modelUsageMetrics
              ?.recordModelUsage({
                tenantId: input.scope.tenantId,
                threadId: input.scope.threadId,
                runId: input.scope.runId,
                observationId: `${input.attemptId}:model-usage:${modelUsageNamespace}:${generation.sequence}`,
                inputTokens: usage.input,
                outputTokens: usage.output,
                cacheReadTokens: usage.cacheRead,
                generationDurationMs: Math.max(0, performance.now() - generation.startedAt),
              })
              .catch(() => undefined);
            if (write === undefined) return;
            modelUsageWrites.add(write);
            void write.finally(() => modelUsageWrites.delete(write));
          });
    const drainModelUsage = async () => {
      while (modelUsageWrites.size > 0) await Promise.all([...modelUsageWrites]);
    };
    const unsubscribeTrajectory =
      trajectoryRecorder === undefined
        ? undefined
        : controller.subscribeInternal((event) => {
            // 原始 Pi 事件在公开 RuntimeAgentEvent 投影、thinking 合并及内容裁剪前完整快照。
            trajectoryRecorder.record("pi", event.type, event);
          });
    // 该订阅先于 RunWorker 的持久订阅注册，只负责证明 Pi 已真实发布 tool.started。
    const unsubscribeToolGate = controller.subscribe((event) => {
      if (event.type !== "tool.started") return;
      if (startedToolCalls.has(event.callId)) {
        invalidToolCalls.add(event.callId);
        return;
      }
      if (event.parentCallId !== undefined) {
        if (
          this.toolCallingMode !== "ptc" ||
          startedToolCalls.get(event.parentCallId) !== "run_code" ||
          !durableToolCalls.has(event.parentCallId)
        ) {
          invalidToolCalls.add(event.callId);
          return;
        }
        ptcParents.set(event.callId, event.parentCallId);
      }
      startedToolCalls.set(event.callId, event.name);
    });
    return {
      prepareInput,
      runPrompt: async (prepared, authorization): Promise<AgentTurnOutcome> => {
        const { permit } = authorization;
        const allowedModelPermit =
          input.agent?.agentKind === "subagent"
            ? permit.effect === "agent_model_start"
            : permit.effect === "model_start" || permit.effect === "model_continue";
        if (
          !allowedModelPermit ||
          permit.scope.tenantId !== input.scope.tenantId ||
          permit.scope.threadId !== input.scope.threadId ||
          permit.scope.runId !== input.scope.runId ||
          permit.scope.rootRunId !== input.scope.rootRunId ||
          permit.scope.workspaceId !== input.scope.workspaceId ||
          permit.scope.baseRevisionId !== input.scope.baseRevisionId
        ) {
          throw new Error("模型启动许可与 ExecutionScope 不匹配");
        }
        if (
          performance.now() - authorization.consumedAtMonotonicMs >=
          authorization.maxContinuationDelayMs
        ) {
          throw new Error("模型启动许可在本地 continuation 前已过期");
        }
        // 许可刚由 DB 一次性消费；校验后立即进入 prompt，中间不再插入异步窗口。
        trajectoryRecorder?.record("runtime", "prompt", {
          type: "prompt",
          text: prepared.text,
          images: prepared.images,
        });
        input.startupTiming?.modelInvocationStarting();
        try {
          try {
            await controller.prompt(prepared.text, prepared.images);
          } finally {
            // 即使 Provider 失败也只等待当前 Attempt 已创建的诊断任务，且不会改变原异常。
            await Promise.all([
              attemptWireTraces?.drain(),
              trajectoryRecorder?.drain(),
              drainModelUsage(),
            ]);
          }
        } catch (error) {
          await drainAttachmentSandboxPreparation().catch(() => undefined);
          if (observationRecoveryCode !== undefined) {
            return { kind: "recovery_required", code: observationRecoveryCode };
          }
          if (error instanceof ContextBudgetAdmissionError)
            return { kind: "context_too_large", action: "rebuild_context" };
          throw error;
        }
        await drainAttachmentSandboxPreparation();
        if (observationRecoveryCode !== undefined) {
          return { kind: "recovery_required", code: observationRecoveryCode };
        }
        return { kind: "completed" };
      },
      steer: async (userInput) => {
        const prepared = await prepareInput(userInput);
        trajectoryRecorder?.record("runtime", "steer", {
          type: "steer",
          text: prepared.text,
          images: prepared.images,
        });
        await controller.steer(prepared.text, prepared.images);
      },
      abort: () => controller.abort(),
      drainRejectedToolReceipts: async () => {
        while (rejectedToolReceipts.size > 0) {
          await Promise.all([...rejectedToolReceipts.values()].map((item) => item.completed));
        }
      },
      subscribe: (listener) =>
        controller.subscribe((event) => {
          if (
            input.agent?.agentKind === "subagent" &&
            (event.type === "tool.started" ||
              event.type === "tool.updated" ||
              event.type === "tool.completed")
          ) {
            listener({
              ...event,
              callId: runtimeCallId(event.callId),
              ...(event.type === "tool.started" && event.parentCallId !== undefined
                ? { parentCallId: runtimeCallId(event.parentCallId) }
                : {}),
            });
            return;
          }
          listener(event);
        }),
      dispose: () => {
        unsubscribeModelUsage?.();
        unsubscribeTrajectory?.();
        unsubscribeToolGate();
        startedToolCalls.clear();
        ptcParents.clear();
        invalidToolCalls.clear();
        effectAuthorizationRequested.clear();
        sandboxPreparationRequested.clear();
        durableToolCalls.clear();
        rejectedToolReceipts.clear();
        controller.dispose();
        void trajectoryRecorder?.drain();
        void drainModelUsage();
        attemptWireTraces?.release();
      },
    };
  }

  private requireSkillRuntime(): SkillRuntimeService {
    if (this.skillRuntime === undefined) {
      throw new SkillRuntimeError("SKILL_CONTENT_UNAVAILABLE");
    }
    return this.skillRuntime;
  }
}

function skillErrorMessage(code: SkillRuntimeError["code"]): string {
  switch (code) {
    case "SKILL_NOT_INSTALLED":
      return "该 Skill 不在本次 Run 的可用目录中";
    case "SKILL_REVOKED":
      return "该 Skill 版本已撤销";
    case "SKILL_INCOMPATIBLE":
      return "该 Skill 与当前 Runtime 不兼容";
    case "SKILL_ARGUMENTS_INVALID":
      return "Skill 参数无效";
    case "SKILL_CONTEXT_LIMIT":
      return "Skill 指令超过当前上下文预算";
    case "SKILL_PROTOCOL":
      return "Skill 调用协议校验失败";
    case "SKILL_CONTENT_UNAVAILABLE":
      return "Skill 内容暂时不可用";
  }
}

/** 生产装配必须显式提供绑定当前 ExecutionScope 的 durable Blob 与 Rollout 端口。 */
export function createDurableObservationRecorderFactory(
  createDependencies: (input: Parameters<AgentSessionFactoryPort["create"]>[0]) => {
    /** 端口创建时的事实绑定；错接其他租户、Run 或 Attempt 必须在首次写入前失败。 */
    readonly binding: {
      readonly scope: Parameters<AgentSessionFactoryPort["create"]>[0]["scope"];
      readonly attemptId: string;
      readonly agentThreadId: string;
    };
    readonly traces: TraceBlobPersistencePort;
    readonly rollout: ToolObservationRolloutPort;
    readonly policy: ToolObservationPolicy;
  },
) {
  return (
    input: Parameters<AgentSessionFactoryPort["create"]>[0],
    outputs: ControlledToolReceiptSource,
  ) => {
    const dependencies = createDependencies(input);
    const binding = dependencies.binding;
    if (
      binding.attemptId !== input.attemptId ||
      binding.scope.tenantId !== input.scope.tenantId ||
      binding.scope.threadId !== input.scope.threadId ||
      binding.scope.runId !== input.scope.runId ||
      binding.scope.rootRunId !== input.scope.rootRunId ||
      binding.scope.workspaceId !== input.scope.workspaceId ||
      binding.scope.baseRevisionId !== input.scope.baseRevisionId ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(binding.agentThreadId)
    ) {
      throw new Error("durable Tool Observation 端口与当前 ExecutionScope 不匹配");
    }
    const rolloutBinding: ToolObservationBinding = Object.freeze({
      tenantId: binding.scope.tenantId,
      threadId: binding.scope.threadId,
      runId: binding.scope.runId,
      rootRunId: binding.scope.rootRunId,
      workspaceId: binding.scope.workspaceId,
      ...(binding.scope.baseRevisionId === undefined
        ? {}
        : { baseRevisionId: binding.scope.baseRevisionId }),
      attemptId: binding.attemptId,
      agentThreadId: binding.agentThreadId,
      runClaimToken: input.fence.runClaim.token,
      runClaimEpoch: input.fence.runClaim.epoch,
      workspaceLeaseRootRunId: input.fence.workspaceLease.rootRunId,
      workspaceLeaseEpoch: input.fence.workspaceLease.epoch,
    });
    const pipeline = new ToolObservationPipeline(
      dependencies.traces,
      dependencies.rollout,
      outputs,
      dependencies.policy,
    );
    return {
      recordStarted: async (call: {
        readonly toolCallId: string;
        readonly toolName: string;
        readonly parentToolCallId?: string;
      }) => {
        const result = await dependencies.rollout.appendToolCall({
          binding: rolloutBinding,
          idempotencyKey: `attempt.${input.attemptId}.tool.${call.toolCallId}.call`,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          ...(call.parentToolCallId === undefined
            ? {}
            : { parentToolCallId: call.parentToolCallId }),
        });
        return result.outcome === "created" ? "recorded" : result.outcome;
      },
      record: (call: {
        readonly toolCallId: string;
        readonly toolName: string;
        readonly parentToolCallId?: string;
      }) =>
        pipeline.record({
          binding: rolloutBinding,
          idempotencyKey: `attempt.${input.attemptId}.tool.${call.toolCallId}`,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          ...(call.parentToolCallId === undefined
            ? {}
            : { parentToolCallId: call.parentToolCallId }),
        }),
    };
  };
}

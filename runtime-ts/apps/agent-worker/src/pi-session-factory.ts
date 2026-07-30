import type { ArtifactExecutionAuthorizationIssuerPort } from "@cube-runtime/artifact";
import {
  type ControlledToolReceiptSource,
  type ToolObservationBinding,
  ToolObservationPipeline,
  type ToolObservationPolicy,
  type ToolObservationResult,
  type ToolObservationRolloutPort,
  type TraceBlobPersistencePort,
} from "@cube-runtime/context-policy";
import { sha256Digest } from "@cube-runtime/domain";
import {
  bindTrustedPiModelContextCapability,
  ContextBudgetAdmissionError,
  type ControlledRolloutProjection,
  createSafePiSession,
  deriveSafePiSessionCompatibility,
  type PiSessionController,
} from "@cube-runtime/pi-adapter";
import type { ArtifactToolRouterFactoryPort } from "@cube-runtime/tool-router";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelWireTraceSession } from "./model-wire-trace.js";
import type { AgentSessionFactoryPort, AgentTurnOutcome, WorkerAgentSessionPort } from "./ports.js";

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
    private readonly modelRuntime: ModelRuntime,
    private readonly createObservationRecorder: (
      input: Parameters<AgentSessionFactoryPort["create"]>[0],
      outputs: ControlledToolReceiptSource,
    ) => {
      recordStarted(call: {
        readonly toolCallId: string;
        readonly toolName: string;
      }): Promise<ToolObservationResult["outcome"]>;
      record(call: {
        readonly toolCallId: string;
        readonly toolName: string;
      }): Promise<ToolObservationResult>;
    },
    private readonly artifactTools?: ArtifactToolRouterFactoryPort,
    private readonly artifactAuthorizationIssuer?: ArtifactExecutionAuthorizationIssuerPort,
    private readonly prepareObservationSession?: (
      input: Parameters<AgentSessionFactoryPort["create"]>[0],
      compatibility: ReturnType<typeof deriveSafePiSessionCompatibility>,
    ) => Promise<ControlledRolloutProjection | undefined>,
    private readonly modelWireTraces?: ModelWireTraceSession,
  ) {
    this.modelContext = bindTrustedPiModelContextCapability(modelRuntime, model);
  }

  async create(
    input: Parameters<AgentSessionFactoryPort["create"]>[0],
  ): Promise<WorkerAgentSessionPort> {
    const attemptWireTraces = this.modelWireTraces?.createAttempt();
    const startedToolCalls = new Map<string, string>();
    const invalidToolCalls = new Set<string>();
    const authorizationRequested = new Set<string>();
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
    const requireObservationRecovery = (outcome?: ToolObservationResult["outcome"]) => {
      observationRecoveryCode =
        outcome === "conflict" ? "IDEMPOTENCY_CONFLICT" : "PERSISTENCE_UNAVAILABLE";
      // 立即停止本轮，避免模型在缺失 durable Tool 事实后继续发起其他副作用。
      void controller?.abort().catch(() => undefined);
    };
    const authorizeStartedTool = async (call: {
      readonly callId: string;
      readonly toolName: string;
      readonly argsDigest: string;
    }) => {
      const startedName = startedToolCalls.get(call.callId);
      if (
        invalidToolCalls.has(call.callId) ||
        authorizationRequested.has(call.callId) ||
        startedName !== call.toolName
      ) {
        throw new Error("Pi 工具许可缺少匹配的 tool.started");
      }
      // 不删除 gate：callId 在整个 Attempt 内永久一次性，失败后的相同调用也不可重试。
      authorizationRequested.add(call.callId);
      let recorded: ToolObservationResult["outcome"] | undefined;
      try {
        recorded = await observationRecorder?.recordStarted({
          toolCallId: call.callId,
          toolName: call.toolName,
        });
      } catch {
        requireObservationRecovery();
        throw new Error("Tool Rollout 前驱持久化状态未知");
      }
      if (recorded !== "recorded" && recorded !== "replayed") {
        requireObservationRecovery(recorded);
        throw new Error("Tool Rollout 前驱未能持久化");
      }
      // durable tool_call 已完成后才领取并消费一次性许可，返回后下一步直接触碰副作用端口。
      try {
        return await input.authorizeToolEffect({
          ...call,
          argsDigest: sha256Digest(call.argsDigest),
        });
      } catch (error) {
        let resolve: () => void = () => undefined;
        const completed = new Promise<void>((done) => {
          resolve = done;
        });
        rejectedToolReceipts.set(call.callId, { completed, resolve });
        throw error;
      }
    };
    const artifactTools = this.artifactTools;
    const artifactAuthorizationIssuer = this.artifactAuthorizationIssuer;
    if (artifactTools && !artifactAuthorizationIssuer) {
      throw new Error("Artifact 工具缺少动态授权 issuer");
    }
    const artifactToolRouter =
      artifactTools && artifactAuthorizationIssuer
        ? artifactTools.create({
            binding: { scope: input.scope, attemptId: input.attemptId },
            authorizer: {
              authorizeToolEffect: async (call) =>
                artifactAuthorizationIssuer.issue({
                  consumed: await authorizeStartedTool(call),
                  attemptId: input.attemptId,
                }),
            },
          })
        : undefined;
    const sessionMaterial = {
      model: this.model,
      modelContext: this.modelContext,
      modelRuntime: this.modelRuntime,
      sandbox: input.sandbox,
      authorizeToolEffect: authorizeStartedTool,
      createToolObservationRecorder: (outputs: ControlledToolReceiptSource) => {
        const recorder = this.createObservationRecorder(input, outputs);
        observationRecorder = recorder;
        return {
          record: async (call: { readonly toolCallId: string; readonly toolName: string }) => {
            try {
              const result = await recorder.record(call);
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
      assertModelRequestAllowed: () => {
        if (observationRecoveryCode !== undefined) {
          throw new Error("Tool Observation 恢复未完成，禁止继续模型轮次");
        }
        if (toolEffectRejected) {
          throw new Error("Tool 失败回执完成后禁止继续模型轮次");
        }
      },
      ...(attemptWireTraces === undefined
        ? {}
        : {
            withProviderInvocation: <T>(operation: () => Promise<T>) =>
              attemptWireTraces.run(
                {
                  tenantId: input.scope.tenantId,
                  threadId: input.scope.threadId,
                  runId: input.scope.runId,
                  attemptId: input.attemptId,
                },
                operation,
              ),
          }),
      ...(artifactToolRouter === undefined ? {} : { artifactToolRouter }),
    };
    // 兼容身份只由实际模型/Prompt/Tool schema 派生；占位 recorder 不执行任何写入。
    const compatibility = deriveSafePiSessionCompatibility({
      ...sessionMaterial,
      createToolObservationRecorder: () => ({
        record: async () => ({ outcome: "unknown" as const }),
      }),
    });
    const recoveredProjection = await this.prepareObservationSession?.(input, compatibility);
    controller = await createSafePiSession({
      ...sessionMaterial,
      rolloutProjection: recoveredProjection ?? input.rolloutProjection,
    });
    try {
      // Pi 构造可能执行异步初始化；返回可用 Session 前再次以同一 fence 进入 PG，关闭接管竞态窗口。
      await this.prepareObservationSession?.(input, compatibility);
    } catch (error) {
      controller.dispose();
      throw error;
    }
    // 该订阅先于 RunWorker 的持久订阅注册，只负责证明 Pi 已真实发布 tool.started。
    const unsubscribeToolGate = controller.subscribe((event) => {
      if (event.type !== "tool.started") return;
      if (startedToolCalls.has(event.callId)) {
        invalidToolCalls.add(event.callId);
        return;
      }
      startedToolCalls.set(event.callId, event.name);
    });
    return {
      runPrompt: async (text, authorization): Promise<AgentTurnOutcome> => {
        const { permit } = authorization;
        if (
          (permit.effect !== "model_start" && permit.effect !== "model_continue") ||
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
        try {
          try {
            await controller.prompt(text);
          } finally {
            // 即使 Provider 失败也只等待当前 Attempt 已创建的诊断任务，且不会改变原异常。
            await attemptWireTraces?.drain();
          }
        } catch (error) {
          if (observationRecoveryCode !== undefined) {
            return { kind: "recovery_required", code: observationRecoveryCode };
          }
          if (error instanceof ContextBudgetAdmissionError)
            return { kind: "context_too_large", action: "rebuild_context" };
          throw error;
        }
        if (observationRecoveryCode !== undefined) {
          return { kind: "recovery_required", code: observationRecoveryCode };
        }
        return { kind: "completed" };
      },
      abort: () => controller.abort(),
      drainRejectedToolReceipts: async () => {
        while (rejectedToolReceipts.size > 0) {
          await Promise.all([...rejectedToolReceipts.values()].map((item) => item.completed));
        }
      },
      subscribe: (listener) => controller.subscribe(listener),
      dispose: () => {
        unsubscribeToolGate();
        startedToolCalls.clear();
        invalidToolCalls.clear();
        authorizationRequested.clear();
        rejectedToolReceipts.clear();
        controller.dispose();
      },
    };
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
      recordStarted: async (call: { readonly toolCallId: string; readonly toolName: string }) => {
        const result = await dependencies.rollout.appendToolCall({
          binding: rolloutBinding,
          idempotencyKey: `attempt.${input.attemptId}.tool.${call.toolCallId}.call`,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
        });
        return result.outcome === "created" ? "recorded" : result.outcome;
      },
      record: (call: { readonly toolCallId: string; readonly toolName: string }) =>
        pipeline.record({
          binding: rolloutBinding,
          idempotencyKey: `attempt.${input.attemptId}.tool.${call.toolCallId}`,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
        }),
    };
  };
}

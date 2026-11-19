// 单次 Run 的模型事件持久化流水线。root 与 SubAgent 共享 Attempt event sequence，
// 因此所有事件必须串行进入同一条编码队列；任何持久化失败都原子关闭事件入口。
import type { RuntimeAgentEvent } from "@hoox/pi-adapter";
import type {
  AgentSessionFactoryPort,
  ExecutionPersistencePort,
  RuntimeMutation,
  RuntimeMutationResult,
  ThreadContextAppendCommandV1,
  WorkerAgentSessionPort,
} from "./ports.js";
import type { ExecutionContext } from "./run-worker-context.js";
import { agentEvent } from "./run-worker-events.js";
import {
  applyFinalizationTransition,
  classifyFinalizationTurn,
  closeEventAcceptance,
  registerToolStarted,
  stopReasonForFailedMutation,
  stopReasonForPendingSteers,
  updateAgentState,
} from "./run-worker-execution-state.js";
import { isApplied } from "./run-worker-fact-matching.js";

export type PendingThreadSteer = Extract<
  Awaited<ReturnType<ExecutionPersistencePort["readPendingThreadSteers"]>>,
  { readonly outcome: "pending" }
>["items"][number];

type TurnCompletedEvent = Extract<RuntimeAgentEvent, { type: "turn.completed" }>;
type SubagentToolEvent = Extract<RuntimeAgentEvent, { type: "tool.started" | "tool.completed" }>;
type TurnSafePointResult = Awaited<
  ReturnType<NonNullable<Parameters<AgentSessionFactoryPort["create"]>[0]["onTurnSafePoint"]>>
>;

/** RunWorker 提供的执行期操作；都已绑定当前 ExecutionContext。 */
export interface RunEventPipelineOperations {
  applyMutation(
    input: Omit<
      RuntimeMutation,
      | "schemaVersion"
      | "commandDigest"
      | "fence"
      | "expectedAttemptVersion"
      | "expectedProjectionVersion"
    >,
  ): Promise<RuntimeMutationResult>;
  requestAbort(): Promise<void>;
  prepareTurnContextAppend(
    event: TurnCompletedEvent,
    phase?: "commentary" | "final_answer",
  ): Promise<ThreadContextAppendCommandV1>;
  applyThreadSteer(item: PendingThreadSteer): Promise<RuntimeMutationResult>;
  readPendingThreadSteers(): ReturnType<ExecutionPersistencePort["readPendingThreadSteers"]>;
}

export class RunEventPipeline {
  #chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: ExecutionContext,
    private readonly operations: RunEventPipelineOperations,
    private readonly threadInputRoutingV2Enabled: boolean,
  ) {}

  /** 当前已排队事件全部落盘（或被丢弃）后完成；调用时刻之后入队的事件不在等待范围内。 */
  get drained(): Promise<void> {
    return this.#chain;
  }

  /** 订阅 root Session 的公开事件，按到达顺序串行持久化。 */
  subscribe(session: Pick<WorkerAgentSessionPort, "subscribe">): () => void {
    const context = this.context;
    const operations = this.operations;
    return session.subscribe((event) => {
      if (!context.eventAcceptanceOpen) return;
      const toolStartedGate =
        event.type === "tool.started" ? registerToolStarted(context, event) : undefined;
      this.#chain = this.#chain.then(async () => {
        // 协议拒绝或持久化失败会原子关闭入口；已排队事件只 drain。
        if (!context.eventAcceptanceOpen) {
          toolStartedGate?.resolve();
          return;
        }
        try {
          // turn.completed 由 awaited onTurnSafePoint 原子提交；这里不能异步重复写入。
          if (event.type === "turn.completed") return;
          const encoded = agentEvent(context, event);
          const persisted = await operations.applyMutation({
            idempotencyKey: `${context.attemptId}/event/${encoded.sequence}`,
            events: [encoded],
            outbox: [],
            ...(event.type === "tool.started"
              ? { effectInvocation: { callId: event.callId, toolName: event.name } }
              : {}),
          });
          if (!isApplied(persisted)) {
            closeEventAcceptance(context);
            context.stopped = stopReasonForFailedMutation(persisted.outcome);
            await operations.requestAbort();
            return;
          }
          if (!context.eventAcceptanceOpen) return;
          updateAgentState(context, event);
        } catch {
          context.adapterRejected = true;
          context.agentFailure = "EVENT_REJECTED";
          closeEventAcceptance(context);
          await operations.requestAbort();
        } finally {
          toolStartedGate?.resolve();
        }
      });
    });
  }

  /** SubAgent 工具事件；失败会向调用方抛出，同时不阻塞后续排队事件 drain。 */
  persistSubagentToolEvent(event: SubagentToolEvent): Promise<void> {
    const context = this.context;
    const operations = this.operations;
    const gate = event.type === "tool.started" ? registerToolStarted(context, event) : undefined;
    // root 与 Child 共享 Attempt event sequence；必须共用一条编码队列，禁止在进入
    // durable lane 前分别读取同一个 nextEventSequence 并制造伪 conflict。
    const persistence = this.#chain.then(async () => {
      try {
        if (!context.eventAcceptanceOpen) {
          throw new Error("SubAgent 工具事件入口已关闭");
        }
        const encoded = agentEvent(context, event);
        const persisted = await operations.applyMutation({
          idempotencyKey: `${context.attemptId}/subagent/tool/${event.callId}/${event.type}`,
          events: [encoded],
          outbox: [],
          ...(event.type === "tool.started"
            ? { effectInvocation: { callId: event.callId, toolName: event.name } }
            : {}),
        });
        if (!isApplied(persisted)) {
          closeEventAcceptance(context);
          context.stopped = stopReasonForFailedMutation(persisted.outcome);
          throw new Error(`SubAgent ${event.type} 持久化失败`);
        }
      } finally {
        gate?.resolve();
      }
    });
    this.#chain = persistence.catch(() => undefined);
    return persistence;
  }

  /**
   * turn 安全点：原子提交 Thread Context 与终答收口事件，然后一次性合并当前已排队的 steer。
   * 任何失败都关闭事件入口并抛出，使 Pi 中止本 Attempt。
   */
  async commitTurnSafePoint(event: TurnCompletedEvent): Promise<TurnSafePointResult> {
    const context = this.context;
    const operations = this.operations;
    // turn 安全点可能从 Pi 的 prepare hook 进入，而流式公开事件仍在异步持久化队列中。
    // 必须先排空已发布事件，禁止 Thread Context 越过 thinking/message 终态。
    await this.#chain;
    if (!context.eventAcceptanceOpen) throw new Error("Thread Context 写入口已关闭");
    const finalization = classifyFinalizationTurn(context, event);
    const append = await operations.prepareTurnContextAppend(event, finalization.phase);
    const persisted = await operations.applyMutation({
      idempotencyKey: append.idempotencyKey,
      events: finalization.event === undefined ? [] : [agentEvent(context, finalization.event)],
      outbox: [],
      threadContextAppend: append,
    });
    if (!isApplied(persisted) || persisted.receipt.threadContext === undefined) {
      closeEventAcceptance(context);
      context.stopped = stopReasonForFailedMutation(persisted.outcome);
      throw new Error("Thread Context turn 安全点提交失败");
    }
    applyFinalizationTransition(context, finalization);
    const throughSequence = persisted.receipt.threadContext.lastSequence;
    if (!this.threadInputRoutingV2Enabled) return { throughSequence };
    // 先持久化完整 assistant/tool 配对，再一次读取当前安全点已经排队的全部 steer；
    // 新到达的输入留给后续安全点，避免持续写入让本次 Provider continuation 饥饿。
    const pending = await operations.readPendingThreadSteers();
    if (pending.outcome === "pending") {
      const steers = [];
      for (const item of pending.items) {
        const steered = await operations.applyThreadSteer(item);
        if (!isApplied(steered)) {
          closeEventAcceptance(context);
          context.stopped = stopReasonForFailedMutation(steered.outcome);
          throw new Error("Thread steer 安全点提交失败");
        }
        steers.push({
          receiptId: item.receiptId,
          inputText: item.inputText,
          ...(item.attachments === undefined ? {} : { attachments: item.attachments }),
        });
      }
      return { throughSequence, steers };
    }
    if (pending.outcome !== "none") {
      closeEventAcceptance(context);
      context.stopped = stopReasonForPendingSteers(pending.outcome);
      throw new Error("Thread steer 安全点不可继续");
    }
    return { throughSequence };
  }
}

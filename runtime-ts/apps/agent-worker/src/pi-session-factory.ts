import { createSafePiSession } from "@cube-runtime/pi-adapter";
import { sha256Digest } from "@cube-runtime/domain";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ArtifactToolRouterFactoryPort } from "@cube-runtime/tool-router";
import type { AgentSessionFactoryPort, AgentTurnOutcome, WorkerAgentSessionPort } from "./ports.js";

/**
 * Worker 的生产 Pi 绑定只返回应用层窄接口；原始 AgentSession 和 compact() 从未跨越适配层。
 * waiting 未来由 request_user_input 工具适配器产生；本阶段只实现持久 RolloutProjection 的恢复机制，
 * 再用 prompt 真正启动模型，绝不对空 Session 调 followUp。
 */
export class PiWorkerSessionFactory implements AgentSessionFactoryPort {
  constructor(
    private readonly model: Model<Api>,
    private readonly modelRuntime: ModelRuntime,
    private readonly artifactTools?: ArtifactToolRouterFactoryPort,
  ) {}

  async create(
    input: Parameters<AgentSessionFactoryPort["create"]>[0],
  ): Promise<WorkerAgentSessionPort> {
    const startedToolCalls = new Map<string, string>();
    const invalidToolCalls = new Set<string>();
    const authorizationRequested = new Set<string>();
    const authorizeStartedTool = (call: {
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
      return input.authorizeToolEffect({ ...call, argsDigest: sha256Digest(call.argsDigest) });
    };
    const artifactToolRouter = this.artifactTools?.create({
      context: input.trustedToolContext,
      authorizer: { authorizeToolEffect: authorizeStartedTool },
    });
    const controller = await createSafePiSession({
      model: this.model,
      modelRuntime: this.modelRuntime,
      sandbox: input.sandbox,
      rolloutProjection: input.rolloutProjection,
      authorizeToolEffect: authorizeStartedTool,
      ...(artifactToolRouter === undefined ? {} : { artifactToolRouter }),
    });
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
          permit.effect !== "model_start" ||
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
        await controller.prompt(text);
        return { kind: "completed" };
      },
      abort: () => controller.abort(),
      subscribe: (listener) => controller.subscribe(listener),
      dispose: () => {
        unsubscribeToolGate();
        startedToolCalls.clear();
        invalidToolCalls.clear();
        authorizationRequested.clear();
        controller.dispose();
      },
    };
  }
}

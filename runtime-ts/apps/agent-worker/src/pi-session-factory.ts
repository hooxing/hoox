import { createSafePiSession } from "@cube-runtime/pi-adapter";
import { sha256Digest } from "@cube-runtime/domain";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
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
  ) {}

  async create(
    input: Parameters<AgentSessionFactoryPort["create"]>[0],
  ): Promise<WorkerAgentSessionPort> {
    const controller = await createSafePiSession({
      model: this.model,
      modelRuntime: this.modelRuntime,
      sandbox: input.sandbox,
      rolloutProjection: input.rolloutProjection,
      authorizeToolEffect: (call) =>
        input.authorizeToolEffect({ ...call, argsDigest: sha256Digest(call.argsDigest) }),
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
      dispose: () => controller.dispose(),
    };
  }
}

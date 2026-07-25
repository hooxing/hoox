import { createSafePiSession } from "@cube-runtime/pi-adapter";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentSessionFactoryPort, AgentTurnOutcome, WorkerAgentSessionPort } from "./ports.js";

/**
 * Worker 的生产 Pi 绑定只返回应用层窄接口；原始 AgentSession 和 compact() 从未跨越适配层。
 * waiting 由 request_user_input 工具适配器产生；恢复时由持久 RolloutProjection 构造新 Session，
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
    });
    return {
      runPrompt: async (text): Promise<AgentTurnOutcome> => {
        await controller.prompt(text);
        return { kind: "completed" };
      },
      abort: () => controller.abort(),
      subscribe: (listener) => controller.subscribe(listener),
      dispose: () => controller.dispose(),
    };
  }
}

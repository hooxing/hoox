import { createSafePiSession } from "@cube-runtime/pi-adapter";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentSessionFactoryPort, AgentTurnOutcome, WorkerAgentSessionPort } from "./ports.js";

/**
 * Worker 的生产 Pi 绑定只返回应用层窄接口；原始 AgentSession 和 compact() 从未跨越适配层。
 * waiting 由后续 request_user_input 工具适配器产生，本绑定当前把正常 Pi settle 视为 completed。
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
    });
    return {
      run: async (turn): Promise<AgentTurnOutcome> => {
        if (turn.mode === "follow_up") await controller.followUp(turn.text);
        else await controller.prompt(turn.text);
        return { kind: "completed" };
      },
      abort: () => controller.abort(),
      subscribe: (listener) => controller.subscribe(listener),
      dispose: () => controller.dispose(),
    };
  }
}

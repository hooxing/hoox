import { describe, expect, it } from "vitest";
import { projectAgentControlError } from "./pi-session-factory.js";

describe("子 Agent 控制错误投影", () => {
  it("保留稳定机器码并提供人类可读的可纠正说明", () => {
    expect(projectAgentControlError(new Error("AGENT_NOT_FOUND"))).toEqual({
      status: "failed",
      code: "AGENT_NOT_FOUND",
      message: "目标子 Agent 不存在，请检查 target 或先调用 list_agents。",
      correctable: true,
      fatal: false,
    });
    expect(projectAgentControlError(new Error("AGENT_NOT_RUNNING"))).toEqual({
      status: "failed",
      code: "AGENT_NOT_RUNNING",
      message: "目标子 Agent 当前没有运行中的 turn，不能执行该操作。",
      correctable: true,
      fatal: false,
    });
  });

  it("未知内部异常统一投影为平台控制面故障且不泄漏原始文本", () => {
    expect(projectAgentControlError(new Error("database password leaked"))).toEqual({
      status: "failed",
      code: "AGENT_CONTROL_FAILED",
      message: "子 Agent 控制面暂时不可用，请稍后重试。",
      correctable: true,
      fatal: false,
    });
  });
});

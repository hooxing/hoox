import { describe, expect, it } from "vitest";
import {
  assertNativeEvalEnvironment,
  evaluationStatus,
  extractFinalAnswer,
  parseGaiaEvalArguments,
  selectGaiaQuestions,
} from "../scripts/gaia-native-eval.mjs";

describe("GAIA 当前 Runtime 原生评测", () => {
  it("默认只取三个公开样本并使用当前开发角色", () => {
    const options = parseGaiaEvalArguments([], {
      API_LISTEN_HOST: "127.0.0.1",
      API_LISTEN_PORT: "3100",
    });
    expect(options.apiBaseUrl).toBe("http://127.0.0.1:3100");
    expect(options.authToken).toBe("dev-user-a");
    expect(options.limit).toBe(3);
  });

  it("记忆未明确关闭时失败关闭", () => {
    expect(() => assertNativeEvalEnvironment({ MEM0_MEMORY_ENABLED: "true" })).toThrow(
      "MEM0_MEMORY_ENABLED=false",
    );
    expect(() => assertNativeEvalEnvironment({ MEM0_MEMORY_ENABLED: "false" })).not.toThrow();
  });

  it("支持按 task_id 精确选择且拒绝不存在的题目", () => {
    const questions = [
      { task_id: "task-a", question: "A" },
      { task_id: "task-b", question: "B" },
    ];
    expect(selectGaiaQuestions(questions, { limit: 1, taskIds: ["task-b"] })).toEqual([
      questions[1],
    ]);
    expect(() => selectGaiaQuestions(questions, { limit: 1, taskIds: ["missing"] })).toThrow(
      "missing",
    );
  });

  it("优先读取持久上下文中的最终回答，并可退回消息增量", () => {
    expect(
      extractFinalAnswer(
        [
          { role: "assistant", text: "中间答案" },
          { role: "assistant", text: "最终答案" },
        ],
        [],
      ),
    ).toBe("最终答案");
    expect(
      extractFinalAnswer(
        [],
        [
          { type: "message.delta", payload: { delta: "答" } },
          { type: "message.delta", payload: { delta: "案" } },
        ],
      ),
    ).toBe("答案");
  });

  it("需要恢复的运行不会被误报为仍在运行", () => {
    expect(evaluationStatus({ status: "running", executionStatus: "recovery_required" })).toBe(
      "recovery_required",
    );
    expect(evaluationStatus({ status: "succeeded" })).toBe("succeeded");
  });

  it("参数边界拒绝过大的样本和未知参数", () => {
    expect(() => parseGaiaEvalArguments(["--limit", "21"])).toThrow("--limit");
    expect(() => parseGaiaEvalArguments(["--unknown"])).toThrow("未知参数");
  });
});

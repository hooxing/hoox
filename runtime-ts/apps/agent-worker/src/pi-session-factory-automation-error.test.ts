import { AutomationUpdateArgumentError } from "@hoox/pi-adapter";
import { describe, expect, it } from "vitest";
import { projectAutomationUpdateError } from "./pi-session-factory.js";

describe("定时任务工具错误投影", () => {
  it("字段值错误保留字段级详情并标记为可纠正", () => {
    expect(
      projectAutomationUpdateError(new AutomationUpdateArgumentError("timezone", "时区无效")),
    ).toEqual({
      status: "failed",
      code: "AUTOMATION_ARGUMENT_VALUE_INVALID",
      message: "定时任务字段值无效，请按 details 修正后重试。",
      correctable: true,
      fatal: false,
      details: [{ field: "timezone", reason: "时区无效" }],
    });
  });

  it("区分状态冲突、权限拒绝与服务不可用", () => {
    expect(projectAutomationUpdateError(new Error("AUTOMATION_NOT_FOUND"))).toEqual({
      status: "failed",
      code: "AUTOMATION_NOT_FOUND",
      message: "定时任务不存在，请检查 task_id 后重试。",
      correctable: true,
      fatal: false,
    });
    expect(projectAutomationUpdateError(new Error("AUTOMATION_NOT_AUTHORIZED"))).toEqual({
      status: "failed",
      code: "AUTOMATION_NOT_AUTHORIZED",
      message: "当前会话无权管理该定时任务。",
      correctable: false,
      fatal: false,
    });
    expect(projectAutomationUpdateError(new Error("database password leaked"))).toEqual({
      status: "failed",
      code: "AUTOMATION_PERSISTENCE_UNAVAILABLE",
      message: "定时任务服务暂时不可用，请稍后重试。",
      correctable: false,
      fatal: true,
    });
  });
});

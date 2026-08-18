import { describe, expect, it } from "vitest";
import { nextScheduledRunAt, normalizeRrule, normalizeTimeZone } from "./index.js";

describe("定时任务调度规则", () => {
  it("规范化固定间隔 RRULE 并计算下一次运行", () => {
    expect(normalizeRrule("freq=hourly;interval=2")).toBe("FREQ=HOURLY;INTERVAL=2");
    expect(nextScheduledRunAt("2026-08-17T00:00:00.000Z", "FREQ=DAILY;INTERVAL=1")).toBe(
      "2026-08-18T00:00:00.000Z",
    );
  });

  it("拒绝首版不支持的复杂 RRULE", () => {
    expect(() => normalizeRrule("FREQ=WEEKLY;BYDAY=MO")).toThrow();
    expect(() => normalizeRrule("FREQ=DAILY;BYHOUR=9")).toThrow();
  });

  it("验证 IANA 时区", () => {
    expect(normalizeTimeZone("Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(() => normalizeTimeZone("Mars/Base")).toThrow();
  });
});

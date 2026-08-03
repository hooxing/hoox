import { describe, expect, it } from "vitest";
import { beijingPinoTimestamp, formatBeijingLogTimestamp } from "./logging.js";

describe("API 日志时间", () => {
  it("以东八区 ISO-8601 时间展示，不依赖宿主机时区", () => {
    expect(formatBeijingLogTimestamp(new Date("2026-08-03T00:00:00.123Z"))).toBe(
      "2026-08-03T08:00:00.123+08:00",
    );
  });

  it("生成 Pino 可直接使用的 time 字段", () => {
    expect(beijingPinoTimestamp()).toMatch(/^,"time":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00"$/);
  });
});

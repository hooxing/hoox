import { describe, expect, it } from "vitest";
import { trajectoryViewerUrl } from "./operations-console.js";

describe("后台轨迹入口", () => {
  it("开发构建使用回环地址，Demo 子路径构建使用同源入口", () => {
    expect(trajectoryViewerUrl({ development: true, baseUrl: "/" })).toBe("http://127.0.0.1:4188");
    expect(trajectoryViewerUrl({ development: false, baseUrl: "/admin/" })).toBe("/trajectory/");
    expect(trajectoryViewerUrl({ development: false, baseUrl: "/" })).toBeUndefined();
  });
});

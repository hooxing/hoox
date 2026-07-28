import { describe, expect, it } from "vitest";
import { resolveApiTarget } from "./config.js";

describe("resolveApiTarget", () => {
  it("优先使用 Vite 加载的 VITE_WEB_API_TARGET", () => {
    expect(
      resolveApiTarget({
        VITE_WEB_API_TARGET: "http://127.0.0.1:3100",
        WEB_API_TARGET: "http://old",
      }),
    ).toBe("http://127.0.0.1:3100");
  });
});

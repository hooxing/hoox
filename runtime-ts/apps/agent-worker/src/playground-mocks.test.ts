import { describe, expect, it } from "vitest";
import { playgroundMockFor } from "./playground-mocks.js";

describe("Playground 工具 Mock", () => {
  it("只按可信 Playground 来源命中配置", () => {
    const mocks = { client_lookup: { ok: true } };
    expect(playgroundMockFor("playground", mocks, "client_lookup")).toEqual({
      matched: true,
      value: { ok: true },
    });
    for (const origin of ["normal", "evaluation", "api"] as const) {
      expect(playgroundMockFor(origin, mocks, "client_lookup")).toEqual({ matched: false });
    }
  });
});

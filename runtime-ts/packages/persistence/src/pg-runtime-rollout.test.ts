import { encodeControlledToolReceipt } from "@hoox/context-policy";
import { describe, expect, it } from "vitest";
import { assertPtcReceipt } from "./pg-runtime-rollout.js";

describe("PTC 固定受控回执验证", () => {
  function body(receiptText: string): Record<string, unknown> {
    return {
      schemaVersion: 3,
      toolName: "client_lookup",
      receipt: JSON.parse(receiptText),
      truncation: {
        isTruncated: false,
        modelVisibleBytes: Buffer.byteLength(receiptText),
      },
      observation: receiptText,
    };
  }

  it("接受精确白名单中的 Playground Mock 标记", () => {
    const receipt = encodeControlledToolReceipt("client_lookup", "succeeded", "playground_mock");
    expect(assertPtcReceipt(body(receipt), undefined, false)).toEqual({
      toolName: "client_lookup",
    });
  });

  it("Mock 标记不能放宽固定回执字段白名单", () => {
    const receipt = JSON.parse(
      encodeControlledToolReceipt("client_lookup", "succeeded", "playground_mock"),
    ) as Record<string, unknown>;
    expect(() =>
      assertPtcReceipt(
        body(JSON.stringify({ ...receipt, arbitrary: "injected" })),
        undefined,
        false,
      ),
    ).toThrow("PTC 内联回执不是未截断的固定受控回执");
    expect(() =>
      assertPtcReceipt(
        body(JSON.stringify({ ...receipt, executionMode: "other" })),
        undefined,
        false,
      ),
    ).toThrow("PTC 结果不是固定受控回执");
  });
});

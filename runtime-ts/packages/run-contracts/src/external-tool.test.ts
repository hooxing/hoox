import { sha256Digest } from "@hoox/domain";
import { describe, expect, it } from "vitest";
import { validateExternalToolRetry } from "./external-tool.js";
const facts = {
  toolVersionId: "version-a",
  argsDigest: sha256Digest("a".repeat(64)),
  idempotencyKey: "call-a",
  idempotent: true,
} as const;
describe("外部工具 UNKNOWN 对账", () => {
  it("仅持久事实完全一致的显式对账重试获准", async () => {
    const reader = { readUnknownCall: async () => facts };
    await expect(
      validateExternalToolRetry({ callId: "call-a", requested: facts, reader }),
    ).resolves.toBe("authorized");
    await expect(
      validateExternalToolRetry({
        callId: "call-a",
        requested: { ...facts, toolVersionId: "version-b" },
        reader,
      }),
    ).resolves.toBe("mismatch");
    await expect(
      validateExternalToolRetry({
        callId: "call-a",
        requested: { ...facts, idempotent: false },
        reader,
      }),
    ).resolves.toBe("not_idempotent");
  });
  it("缺失 durable 原调用时保持未知", async () => {
    await expect(
      validateExternalToolRetry({
        callId: "call-a",
        requested: facts,
        reader: { readUnknownCall: async () => undefined },
      }),
    ).resolves.toBe("unknown");
  });
});

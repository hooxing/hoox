import { describe, expect, it } from "vitest";
import { artifactWebhookPayload, runWebhookPayload } from "./pg-webhooks.js";

function keys(value: object): string[] {
  return Object.keys(value).sort();
}

describe("Webhook 投递载荷白名单", () => {
  it("Run 事件只包含契约字段，ID 由状态转换确定性派生", () => {
    const input = {
      tenantId: "tenant_a",
      runId: "run_a",
      status: "cancelled",
      runVersion: "7",
      occurredAt: "2026-11-20T00:00:00.000Z",
    };
    const payload = runWebhookPayload(input);
    expect(payload).toBeDefined();
    expect(keys(payload ?? {})).toEqual(["createdAt", "data", "id", "type"]);
    expect(keys(payload?.data ?? {})).toEqual(["runId", "status"]);
    expect(payload?.type).toBe("run.cancelled");
    expect(runWebhookPayload(input)?.id).toBe(payload?.id);
    expect(runWebhookPayload({ ...input, runVersion: "8" })?.id).not.toBe(payload?.id);
    expect(runWebhookPayload({ ...input, tenantId: "tenant_b" })?.id).not.toBe(payload?.id);
    expect(payload?.id).toMatch(/^evt_[0-9a-f]{40}$/u);
  });

  it("非事件状态不产生 Run 事件", () => {
    for (const status of ["queued", "running"])
      expect(
        runWebhookPayload({
          tenantId: "tenant_a",
          runId: "run_a",
          status,
          runVersion: 1,
          occurredAt: "2026-11-20T00:00:00.000Z",
        }),
      ).toBeUndefined();
  });

  it("Artifact 事件只公开 Artifact 与 Run 标识，不包含文件名或地址", () => {
    const payload = artifactWebhookPayload({
      tenantId: "tenant_a",
      artifactId: "artifact_a",
      runId: "run_a",
      occurredAt: "2026-11-20T00:00:00.000Z",
    });
    expect(keys(payload)).toEqual(["createdAt", "data", "id", "type"]);
    expect(payload.data).toEqual({ artifactId: "artifact_a", runId: "run_a" });
    expect(JSON.stringify(payload)).not.toMatch(/name|url|path/iu);
  });
});

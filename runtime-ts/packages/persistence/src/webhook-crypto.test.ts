import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyWebhookSignature, WebhookSecretCipher, signWebhook } from "./webhook-crypto.js";

describe("Webhook secret and request signatures", () => {
  it("encrypts secrets with tenant and webhook identity bound as AAD", () => {
    const cipher = new WebhookSecretCipher("x".repeat(48));
    const encrypted = cipher.encrypt("tenant_a", "wh_a", "one-time-secret");
    expect(cipher.decrypt("tenant_a", "wh_a", encrypted)).toBe("one-time-secret");
    expect(() => cipher.decrypt("tenant_b", "wh_a", encrypted)).toThrow();
    expect(() => cipher.decrypt("tenant_a", "wh_b", encrypted)).toThrow();
  });
  it("verifies an independently reproducible v1 HMAC over timestamp, ID and body digest", () => {
    const secret = "receiver-secret";
    const body = Buffer.from('{"id":"evt_1","type":"run.succeeded"}');
    const timestamp = "1795000000000";
    const signature = signWebhook(secret, timestamp, "evt_1", body);
    expect(verifyWebhookSignature(secret, timestamp, "evt_1", body, signature)).toBe(true);
    expect(verifyWebhookSignature(secret, timestamp, "evt_2", body, signature)).toBe(false);
    expect(verifyWebhookSignature(secret, timestamp, "evt_1", Buffer.from("{}"), signature)).toBe(
      false,
    );
  });
});

// 文档示例必须能直接验证发送端生成的固定向量；示例与向量都从参考文档原文读取。
describe("Webhook 参考文档验签示例", () => {
  const vector = {
    secret: "whsec_example_fixed_vector",
    timestamp: "1767225600000",
    eventId: "evt_example",
    body: Buffer.from(
      JSON.stringify({
        id: "evt_example",
        type: "run.succeeded",
        createdAt: "2026-01-01T00:00:00.000Z",
        data: { runId: "run_example", status: "succeeded" },
      }),
    ),
    signature: "v1=bf1039d0e4342e38fd922a4d47d065da575799b5a320e474727743c6e1e6dff1",
  };
  const documentPath = fileURLToPath(
    new URL("../../../../docs/reference/webhooks.md", import.meta.url),
  );

  afterEach(() => {
    vi.useRealTimers();
  });

  async function loadDocumentedVerify(): Promise<
    (body: Buffer, eventId: string, timestamp: string, header: string, secret: string) => boolean
  > {
    const markdown = readFileSync(documentPath, "utf8");
    const block = /```ts\n([\s\S]*?function verify[\s\S]*?)```/u.exec(markdown)?.[1];
    if (block === undefined) throw new Error("文档缺少验签示例");
    const directory = mkdtempSync(join(tmpdir(), "hoox-webhook-doc-"));
    try {
      const file = join(directory, "verify.mjs");
      writeFileSync(file, `${stripTypeScriptTypes(block)}\nexport { verify };\n`);
      const loaded = (await import(pathToFileURL(file).href)) as {
        verify: Awaited<ReturnType<typeof loadDocumentedVerify>>;
      };
      return loaded.verify;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("发送端对固定向量生成文档列出的签名", () => {
    expect(signWebhook(vector.secret, vector.timestamp, vector.eventId, vector.body)).toBe(
      vector.signature,
    );
    const markdown = readFileSync(documentPath, "utf8");
    for (const value of [
      vector.secret,
      vector.timestamp,
      vector.eventId,
      vector.body.toString("utf8"),
      vector.signature,
    ])
      expect(markdown).toContain(value);
  });

  it("文档示例接受发送端签名并拒绝篡改与过期请求", async () => {
    const verify = await loadDocumentedVerify();
    vi.useFakeTimers({ now: Number(vector.timestamp) + 1_000 });
    const valid = signWebhook(vector.secret, vector.timestamp, vector.eventId, vector.body);
    expect(verify(vector.body, vector.eventId, vector.timestamp, valid, vector.secret)).toBe(true);
    expect(verify(Buffer.from("{}"), vector.eventId, vector.timestamp, valid, vector.secret)).toBe(
      false,
    );
    expect(verify(vector.body, "evt_other", vector.timestamp, valid, vector.secret)).toBe(false);
    expect(verify(vector.body, vector.eventId, vector.timestamp, valid, "other-secret")).toBe(
      false,
    );
    vi.setSystemTime(Number(vector.timestamp) + 10 * 60_000);
    expect(verify(vector.body, vector.eventId, vector.timestamp, valid, vector.secret)).toBe(false);
  });
});

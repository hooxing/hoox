import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ApiDependencies } from "../dependencies.js";
import type { AuthenticateRequest } from "../request-auth.js";
import { registerWebhookRoutes } from "./webhooks.js";

describe("Webhook 管理路由", () => {
  it("要求管理权限、校验并保存订阅且只返回一次新密钥", async () => {
    const auth = {
      principal: { kind: "user", userId: "user_a" },
      scope: { tenantId: "tenant_a", userId: "user_a" },
      tenant: { tenant: { id: "tenant_a", kind: "team" }, membership: { role: "owner" } },
    };
    const created = {
      id: "wh_test",
      name: "状态回调",
      endpointUrl: "https://1.1.1.1/events",
      eventTypes: ["run.succeeded"],
      createdAt: "2026-11-20T00:00:00.000Z",
    };
    const webhooks = {
      create: vi.fn(async () => created),
      list: vi.fn(async () => []),
      rotate: vi.fn(async () => true),
      disable: vi.fn(async () => created),
      remove: vi.fn(async () => true),
    };
    const webhookCipher = {
      encrypt: vi.fn(() => ({ version: 1, nonce: "n", ciphertext: "c", authTag: "t" })),
    };
    const authenticate = vi.fn(async () => auth) as unknown as AuthenticateRequest;
    const app = Fastify();
    registerWebhookRoutes(
      app,
      { webhooks, webhookCipher } as unknown as Pick<ApiDependencies, "webhooks" | "webhookCipher">,
      authenticate,
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/webhooks",
        headers: { "content-type": "application/json" },
        payload: {
          name: "状态回调",
          endpointUrl: "https://1.1.1.1/events",
          eventTypes: ["run.succeeded"],
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toMatchObject({ webhook: created, secret: expect.any(String) });
      expect(authenticate).toHaveBeenCalledWith(expect.anything(), "webhooks:manage");
      expect(webhookCipher.encrypt).toHaveBeenCalledWith(
        "tenant_a",
        expect.any(String),
        expect.any(String),
      );
      expect(webhooks.create).toHaveBeenCalledWith(
        expect.objectContaining({ scope: auth.scope, endpointUrl: created.endpointUrl }),
      );
    } finally {
      await app.close();
    }
  });
});

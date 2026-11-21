import type { ValidatedExternalTarget } from "@hoox/run-contracts";
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

  it.each(["解析截止", "请求取消", "短 handler 时限"])(
    "注册%s后即使 DNS 迟到返回也不创建订阅",
    async (mode) => {
      let finishResolution!: (target: ValidatedExternalTarget) => void;
      let started!: () => void;
      const resolutionStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const controller = new AbortController();
      const create = vi.fn(async () => ({ id: "wh_late" }));
      const app = Fastify({ handlerTimeout: mode === "短 handler 时限" ? 40 : 0 });
      if (mode === "请求取消")
        app.addHook("preHandler", async (request) => {
          Object.defineProperty(request, "signal", { value: controller.signal });
        });
      registerWebhookRoutes(
        app,
        {
          webhooks: { create, list: vi.fn(), rotate: vi.fn(), disable: vi.fn(), remove: vi.fn() },
          webhookCipher: {
            encrypt: vi.fn(() => ({ version: 1, nonce: "n", ciphertext: "c", authTag: "t" })),
          },
        } as unknown as Pick<ApiDependencies, "webhooks" | "webhookCipher">,
        (async () => ({
          principal: { kind: "user", userId: "user_a" },
          scope: { tenantId: "tenant_a", userId: "user_a" },
          tenant: { tenant: { id: "tenant_a", kind: "team" }, membership: { role: "owner" } },
        })) as unknown as AuthenticateRequest,
        {
          resolutionDeadlineMs: mode === "解析截止" ? 10 : 3_000,
          resolveTarget: () =>
            new Promise((resolve) => {
              finishResolution = resolve;
              started();
            }),
        },
      );
      try {
        const responsePromise = app.inject({
          method: "POST",
          url: "/v1/webhooks",
          headers: { "content-type": "application/json" },
          payload: {
            name: "late",
            endpointUrl: "https://late.example/hook",
            eventTypes: ["run.succeeded"],
          },
        });
        await resolutionStarted;
        if (mode === "请求取消") controller.abort();
        const response = await responsePromise;
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(create).not.toHaveBeenCalled();
        finishResolution({
          url: new URL("https://late.example/hook"),
          hostname: "late.example",
          servername: "late.example",
          hostHeader: "late.example",
          address: "203.0.113.1",
          addresses: ["203.0.113.1"],
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(create).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
});

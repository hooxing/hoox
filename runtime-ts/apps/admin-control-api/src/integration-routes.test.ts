import { userId } from "@hoox/domain";
import { IntegrationAdminError } from "@hoox/persistence/admin";
import type { validateExternalHttpsTarget } from "@hoox/tool-router";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createAdminControlApiApp, type AdminControlApiDependencies } from "./app.js";
import { registerIntegrationRoutes, type IntegrationAdminPort } from "./integration-routes.js";

type ValidatedExternalTarget = Awaited<ReturnType<typeof validateExternalHttpsTarget>>;

function repository() {
  return {
    assertAccess: vi.fn(async () => undefined),
    listKeys: vi.fn(async () => []),
    createKey: vi.fn(),
    rotateKey: vi.fn(),
    revokeKey: vi.fn(),
    listWebhooks: vi.fn(async () => []),
    createWebhook: vi.fn(),
    rotateWebhook: vi.fn(),
    disableWebhook: vi.fn(),
    removeWebhook: vi.fn(),
  };
}

function appFixture() {
  const integrations = repository();
  const app = createAdminControlApiApp({
    integrations,
    auth: {
      async resolve(input) {
        return input.authorization === "Bearer administrator"
          ? { userId: userId("admin_test") }
          : undefined;
      },
    },
    control: {} as AdminControlApiDependencies["control"],
    identity: {} as AdminControlApiDependencies["identity"],
    modelCatalog: {} as AdminControlApiDependencies["modelCatalog"],
    skills: {} as AdminControlApiDependencies["skills"],
    readiness: { async probe() {} },
  });
  return { app, integrations };
}

describe("后台接入路由", () => {
  const base = "/v1/admin/control/integrations/tenant_test";
  it("未认证身份不触达仓储，服务 Key 不成为后台身份", async () => {
    const { app, integrations } = appFixture();
    try {
      for (const authorization of [undefined, "Bearer hoox_sk_test-placeholder"]) {
        const result = await app.inject({
          method: "GET",
          url: `${base}/api-keys`,
          ...(authorization === undefined ? {} : { headers: { authorization } }),
        });
        expect(result.statusCode).toBe(401);
      }
      expect(integrations.listKeys).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("目标 Tenant 来自路由，仓储拒绝的非管理员返回稳定错误", async () => {
    const { app, integrations } = appFixture();
    try {
      integrations.listKeys.mockRejectedValueOnce(new IntegrationAdminError("NOT_AUTHORIZED"));
      const result = await app.inject({
        method: "GET",
        url: `${base}/api-keys`,
        headers: { authorization: "Bearer administrator", "x-tenant-id": "tenant_foreign" },
      });
      expect(result.statusCode).toBe(401);
      expect(integrations.listKeys).toHaveBeenCalledWith("admin_test", "tenant_test");
      expect(result.headers["cache-control"]).toContain("no-store");
    } finally {
      await app.close();
    }
  });

  it("未配置根密钥失败关闭，异常消息不包含在错误响应中", async () => {
    const { app, integrations } = appFixture();
    try {
      integrations.rotateWebhook.mockRejectedValueOnce(new IntegrationAdminError("UNAVAILABLE"));
      const result = await app.inject({
        method: "POST",
        url: `${base}/webhooks/wh_test/rotate-secret`,
        headers: { authorization: "Bearer administrator" },
      });
      expect(result.statusCode).toBe(503);
      integrations.rotateKey.mockRejectedValueOnce(new Error("must-not-display-secret"));
      const failed = await app.inject({
        method: "POST",
        url: `${base}/api-keys/key_test/rotate`,
        headers: { authorization: "Bearer administrator" },
      });
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain("must-not-display-secret");
    } finally {
      await app.close();
    }
  });

  it.each([
    { name: "   ", endpointUrl: "https://1.1.1.1/events", eventTypes: ["run.succeeded"] },
    { name: "回调", endpointUrl: "https://1.1.1.1/events", eventTypes: ["unknown"] },
    {
      name: "回调",
      endpointUrl: "https://1.1.1.1/events",
      eventTypes: ["run.succeeded", "run.succeeded"],
    },
  ])("Webhook 非法名称或订阅在访问仓储前被拒绝：%j", async (payload) => {
    const { app, integrations } = appFixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: `${base}/webhooks`,
        headers: { authorization: "Bearer administrator" },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(integrations.assertAccess).not.toHaveBeenCalled();
      expect(integrations.createWebhook).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each(["截止", "取消", "拒绝目标", "非管理员"])(
    "Webhook 注册%s不会创建订阅或接受迟到解析",
    async (mode) => {
      let finish!: (value: ValidatedExternalTarget) => void;
      let started!: () => void;
      const resolving = new Promise<void>((resolve) => {
        started = resolve;
      });
      const resolveTarget = vi.fn(
        () =>
          new Promise<ValidatedExternalTarget>((resolve, reject) => {
            finish = resolve;
            started();
            if (mode === "拒绝目标") reject(new Error("must-not-display-secret"));
          }),
      );
      const integrations = repository();
      if (mode === "非管理员")
        integrations.assertAccess.mockRejectedValueOnce(
          new IntegrationAdminError("NOT_AUTHORIZED"),
        );
      const controller = new AbortController();
      const app = Fastify({
        handlerTimeout: 200,
        ajv: { onCreate: (ajv) => ajv.addFormat("hoox-iso-utc-timestamp-v1", true) },
        serializerOpts: { ajv: { formats: { "hoox-iso-utc-timestamp-v1": true } } },
      });
      app.setErrorHandler(async (_error, _request, reply) => {
        await reply.code(400).send({ error: "注册失败" });
      });
      if (mode === "取消")
        app.addHook("preHandler", async (request) => {
          Object.defineProperty(request, "signal", { value: controller.signal });
        });
      registerIntegrationRoutes(
        app,
        integrations as IntegrationAdminPort,
        {
          async actor() {
            return "admin_test";
          },
          success: (_request, data) => ({ data }),
          requireJson() {},
          responseSchemas: (schema) => ({ 200: schema }),
          badRequest: () => {
            throw new Error("bad_request");
          },
        },
        resolveTarget,
      );
      try {
        const pending = app.inject({
          method: "POST",
          url: `${base}/webhooks`,
          payload: {
            name: "回调",
            endpointUrl: "https://late.example.invalid/events",
            eventTypes: ["run.succeeded"],
          },
        });
        const resultPromise = pending.then((result) => result);
        if (mode !== "非管理员") {
          await resolving;
          if (mode === "取消") controller.abort();
        }
        const result = await resultPromise;
        expect(result.statusCode).toBe(400);
        if (mode === "非管理员") expect(resolveTarget).not.toHaveBeenCalled();
        else
          finish({
            url: new URL("https://late.example.invalid/events"),
            addresses: ["1.1.1.1"],
          } as unknown as ValidatedExternalTarget);
        await Promise.resolve();
        expect(integrations.createWebhook).not.toHaveBeenCalled();
        expect(result.body).not.toContain("must-not-display-secret");
      } finally {
        await app.close();
      }
    },
  );
});

import type { AuthContextResolver } from "@hoox/api";
import { userId } from "@hoox/domain";
import { describe, expect, it, vi } from "vitest";
import { type AdminControlApiDependencies, createAdminControlApiApp } from "./app.js";

const modelRevision = {
  revision: 1,
  versionToken: 1,
  status: "draft" as const,
  probeStatus: "untested" as const,
  createdBy: "user_admin",
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
  configuration: {
    providerKey: "main",
    displayName: "主模型",
    protocol: "openai-compatible" as const,
    baseUrl: "https://model.example.com/v1",
    secretRef: "deployment:model" as const,
    defaultModelId: "model-a",
    models: [
      {
        id: "model-a",
        name: "Model A",
        enabled: true,
        reasoning: false,
        input: ["text" as const],
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
  },
};

function fixture() {
  const auth: AuthContextResolver = {
    resolve: vi.fn(async (input) =>
      input.authorization === "Bearer admin" ? { userId: userId("user_admin") } : undefined,
    ),
  };
  const control = {
    overview: vi.fn(),
    listModelProviders: vi.fn(async () => [modelRevision]),
    listMemoryProviders: vi.fn(async () => []),
    listRuntimeSettings: vi.fn(async () => []),
    listAudits: vi.fn(async () => []),
    createModelDraft: vi.fn(async () => modelRevision),
    createMemoryDraft: vi.fn(),
    createRuntimeSettingsDraft: vi.fn(),
    probe: vi.fn(async () => ({
      ...modelRevision,
      versionToken: 2,
      probeStatus: "healthy" as const,
    })),
    publish: vi.fn(),
  } satisfies AdminControlApiDependencies["control"];
  return {
    control,
    app: createAdminControlApiApp({ auth, control, readiness: { async probe() {} } }),
  };
}

describe("后台控制 API", () => {
  it("拒绝未认证读取且不返回内部异常正文", async () => {
    const { app } = fixture();
    const response = await app.inject({ method: "GET", url: "/v1/admin/control/model-providers" });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain("stack");
    await app.close();
  });

  it("写操作要求 JSON 和幂等键，actor 只来自认证主体", async () => {
    const { app, control } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/control/model-providers",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json",
        "idempotency-key": "control-create-0001",
      },
      payload: { ...modelRevision.configuration, reason: "切换正式模型" },
    });
    expect(response.statusCode).toBe(200);
    expect(control.createModelDraft).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: "user_admin", idempotencyKey: "control-create-0001" }),
      expect.objectContaining({ reason: "切换正式模型" }),
    );
    expect(response.body).not.toContain("apiKey");
    await app.close();
  });

  it("探测路由只传递已读取 revision，不接受客户端伪造配置", async () => {
    const { app, control } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/control/model-providers/main/revisions/1/probe",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json",
        "idempotency-key": "control-probe-0001",
      },
      payload: { expectedVersionToken: 1, reason: "发布前连接检查" },
    });
    expect(response.statusCode).toBe(200);
    expect(control.probe).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: "user_admin" }),
      expect.objectContaining({
        kind: "model_provider",
        revision: modelRevision,
        expectedVersionToken: 1,
      }),
    );
    await app.close();
  });

  it("把领域层配置校验失败稳定映射为 400", async () => {
    const { app, control } = fixture();
    control.createModelDraft.mockRejectedValueOnce(new TypeError("Provider 地址必须使用 HTTPS"));
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/control/model-providers",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json",
        "idempotency-key": "control-create-0002",
      },
      payload: { ...modelRevision.configuration, reason: "验证错误映射" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("HTTPS");
    await app.close();
  });

  it("审计读取受认证保护并限制返回条数", async () => {
    const { app, control } = fixture();
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/control/audits?limit=20",
      headers: { authorization: "Bearer admin" },
    });
    expect(response.statusCode).toBe(200);
    expect(control.listAudits).toHaveBeenCalledWith("user_admin", 20);
    await app.close();
  });
});

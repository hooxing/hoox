import { type RunExplorerRepository, RunExplorerService } from "@hoox/admin-control";
import { userId } from "@hoox/domain";
import type { AuthContextResolver } from "@hoox/identity/auth";
import { describe, expect, it, vi } from "vitest";
import { type AdminControlApiDependencies, createAdminControlApiApp } from "./app.js";

const secret = "SECRET-模型正文";

const summary = {
  tenantId: "tenant_a",
  runId: "run_1",
  threadId: "thread_1",
  threadTitle: "问题标题",
  userInput: "用户问题内容",
  status: "succeeded" as const,
  createdAt: "2026-11-19T00:00:00.000Z",
  updatedAt: "2026-11-19T00:00:10.000Z",
  agentDefinitionId: null,
  agentRevisionId: null,
  origin: null,
  attemptCount: 1,
  latestAttemptId: "attempt_1",
  finishedAt: "2026-11-19T00:00:10.000Z",
  durationMs: 10_000,
  modelCalls: 1,
  toolCalls: 0,
  failedToolCalls: 0,
  errorCount: 0,
  usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, generationDurationMs: 5 },
};

function fixture(role: "viewer" | "admin") {
  const repository = {
    resolveRole: vi.fn(async () => role),
    listRuns: vi.fn(async (_input: Parameters<RunExplorerRepository["listRuns"]>[0]) => [summary]),
    getRun: vi.fn(async () => ({
      ...summary,
      attempts: [
        {
          attemptId: "attempt_1",
          status: "succeeded",
          stage: "finished",
          createdAt: "2026-11-19T00:00:01.000Z",
        },
      ],
    })),
    readOutline: vi.fn(async () => [
      {
        attemptId: "attempt_1",
        sequence: 0,
        kind: "agent_event",
        occurredAt: "2026-11-19T00:00:02.000Z",
        payload: { type: "message.delta", delta: "" },
      },
    ]),
    readContent: vi.fn(async (_input: Parameters<RunExplorerRepository["readContent"]>[0]) => [
      {
        attemptId: "attempt_1",
        sequence: 0,
        kind: "agent_event",
        occurredAt: "2026-11-19T00:00:02.000Z",
        payload: { type: "message.delta", delta: secret },
      },
    ]),
  } satisfies RunExplorerRepository;
  const auth: AuthContextResolver = {
    resolve: vi.fn(async (input) =>
      input.authorization === "Bearer member" ? { userId: userId("user_member") } : undefined,
    ),
  };
  const app = createAdminControlApiApp({
    auth,
    runs: new RunExplorerService(repository, () => "run_content_audit_1"),
    control: {} as AdminControlApiDependencies["control"],
    identity: {} as AdminControlApiDependencies["identity"],
    modelCatalog: {} as AdminControlApiDependencies["modelCatalog"],
    skills: {} as AdminControlApiDependencies["skills"],
    readiness: { async probe() {} },
  });
  return { app, repository };
}

const headers = { authorization: "Bearer member" };

describe("后台 Run 浏览器 API", () => {
  it("未认证请求被拒绝且不触达存储", async () => {
    const { app, repository } = fixture("admin");
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/control/runs",
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(repository.listRuns).not.toHaveBeenCalled();
    await app.close();
  });

  it("列表校验筛选参数并转交服务", async () => {
    const { app, repository } = fixture("viewer");
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/admin/control/runs",
      payload: { status: "unknown" },
      headers,
    });
    expect(invalid.statusCode).toBe(400);
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/control/runs",
      payload: {
        tenantId: "tenant_a",
        status: "succeeded",
        origin: "api",
        limit: 10,
        search: "PRIVATE SEARCH",
      },
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      contentAccess: false,
      items: [{ runId: "run_1", durationMs: 10_000, agentDefinitionId: null, origin: null }],
    });
    expect(repository.listRuns.mock.calls.at(-1)?.[0]).toMatchObject({
      tenantId: "tenant_a",
      status: "succeeded",
      origin: "api",
      limit: 11,
    });
    await app.close();
  });

  it("无正文权限时详情只有结构，正文接口返回 401 且不读取正文", async () => {
    const { app, repository } = fixture("viewer");
    const detail = await app.inject({
      method: "GET",
      url: "/v1/admin/control/runs/tenant_a/run_1",
      headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data).toMatchObject({
      attemptId: "attempt_1",
      contentAccess: false,
      timeline: { records: [{ kind: "assistant", summary: "模型回复" }] },
    });
    const content = await app.inject({
      method: "GET",
      url: "/v1/admin/control/runs/tenant_a/run_1/content",
      headers,
    });
    expect(content.statusCode).toBe(401);
    expect(content.body).not.toContain(secret);
    expect(repository.readContent).not.toHaveBeenCalled();
    await app.close();
  });

  it("admin 打开详情直接读取正文并写入审计", async () => {
    const { app, repository } = fixture("admin");
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/control/runs/tenant_a/run_1/content?attemptId=attempt_1",
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.json().data).toMatchObject({
      auditId: "run_content_audit_1",
      timeline: { records: [{ kind: "assistant", detail: { text: secret } }] },
    });
    expect(repository.readContent).toHaveBeenCalledWith(
      expect.objectContaining({ auditId: "run_content_audit_1", attemptId: "attempt_1" }),
    );
    const missing = await app.inject({
      method: "GET",
      url: "/v1/admin/control/runs/tenant_a/run_1/content?attemptId=attempt_other",
      headers,
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});

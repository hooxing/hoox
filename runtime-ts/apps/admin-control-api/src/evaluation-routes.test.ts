import Fastify from "fastify";
import type { EvaluationRunSummary, EvaluationSuite } from "@hoox/protocol";
import { describe, expect, it, vi } from "vitest";
import { registerEvaluationRoutes } from "./evaluation-routes.js";

describe("评测集管理路由", () => {
  it("要求评测集归属路径中的 Agent，并保存可视化断言数据", async () => {
    const suite: EvaluationSuite = {
      id: "suite_1",
      definitionId: "agent_1",
      name: "基础验收",
      description: "检查回复",
      cases: [
        {
          id: "case_1",
          name: "包含确认语",
          inputText: "提交订单",
          attachments: [],
          assertions: [{ kind: "text_contains", value: "已完成" }],
        },
      ],
    };
    const service = {
      listSuites: vi.fn(async () => [suite]),
      saveSuite: vi.fn(async () => undefined),
      deleteSuite: vi.fn(async () => true),
      startRun: vi.fn(
        async (): Promise<EvaluationRunSummary | undefined> => ({
          id: "evaluation_run_1",
          definitionId: "agent_1",
          suiteId: "suite_1",
          revisionId: "revision_1",
          status: "queued" as const,
          maxConcurrency: 2,
          totalCases: 1,
          passedCases: 0,
          passRate: 0,
          failedCases: 0,
          unknownCases: 0,
          cancelledCases: 0,
          createdAt: "2026-11-22T00:00:00.000Z",
        }),
      ),
      listRuns: vi.fn(async () => []),
      readRun: vi.fn(async () => undefined),
      cancelRun: vi.fn(async () => false),
      compareRuns: vi.fn(async () => undefined),
    };
    const app = Fastify();
    registerEvaluationRoutes(app, service, {
      actor: async () => "admin_1",
      success: (_request, data) => ({ version: "v1", requestId: "request_1", data }),
      requireJson: () => undefined,
      responseSchemas: (schema) => ({ 200: schema }),
      notFound: () => {
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      },
    });
    await app.ready();
    const saved = await app.inject({
      method: "PUT",
      url: "/v1/admin/control/agent-definitions/agent_1/evaluations",
      headers: { "content-type": "application/json" },
      payload: suite,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(service.saveSuite).toHaveBeenCalledWith("admin_1", suite);
    const listed = await app.inject({
      method: "GET",
      url: "/v1/admin/control/agent-definitions/agent_1/evaluations",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data[0].cases[0].assertions[0]).toEqual({
      kind: "text_contains",
      value: "已完成",
    });
    const started = await app.inject({
      method: "POST",
      url: "/v1/admin/control/agent-definitions/agent_1/evaluations/suite_1/runs",
      headers: { "content-type": "application/json" },
      payload: { id: "evaluation_run_1", revisionId: "revision_1", maxConcurrency: 2 },
    });
    expect(started.statusCode, started.body).toBe(200);
    expect(service.startRun).toHaveBeenCalledWith("admin_1", {
      id: "evaluation_run_1",
      revisionId: "revision_1",
      maxConcurrency: 2,
      suiteId: "suite_1",
      definitionId: "agent_1",
    });
    service.startRun.mockResolvedValueOnce(undefined);
    const mismatchedRun = await app.inject({
      method: "POST",
      url: "/v1/admin/control/agent-definitions/agent_other/evaluations/suite_1/runs",
      headers: { "content-type": "application/json" },
      payload: { id: "evaluation_run_2", revisionId: "revision_1", maxConcurrency: 2 },
    });
    expect(mismatchedRun.statusCode).toBe(404);
    expect(service.startRun).toHaveBeenLastCalledWith("admin_1", {
      id: "evaluation_run_2",
      revisionId: "revision_1",
      maxConcurrency: 2,
      suiteId: "suite_1",
      definitionId: "agent_other",
    });
    service.deleteSuite.mockResolvedValueOnce(false);
    const mismatchedDelete = await app.inject({
      method: "DELETE",
      url: "/v1/admin/control/agent-definitions/agent_other/evaluations/suite_1",
    });
    expect(mismatchedDelete.statusCode).toBe(404);
    expect(service.deleteSuite).toHaveBeenCalledWith("admin_1", "agent_other", "suite_1");
    await app.close();
  }, 15000);
});

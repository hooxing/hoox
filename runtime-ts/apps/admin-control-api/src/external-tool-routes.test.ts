import {
  ExternalToolAdminError,
  ExternalToolAdminService,
  type ExternalToolAdminRepositoryPort,
} from "@hoox/admin-control";
import { userId } from "@hoox/domain";
import { describe, expect, it, vi } from "vitest";
import { type AdminControlApiDependencies, createAdminControlApiApp } from "./app.js";

const base = "/v1/admin/control/external-tools";
const headers = { authorization: "Bearer test-token", "idempotency-key": "command-1" };
const actorUserId = "user_admin";
const settings = {
  serverName: "srv",
  displayName: "目录",
  endpoint: "https://example.invalid/mcp",
  timeoutMs: 1000,
  maxResponseBytes: 4096,
  sideEffect: "read_only",
  idempotent: true,
} as const;
const draft = {
  ...settings,
  source: "mcp" as const,
  draftId: "draft_one",
  generation: 1,
  credentialConfigured: true,
  publishedBatchCount: 0,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};
const batch = {
  batchId: "batch_one",
  draftId: draft.draftId,
  sequence: 1,
  displayName: settings.displayName,
  source: "mcp" as const,
  serverName: settings.serverName,
  endpoint: settings.endpoint,
  draftGeneration: 1,
  createdAt: draft.createdAt,
  createdBy: actorUserId,
  revoked: false,
  tools: [],
};
function fixture() {
  const repository = {
    overview: vi.fn(async () => ({ drafts: [draft], batches: [] })),
    requireAdmin: vi.fn(),
    createMcpDraft: vi.fn(async () => ({ ...draft, credential: "write-only-test" })),
    updateMcpDraft: vi.fn(async () => draft),
    setDraftCredential: vi.fn(async () => ({ ...draft, credentialConfigured: false })),
    loadDraftForProbe: vi.fn(async () => ({ draft })),
    replayPublish: vi.fn(),
    withPublishClaim: vi.fn<ExternalToolAdminRepositoryPort["withPublishClaim"]>(
      async (_input, execute) => execute("test-lease-owner"),
    ),
    recordProbeAudit: vi.fn(),
    publishMcpBatch: vi.fn(async () => batch),
    revokeBatch: vi.fn(async () => ({ ...batch, revoked: true })),
  } satisfies ExternalToolAdminRepositoryPort;
  const inputSchema = { type: "object", additionalProperties: false, properties: {} };
  const preview = {
    modelToolName: "http__lookup",
    description: "",
    endpoint: settings.endpoint,
    method: "POST" as const,
    inputSchema,
    inputSchemaDigest: "a".repeat(64),
    timeoutMs: 1000,
    maxResponseBytes: 4096,
    sideEffect: "write" as const,
    idempotent: false,
    publishable: false as const,
  };
  const service = new ExternalToolAdminService(
    repository,
    async () => [
      {
        accepted: true,
        remoteToolName: "lookup",
        modelToolName: "mcp__srv__lookup",
        description: "",
        inputSchema,
        inputSchemaDigest: "b".repeat(64),
      },
    ],
    () => preview,
  );
  const app = createAdminControlApiApp({
    externalTools: service,
    auth: {
      resolve: async ({ authorization }) =>
        authorization === headers.authorization ? { userId: userId(actorUserId) } : undefined,
    },
    control: {} as AdminControlApiDependencies["control"],
    identity: {} as AdminControlApiDependencies["identity"],
    modelCatalog: {} as AdminControlApiDependencies["modelCatalog"],
    skills: {} as AdminControlApiDependencies["skills"],
    readiness: { probe: async () => {} },
  });
  return { app, repository, preview };
}

describe("统一后台外部工具 API", () => {
  it("页面的八个端点使用原有方法、路径与响应信封，凭据只写", async () => {
    const { app, repository, preview } = fixture();
    let actualTimeout = 0;
    app.addHook("onResponse", async (request) => {
      actualTimeout = request.routeOptions.handlerTimeout;
    });
    const path = `${base}/mcp-drafts/${draft.draftId}`;
    const gen = { expectedGeneration: 1 };
    try {
      for (const [method, url, payload, status, data] of [
        ["GET", base, undefined, 200, { drafts: [draft], batches: [] }],
        [
          "POST",
          `${base}/mcp-drafts`,
          {
            settings,
            draftId: draft.draftId,
            credential: "write-only-test",
            expectedGeneration: 0,
          },
          201,
          draft,
        ],
        ["PUT", path, { settings, ...gen }, 200, draft],
        [
          "PUT",
          `${path}/credential`,
          { credential: null, ...gen },
          200,
          { ...draft, credentialConfigured: false },
        ],
        ["POST", `${path}/probe`, gen, 200, { publishable: true }],
        ["POST", `${path}/publish`, gen, 201, batch],
        [
          "POST",
          `${base}/batches/${batch.batchId}/revoke`,
          { reason: "已停用" },
          200,
          { ...batch, revoked: true },
        ],
        [
          "POST",
          `${base}/http/preview`,
          {
            mode: "endpoint",
            toolName: "lookup",
            description: "",
            method: "POST",
            endpoint: settings.endpoint,
            inputSchema: preview.inputSchema,
          },
          200,
          preview,
        ],
      ] as const) {
        const response = await app.inject({
          method,
          url,
          headers,
          ...(payload === undefined ? {} : { payload }),
        });
        expect(actualTimeout).toBe(
          url.endsWith("/probe") || url.endsWith("/publish") ? 180_000 : 60_000,
        );
        expect(response.statusCode, `${method} ${url}`).toBe(status);
        expect(response.json()).toMatchObject({
          version: "v1",
          requestId: expect.any(String),
          data,
        });
        expect(response.body.includes("write-only-test")).toBe(false);
      }
      expect(repository.setDraftCredential).toHaveBeenCalledWith({
        ...gen,
        credential: null,
        draftId: draft.draftId,
        actorUserId,
        idempotencyKey: headers["idempotency-key"],
      });
      expect(repository.requireAdmin).toHaveBeenCalledWith(actorUserId);
    } finally {
      await app.close();
    }
  });
  it("拒绝未认证、缺少幂等键和不严格的凭据写入，映射领域失败而不回显原始错误", async () => {
    const { app, repository } = fixture();
    const url = `${base}/mcp-drafts/draft_one/credential`;
    try {
      expect((await app.inject({ url: base })).statusCode).toBe(401);
      expect(repository.overview).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            url,
            method: "PUT",
            headers: { authorization: headers.authorization },
            payload: { credential: null, expectedGeneration: 1 },
          })
        ).statusCode,
      ).toBe(400);
      for (const credential of [false, 0, [], ""]) {
        expect(
          (
            await app.inject({
              url,
              method: "PUT",
              headers,
              payload: { credential, expectedGeneration: 1 },
            })
          ).statusCode,
        ).toBe(400);
      }
      expect(repository.setDraftCredential).not.toHaveBeenCalled();
      for (const [code, status] of [
        ["NOT_AUTHORIZED", 401],
        ["CONFLICT", 409],
        ["NOT_FOUND", 404],
        ["PROBE_UNAVAILABLE", 503],
        ["PUBLISH_RESULT_UNKNOWN", 503],
        ["PUBLISH_REJECTED", 400],
      ] as const) {
        repository.overview.mockRejectedValueOnce(new ExternalToolAdminError(code, "受控错误"));
        expect((await app.inject({ url: base, headers })).statusCode).toBe(status);
      }
      repository.overview.mockRejectedValueOnce(new Error("write-only-test"));
      const error = await app.inject({ url: base, headers });
      expect(error.statusCode).toBe(500);
      expect(error.body.includes("write-only-test")).toBe(false);
    } finally {
      await app.close();
    }
  });
  it("发布结果未知返回 503 并要求使用原幂等键查询，不重复写入", async () => {
    const { app, repository } = fixture();
    const message = "发布结果暂时无法确认；请使用相同幂等键查询或重试";
    repository.publishMcpBatch.mockRejectedValueOnce(
      new ExternalToolAdminError("PUBLISH_RESULT_UNKNOWN", message),
    );
    try {
      const response = await app.inject({
        url: `${base}/mcp-drafts/${draft.draftId}/publish`,
        method: "POST",
        headers,
        payload: { expectedGeneration: 1 },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { message } });
      expect(repository.publishMcpBatch).toHaveBeenCalledTimes(1);
      expect(repository.publishMcpBatch).toHaveBeenCalledWith(
        expect.objectContaining({ leaseOwner: "test-lease-owner" }),
      );
    } finally {
      await app.close();
    }
  });
});

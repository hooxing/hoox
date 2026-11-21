import { describe, it, expect, vi } from "vitest";
import {
  ExternalToolAdminService,
  externalToolAccess,
  ExternalToolAdminError,
  type ExternalToolAdminRepositoryPort,
  type McpProbePort,
  type McpProbeToolResult,
} from "./external-tools.js";

const credential = 'test-only-"opaque\\value';
const context = { actorUserId: "user_admin", draftId: "draft_one", expectedGeneration: 2 };
const command = { ...context, idempotencyKey: "command-1" };
const accepted = {
  accepted: true,
  remoteToolName: "lookup",
  modelToolName: "mcp__srv__lookup",
  description: "查找",
  inputSchemaDigest: "a".repeat(64),
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
} as const;
function fixture() {
  const draft = {
    draftId: context.draftId,
    source: "mcp" as const,
    serverName: "srv",
    displayName: "Server",
    endpoint: "https://example.invalid/mcp",
    timeoutMs: 1000,
    maxResponseBytes: 4096,
    sideEffect: "read_only" as const,
    idempotent: true,
    credentialConfigured: true,
    generation: 2,
    publishedBatchCount: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const repository = {
    overview: vi.fn(),
    requireAdmin: vi.fn(),
    createMcpDraft: vi.fn(),
    updateMcpDraft: vi.fn(),
    setDraftCredential: vi.fn(),
    revokeBatch: vi.fn(),
    replayPublish: vi.fn<ExternalToolAdminRepositoryPort["replayPublish"]>(),
    loadDraftForProbe: vi.fn(async () => ({ draft, credential })),
    recordProbeAudit: vi.fn<ExternalToolAdminRepositoryPort["recordProbeAudit"]>(),
    publishMcpBatch: vi.fn(),
  } satisfies ExternalToolAdminRepositoryPort;
  const probe = vi.fn<McpProbePort>().mockResolvedValue([accepted]);
  const preview = vi.fn();
  return {
    draft,
    repository,
    probe,
    preview,
    service: new ExternalToolAdminService(repository, probe, preview),
  };
}

describe("外部工具管理服务", () => {
  it.each([
    { ...accepted, remoteToolName: `prefix${credential}` },
    { ...accepted, description: credential },
    { ...accepted, inputSchema: { properties: { [credential]: { type: "string" } } } },
    { ...accepted, inputSchema: { properties: { arg: { enum: [`x${credential}`] } } } },
    {
      accepted: false,
      remoteToolName: credential,
      reason: "MCP_SCHEMA_REJECTED",
      reasonMessage: "不支持",
    },
  ] satisfies McpProbeToolResult[])(
    "反射凭据的元数据不能进入报告、审计或发布版本",
    async (unsafe) => {
      const { repository, service, probe } = fixture();
      probe.mockResolvedValue([accepted, unsafe]);
      const report = await service.probe(context);
      expect(report.publishable).toBe(false);
      expect(report.tools[1]).toEqual({
        accepted: false,
        reason: "MCP_UNSAFE_METADATA",
        reasonMessage: "远端工具元数据不允许展示或发布",
      });
      await expect(service.publish(command)).rejects.toMatchObject({
        code: "PUBLISH_REJECTED",
        message: "1 个工具不符合平台要求，整批未发布",
      });
      expect(repository.publishMcpBatch).not.toHaveBeenCalled();
      expect(repository.recordProbeAudit.mock.calls.map(([audit]) => audit.reason)).toEqual([
        "共 2 个工具，1 个不符合要求",
        "共 2 个工具，1 个不符合要求",
      ]);
    },
  );
  it("不记录远端异常消息；空清单不能发布", async () => {
    const { repository, service, probe } = fixture();
    probe.mockRejectedValue(new Error(credential));
    const report = await service.probe(context);
    expect(report.failure).toEqual({
      code: "EXTERNAL_TOOL_UNAVAILABLE",
      message: "无法连接 MCP Server 或响应不符合协议",
    });
    await expect(service.publish(command)).rejects.toMatchObject({
      code: "PROBE_UNAVAILABLE",
      message: `发布前探测失败：${report.failure?.message}`,
    });
    expect(repository.recordProbeAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: report.failure?.message }),
    );
    probe.mockResolvedValue([]);
    await expect(service.publish(command)).rejects.toMatchObject({ code: "PUBLISH_REJECTED" });
    expect(repository.publishMcpBatch).not.toHaveBeenCalled();
  });
  it("报告省略 Schema；发布重新探测，已有幂等结果不访问远端", async () => {
    const { repository, service, probe } = fixture();
    const report = await service.probe(context);
    expect(report.publishable).toBe(true);
    expect(report.tools[0]).not.toHaveProperty("inputSchema");
    const next = { ...accepted, description: "新版本" };
    probe.mockResolvedValue([next]);
    await service.publish(command);
    const { accepted: _accepted, ...tool } = next;
    expect(repository.publishMcpBatch).toHaveBeenCalledWith({ ...command, tools: [tool] });
    const batch = {
      batchId: "batch_one",
      draftId: context.draftId,
      sequence: 1,
      displayName: "测试",
      source: "mcp" as const,
      serverName: "srv",
      endpoint: "https://example.invalid/mcp",
      draftGeneration: 2,
      createdAt: new Date(0).toISOString(),
      createdBy: context.actorUserId,
      revoked: false,
      tools: [],
    };
    repository.replayPublish.mockResolvedValue(batch);
    await expect(service.publish(command)).resolves.toEqual(batch);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(repository.publishMcpBatch).toHaveBeenCalledTimes(1);
  });
  it("非管理员不能预览或带凭据探测", async () => {
    for (const role of [undefined, "viewer", "operator"] as const)
      expect(externalToolAccess(role).canRegister).toBe(false);
    const { repository, service, probe, preview } = fixture();
    const denied = new ExternalToolAdminError("NOT_AUTHORIZED", "仅限管理员");
    repository.requireAdmin.mockRejectedValue(denied);
    repository.loadDraftForProbe.mockRejectedValue(denied);
    await expect(service.probe(context)).rejects.toBe(denied);
    await expect(
      service.previewHttpTool(context.actorUserId, {
        mode: "openapi",
        toolName: "lookup",
        description: "",
        document: {},
      }),
    ).rejects.toBe(denied);
    expect(preview).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });
});

it("不持久化含查询凭据、URL 身份、片段或规范化后超长的 MCP 地址", () => {
  const { service, draft, repository } = fixture();
  for (const endpoint of [
    "https://example.invalid/?token=placeholder",
    "https://example.invalid/#fragment",
    "https://user@example.invalid/",
    `https://example.invalid/${"汉".repeat(254)}`,
  ]) {
    expect(() => service.updateMcpDraft({ ...command, settings: { ...draft, endpoint } })).toThrow(
      ExternalToolAdminError,
    );
  }
  expect(repository.updateMcpDraft).not.toHaveBeenCalled();
});

it("凭据不合法时不触达存储或回显输入", () => {
  const { service, repository } = fixture();
  for (const credential of [
    "",
    "placeholder\r\nheader",
    "leading-space ",
    "内嵌\u0000字符",
    "x".repeat(8193),
  ]) {
    expect(() => service.setDraftCredential({ ...command, credential })).toThrow(
      ExternalToolAdminError,
    );
  }
  expect(repository.setDraftCredential).not.toHaveBeenCalled();
});

import {
  agentThreadId,
  appendResourceVersion,
  createResource,
  isoTimestamp,
  type Resource,
  type ResourceVersion,
  resourceId,
  resourceVersionId,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  userId,
  workspaceId,
  workspaceRevisionId,
} from "@cube-runtime/domain";
import { describe, expect, it } from "vitest";
import type {
  AgentResourceAccessScope,
  ResourceAccessScope,
  ResourceCatalog,
  ResourceContentReader,
  ResourceSearchItem,
  WorkspaceImportTargetInspector,
  WorkspacePromotionAuthorizer,
} from "./contracts.js";
import { createResourceCursorCodec } from "./cursor.js";
import { ResourceLibraryService } from "./service.js";

const scopeA: ResourceAccessScope = {
  tenantId: tenantId("tenant-a-test"),
  userId: userId("user-a-test"),
};
const scopeB: ResourceAccessScope = {
  tenantId: tenantId("tenant-b-test"),
  userId: userId("user-b-test"),
};
const resourceAId = resourceId("resource-a-test");
const versionOneId = resourceVersionId("version-one-test");
const versionTwoId = resourceVersionId("version-two-test");
const targetWorkspaceId = workspaceId("workspace-b-test");
const sourceRevisionId = workspaceRevisionId("revision-source-test");
const digestOne = sha256Digest("1".repeat(64));
const digestTwo = sha256Digest("2".repeat(64));

function fixture() {
  const initial = createResource({
    id: resourceAId,
    tenantId: scopeA.tenantId,
    name: "项目说明.md",
    origin: "upload",
    now: isoTimestamp("2026-07-26T01:00:00.000Z"),
  });
  const first = appendResourceVersion({
    resource: initial,
    tenantId: scopeA.tenantId,
    versionId: versionOneId,
    expectedLatestVersionNumber: 0,
    objectKey: "private/tenant-a/secret-object-one",
    digest: digestOne,
    mediaType: "text/markdown; charset=utf-8",
    sizeBytes: 12,
    now: isoTimestamp("2026-07-26T02:00:00.000Z"),
  });
  const second = appendResourceVersion({
    resource: first.resource,
    tenantId: scopeA.tenantId,
    versionId: versionTwoId,
    expectedLatestVersionNumber: 1,
    objectKey: "private/tenant-a/secret-object-two",
    digest: digestTwo,
    mediaType: "text/markdown",
    sizeBytes: 18,
    now: isoTimestamp("2026-07-26T03:00:00.000Z"),
  });
  return { resource: second.resource, versionOne: first.version, versionTwo: second.version };
}

class FakeCatalog implements ResourceCatalog {
  readonly searches: Array<Parameters<ResourceCatalog["search"]>[0]> = [];
  constructor(
    private readonly resource: Resource,
    private readonly versions: readonly ResourceVersion[],
    readonly searchItems: readonly ResourceSearchItem[],
  ) {}

  async search(input: Parameters<ResourceCatalog["search"]>[0]) {
    this.searches.push(input);
    if (input.scope.tenantId !== this.resource.tenantId) return { items: [] };
    const items = this.searchItems.slice(0, input.limit);
    const last = items.at(-1);
    return {
      items,
      ...(last === undefined
        ? {}
        : { nextPosition: { updatedAt: last.updatedAt, resourceId: last.resourceId } }),
    };
  }

  async resolveVersion(input: Parameters<ResourceCatalog["resolveVersion"]>[0]) {
    if (input.scope.tenantId !== this.resource.tenantId || input.resourceId !== this.resource.id) {
      return { status: "not_found" as const };
    }
    const version = this.versions.find((candidate) => candidate.id === input.versionId);
    return version === undefined
      ? { status: "not_found" as const }
      : { status: "found" as const, resource: this.resource, version };
  }
}

class FakeReader implements ResourceContentReader {
  readonly reads: Array<Parameters<ResourceContentReader["readRange"]>[0]> = [];
  body = new TextEncoder().encode("abcdefghijklmnopqr");
  extraByte = false;

  async readRange(input: Parameters<ResourceContentReader["readRange"]>[0]) {
    this.reads.push(input);
    const bytes = this.body.slice(input.range.offset, input.range.offset + input.range.length);
    return this.extraByte ? new Uint8Array([...bytes, 255]) : bytes;
  }
}

class FakeImportTargets implements WorkspaceImportTargetInspector {
  outcome: "available" | "occupied" | "not_found" = "available";
  readonly inspections: Array<Parameters<WorkspaceImportTargetInspector["inspect"]>[0]> = [];
  async inspect(input: Parameters<WorkspaceImportTargetInspector["inspect"]>[0]) {
    this.inspections.push(input);
    return { status: this.outcome };
  }
}

class FakePromotionAuthorizer implements WorkspacePromotionAuthorizer {
  mismatchTenant = false;
  expired = false;
  readonly calls: Array<Parameters<WorkspacePromotionAuthorizer["authorizeSnapshot"]>[0]> = [];
  async authorizeSnapshot(input: Parameters<WorkspacePromotionAuthorizer["authorizeSnapshot"]>[0]) {
    this.calls.push(input);
    return {
      status: "authorized" as const,
      authorization: {
        authorizationId: "promotion-auth-0001",
        tenantId: this.mismatchTenant ? scopeB.tenantId : input.scope.tenantId,
        workspaceId: input.workspaceId,
        revisionId: input.revisionId,
        relativePath: input.safeRelativePath,
        digest: digestTwo,
        mediaType: "text/markdown",
        sizeBytes: 18,
        expiresAt: isoTimestamp(
          this.expired ? "2026-07-26T03:59:59.000Z" : "2026-07-26T04:05:00.000Z",
        ),
      },
    };
  }
}

function setup(searchItems?: readonly ResourceSearchItem[]) {
  const data = fixture();
  const defaultItem: ResourceSearchItem = {
    resourceId: data.resource.id,
    versionId: data.versionTwo.id,
    versionNumber: data.versionTwo.versionNumber,
    name: data.resource.name,
    origin: data.resource.origin,
    mediaType: data.versionTwo.mediaType,
    sizeBytes: data.versionTwo.sizeBytes,
    updatedAt: data.resource.updatedAt,
  };
  const catalog = new FakeCatalog(
    data.resource,
    [data.versionOne, data.versionTwo],
    searchItems ?? [defaultItem],
  );
  const reader = new FakeReader();
  const importTargets = new FakeImportTargets();
  const promotionAuthorizer = new FakePromotionAuthorizer();
  const cursorCodec = createResourceCursorCodec({
    activeKid: "current",
    keys: [{ kid: "current", secret: new Uint8Array(32).fill(7) }],
    ttlSeconds: 300,
    now: () => new Date("2026-07-26T04:00:00.000Z"),
  });
  const service = new ResourceLibraryService(
    { catalog, contentReader: reader, cursorCodec, importTargets, promotionAuthorizer },
    {
      maxPageSize: 50,
      maxPreviewBytes: 8,
      defaultPreviewBytes: 4,
      now: () => new Date("2026-07-26T04:00:00.000Z"),
    },
  );
  return { data, catalog, reader, importTargets, promotionAuthorizer, cursorCodec, service };
}

describe("Resource Library 发现", () => {
  it("规范化查询、限制页大小并只返回受限元数据", async () => {
    const { service, catalog } = setup();
    const result = await service.search({ scope: scopeA, query: "  项目\t说明  ", pageSize: 1 });

    expect(catalog.searches[0]?.normalizedQuery).toBe("项目 说明");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).not.toHaveProperty("objectKey");
    expect(result.items[0]).not.toHaveProperty("content");
    expect(result.nextCursor).toEqual(expect.any(String));
    await expect(service.search({ scope: scopeA, pageSize: 51 })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("签名游标绑定 Tenant、User 和查询并拒绝篡改", async () => {
    const { service } = setup();
    const first = await service.search({ scope: scopeA, query: "项目" });
    const cursor = first.nextCursor ?? "";
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;

    await expect(
      service.search({ scope: scopeA, query: "项目", cursor: tampered }),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(service.search({ scope: scopeB, query: "项目", cursor })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(
      service.search({
        scope: { ...scopeA, userId: userId("another-user-test") },
        query: "项目",
        cursor,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(service.search({ scope: scopeA, query: "其他", cursor })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("游标过期后失效，并可在密钥轮换窗口读取旧 kid", () => {
    let current = new Date("2026-07-26T04:00:00.000Z");
    const oldSecret = new Uint8Array(32).fill(3);
    const oldCodec = createResourceCursorCodec({
      activeKid: "old",
      keys: [{ kid: "old", secret: oldSecret }],
      ttlSeconds: 30,
      now: () => current,
    });
    const position = {
      updatedAt: isoTimestamp("2026-07-26T03:00:00.000Z"),
      resourceId: resourceAId,
    };
    const cursor = oldCodec.encode({ scope: scopeA, normalizedQuery: "项目", position });
    const rotated = createResourceCursorCodec({
      activeKid: "new",
      keys: [
        { kid: "old", secret: oldSecret },
        { kid: "new", secret: new Uint8Array(32).fill(4) },
      ],
      ttlSeconds: 30,
      now: () => current,
    });
    expect(rotated.decode({ scope: scopeA, normalizedQuery: "项目", cursor })).toEqual(position);

    current = new Date("2026-07-26T04:00:31.000Z");
    expect(() => rotated.decode({ scope: scopeA, normalizedQuery: "项目", cursor })).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("拒绝目录适配器返回不确定排序，过程文件不会被核心自动发现", async () => {
    const data = fixture();
    const older: ResourceSearchItem = {
      resourceId: resourceId("resource-z-test"),
      versionId: versionTwoId,
      versionNumber: 2,
      name: "较旧",
      origin: "upload",
      mediaType: "text/plain",
      sizeBytes: 1,
      updatedAt: isoTimestamp("2026-07-26T02:00:00.000Z"),
    };
    const newer: ResourceSearchItem = {
      ...older,
      resourceId: data.resource.id,
      name: "较新",
      updatedAt: data.resource.updatedAt,
    };
    const { service } = setup([older, newer]);
    await expect(service.search({ scope: scopeA })).rejects.toMatchObject({
      code: "CONTENT_INTEGRITY_ERROR",
    });

    // Workspace 过程文件没有 Resource 元数据，目录端口也没有 Workspace 自动发现入口。
    const empty = setup([]);
    await expect(empty.service.search({ scope: scopeA, query: "scratch.tmp" })).resolves.toEqual({
      items: [],
    });
  });
});

describe("Resource 局部预览", () => {
  it("只用授权后的不可变版本读取范围，忽略调用方伪造的 objectKey", async () => {
    const { service, reader, data } = setup();
    const request = {
      scope: scopeA,
      resourceId: resourceAId,
      versionId: versionTwoId,
      offset: 2,
      length: 4,
      objectKey: "attacker/forged-key",
      responseHeaders: { "content-type": "text/html" },
    };
    const result = await service.preview(request);

    expect(result).toMatchObject({ status: "available", range: { offset: 2, length: 4 } });
    expect(reader.reads[0]?.version).toBe(data.versionTwo);
    expect(reader.reads[0]?.version.objectKey).toBe("private/tenant-a/secret-object-two");
    expect(new TextDecoder().decode(result.status === "available" ? result.bytes : undefined)).toBe(
      "cdef",
    );
  });

  it("跨租户和猜测 ID 统一不可见", async () => {
    const { service, reader } = setup();
    await expect(
      service.preview({ scope: scopeB, resourceId: resourceAId, versionId: versionTwoId }),
    ).resolves.toEqual({ status: "not_found" });
    await expect(
      service.preview({
        scope: scopeA,
        resourceId: resourceId("resource-guessed"),
        versionId: versionTwoId,
      }),
    ).resolves.toEqual({ status: "not_found" });
    expect(reader.reads).toHaveLength(0);
  });

  it("对不支持类型返回稳定结果且不读取内容", async () => {
    const data = fixture();
    const unsupported = { ...data.versionTwo, mediaType: "application/zip" } as ResourceVersion;
    const catalog = new FakeCatalog(data.resource, [unsupported], []);
    const reader = new FakeReader();
    const importTargets = new FakeImportTargets();
    const promotionAuthorizer = new FakePromotionAuthorizer();
    const cursorCodec = createResourceCursorCodec({
      activeKid: "k",
      keys: [{ kid: "k", secret: new Uint8Array(32).fill(1) }],
      ttlSeconds: 30,
      now: () => new Date("2026-07-26T04:00:00.000Z"),
    });
    const service = new ResourceLibraryService({
      catalog,
      contentReader: reader,
      cursorCodec,
      importTargets,
      promotionAuthorizer,
    });

    await expect(
      service.preview({ scope: scopeA, resourceId: resourceAId, versionId: versionTwoId }),
    ).resolves.toEqual({ status: "unsupported_media_type", mediaType: "application/zip" });
    expect(reader.reads).toHaveLength(0);
  });

  it("拒绝超预算请求和越过授权范围的读取响应", async () => {
    const { service, reader } = setup();
    await expect(
      service.preview({
        scope: scopeA,
        resourceId: resourceAId,
        versionId: versionTwoId,
        length: 9,
      }),
    ).rejects.toMatchObject({ code: "PREVIEW_BUDGET_EXCEEDED" });

    reader.extraByte = true;
    await expect(
      service.preview({
        scope: scopeA,
        resourceId: resourceAId,
        versionId: versionTwoId,
        length: 4,
      }),
    ).rejects.toMatchObject({ code: "CONTENT_INTEGRITY_ERROR" });
  });
});

describe("Resource 显式导入规划", () => {
  it("固定用户选择的旧版本快照，不随 latest 漂移且不伪称已写入", async () => {
    const { service, data, importTargets } = setup();
    const result = await service.planImport({
      scope: scopeA,
      resourceId: resourceAId,
      versionId: versionOneId,
      targetWorkspaceId,
      targetPath: "docs/reference.md",
    });

    expect(result).toMatchObject({
      status: "planned",
      plan: {
        snapshot: { versionId: versionOneId, versionNumber: 1, digest: digestOne },
        target: { conflictPolicy: "reject", precondition: "target_absent" },
        materialization: "not_started",
        workspaceWriterLease: "not_acquired",
      },
    });
    expect(data.resource.latestVersionId).toBe(versionTwoId);
    expect(importTargets.inspections[0]?.safeRelativePath).toBe("docs/reference.md");
    expect(result).not.toHaveProperty("plan.snapshot.objectKey");
  });

  it.each(["../secret", "/absolute", "a//b", "a/./b", "a/../../b", "a\\b", "ａ／．．／b"])(
    "拒绝逃逸或非规范路径 %s",
    async (targetPath) => {
      const { service, importTargets } = setup();
      await expect(
        service.planImport({
          scope: scopeA,
          resourceId: resourceAId,
          versionId: versionTwoId,
          targetWorkspaceId,
          targetPath,
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(importTargets.inspections).toHaveLength(0);
    },
  );

  it("目标已存在时默认拒绝覆盖", async () => {
    const { service, importTargets } = setup();
    importTargets.outcome = "occupied";
    await expect(
      service.planImport({
        scope: scopeA,
        resourceId: resourceAId,
        versionId: versionTwoId,
        targetWorkspaceId,
        targetPath: "result.md",
      }),
    ).resolves.toEqual({ status: "target_conflict" });
  });
});

describe("promote_resource 授权边界", () => {
  const agentScope: AgentResourceAccessScope = {
    ...scopeA,
    actor: {
      kind: "agent",
      agentThreadId: agentThreadId("agent-thread-test"),
      threadId: threadId("thread-source-test"),
      runId: runId("run-source-test"),
    },
  };

  it("仅生成显式 Agent 提升授权请求，提交前仍不可被目录搜索", async () => {
    const { service } = setup();
    const result = await service.requestPromotion({
      scope: agentScope,
      command: {
        workspaceId: targetWorkspaceId,
        revisionId: sourceRevisionId,
        relativePath: "output/report.md",
        resourceName: "正式报告",
      },
    });
    expect(result).toMatchObject({
      status: "authorized",
      request: {
        kind: "promote_resource",
        origin: "promoted_workspace",
        catalogVisibility: "pending_explicit_commit",
      },
    });
  });

  it("拒绝用户主体伪造 Agent 调用及跨租户授权响应", async () => {
    const first = setup();
    const forgedScope = {
      ...scopeA,
      actor: { kind: "user" },
    } as unknown as AgentResourceAccessScope;
    await expect(
      first.service.requestPromotion({
        scope: forgedScope,
        command: {
          workspaceId: targetWorkspaceId,
          revisionId: sourceRevisionId,
          relativePath: "output.md",
          resourceName: "输出",
        },
      }),
    ).resolves.toEqual({ status: "not_authorized" });
    expect(first.promotionAuthorizer.calls).toHaveLength(0);

    const second = setup();
    second.promotionAuthorizer.mismatchTenant = true;
    await expect(
      second.service.requestPromotion({
        scope: agentScope,
        command: {
          workspaceId: targetWorkspaceId,
          revisionId: sourceRevisionId,
          relativePath: "output.md",
          resourceName: "输出",
        },
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });

    const third = setup();
    third.promotionAuthorizer.expired = true;
    await expect(
      third.service.requestPromotion({
        scope: agentScope,
        command: {
          workspaceId: targetWorkspaceId,
          revisionId: sourceRevisionId,
          relativePath: "output.md",
          resourceName: "输出",
        },
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  });
});

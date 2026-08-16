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
} from "@aisay/domain";
import { describe, expect, it } from "vitest";
import { createPromotionCapabilityRegistry } from "./capability.js";
import type {
  AuthorizedAgentResourceContext,
  ResourceCatalog,
  ResourceCatalogItem,
  ResourceContentReader,
  TrustedResourceContext,
  WorkspaceImportTargetInspector,
  WorkspacePromotionAuthorizer,
} from "./contracts.js";
import { createResourceCursorCodec } from "./cursor.js";
import { ResourceServiceError } from "./errors.js";
import { ResourceLibraryService } from "./service.js";

const scopeA: TrustedResourceContext = {
  tenantId: tenantId("tenant-a-test"),
  userId: userId("user-a-test"),
};
const scopeB: TrustedResourceContext = {
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
const agentContext: AuthorizedAgentResourceContext = {
  ...scopeA,
  actor: {
    kind: "agent",
    agentThreadId: agentThreadId("agent-thread-test"),
    threadId: threadId("thread-source-test"),
    runId: runId("run-source-test"),
  },
};

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
  searchError?: Error;
  resolveError?: Error;
  ignoreAfter = false;
  constructor(
    private readonly resource: Resource,
    private readonly versions: readonly ResourceVersion[],
    readonly searchItems: readonly ResourceCatalogItem[],
  ) {}

  async search(input: Parameters<ResourceCatalog["search"]>[0]) {
    if (this.searchError !== undefined) throw this.searchError;
    this.searches.push(input);
    if (input.context.tenantId !== this.resource.tenantId) return { items: [] };
    const after = this.ignoreAfter ? undefined : input.after;
    const eligible =
      after === undefined
        ? this.searchItems
        : this.searchItems.filter(
            (item) =>
              item.updatedAt < after.updatedAt ||
              (item.updatedAt === after.updatedAt && item.resourceId < after.resourceId),
          );
    const items = eligible.slice(0, input.limit);
    const last = items.at(-1);
    return {
      items,
      ...(last === undefined
        ? {}
        : { nextPosition: { updatedAt: last.updatedAt, resourceId: last.resourceId } }),
    };
  }

  async resolveVersion(input: Parameters<ResourceCatalog["resolveVersion"]>[0]) {
    if (this.resolveError !== undefined) throw this.resolveError;
    if (
      input.context.tenantId !== this.resource.tenantId ||
      input.resourceId !== this.resource.id
    ) {
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
  shortRead = false;
  error?: Error;

  async readRange(input: Parameters<ResourceContentReader["readRange"]>[0]) {
    if (this.error !== undefined) throw this.error;
    this.reads.push(input);
    const bytes = this.body.slice(input.range.offset, input.range.offset + input.range.length);
    if (this.extraByte) return new Uint8Array([...bytes, 255]);
    return this.shortRead ? bytes.slice(0, -1) : bytes;
  }
}

class FakeImportTargets implements WorkspaceImportTargetInspector {
  outcome: "available" | "occupied" | "not_found" = "available";
  readonly inspections: Array<Parameters<WorkspaceImportTargetInspector["inspect"]>[0]> = [];
  error?: Error;
  async inspect(input: Parameters<WorkspaceImportTargetInspector["inspect"]>[0]) {
    if (this.error !== undefined) throw this.error;
    this.inspections.push(input);
    return { status: this.outcome };
  }
}

class FakePromotionAuthorizer implements WorkspacePromotionAuthorizer {
  mismatchTenant = false;
  expired = false;
  error?: Error;
  readonly calls: Array<Parameters<WorkspacePromotionAuthorizer["authorizeSnapshot"]>[0]> = [];
  async authorizeSnapshot(input: Parameters<WorkspacePromotionAuthorizer["authorizeSnapshot"]>[0]) {
    if (this.error !== undefined) throw this.error;
    this.calls.push(input);
    return {
      status: "authorized" as const,
      authorization: {
        authorizationId: "promotion-auth-0001",
        tenantId: this.mismatchTenant ? scopeB.tenantId : input.context.tenantId,
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

function setup(
  searchItems?: readonly ResourceCatalogItem[],
  versions?: readonly ResourceVersion[],
) {
  const data = fixture();
  const defaultItem: ResourceCatalogItem = {
    tenantId: scopeA.tenantId,
    visibility: "searchable",
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
    versions ?? [data.versionOne, data.versionTwo],
    searchItems ?? [defaultItem],
  );
  const reader = new FakeReader();
  const importTargets = new FakeImportTargets();
  const promotionAuthorizer = new FakePromotionAuthorizer();
  const promotionCapabilities = createPromotionCapabilityRegistry();
  const capability = promotionCapabilities.issuer.issue(agentContext);
  const cursorCodec = createResourceCursorCodec({
    activeKid: "current",
    keys: [{ kid: "current", secret: new Uint8Array(32).fill(7) }],
    ttlSeconds: 300,
    now: () => new Date("2026-07-26T04:00:00.000Z"),
  });
  const service = new ResourceLibraryService(
    {
      catalog,
      contentReader: reader,
      cursorCodec,
      importTargets,
      promotionAuthorizer,
      promotionCapabilities: promotionCapabilities.verifier,
    },
    {
      maxPageSize: 50,
      maxPreviewBytes: 8,
      defaultPreviewBytes: 4,
      now: () => new Date("2026-07-26T04:00:00.000Z"),
    },
  );
  return {
    data,
    catalog,
    reader,
    importTargets,
    promotionAuthorizer,
    cursorCodec,
    service,
    capability,
  };
}

describe("Resource Library 发现", () => {
  it("规范化查询、限制页大小并只返回受限元数据", async () => {
    const { service, catalog } = setup();
    const result = await service.search({ context: scopeA, query: "  项目\t说明  ", pageSize: 1 });

    expect(catalog.searches[0]?.normalizedQuery).toBe("项目 说明");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).not.toHaveProperty("objectKey");
    expect(result.items[0]).not.toHaveProperty("content");
    expect(result.items[0]).not.toHaveProperty("tenantId");
    expect(result.items[0]).not.toHaveProperty("visibility");
    expect(result.nextCursor).toEqual(expect.any(String));
    await expect(service.search({ context: scopeA, pageSize: 51 })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("第二页每一项都严格位于已签名位置之后", async () => {
    const seed = setup();
    const firstRow = seed.catalog.searchItems[0];
    expect(firstRow).toBeDefined();
    const rows: ResourceCatalogItem[] = [
      firstRow as ResourceCatalogItem,
      {
        ...(firstRow as ResourceCatalogItem),
        resourceId: resourceId("resource-b-test"),
        versionId: resourceVersionId("version-b-test"),
        updatedAt: isoTimestamp("2026-07-26T02:00:00.000Z"),
      },
      {
        ...(firstRow as ResourceCatalogItem),
        resourceId: resourceId("resource-c-test"),
        versionId: resourceVersionId("version-c-test"),
        updatedAt: isoTimestamp("2026-07-26T01:00:00.000Z"),
      },
    ];
    const { service } = setup(rows);
    const first = await service.search({ context: scopeA, pageSize: 2 });
    const firstCursor = first.nextCursor;
    if (firstCursor === undefined) throw new Error("第一页缺少测试游标");
    const second = await service.search({
      context: scopeA,
      pageSize: 2,
      cursor: firstCursor,
    });
    expect(first.items.map((item) => item.resourceId)).toEqual([
      resourceAId,
      resourceId("resource-b-test"),
    ]);
    expect(second.items.map((item) => item.resourceId)).toEqual([resourceId("resource-c-test")]);
  });

  it("拒绝游标后重复页、重复 Resource ID 或重复 Version ID", async () => {
    const firstSetup = setup();
    firstSetup.catalog.ignoreAfter = true;
    const page = await firstSetup.service.search({ context: scopeA, pageSize: 1 });
    const pageCursor = page.nextCursor;
    if (pageCursor === undefined) throw new Error("第一页缺少测试游标");
    await expect(
      firstSetup.service.search({ context: scopeA, pageSize: 1, cursor: pageCursor }),
    ).rejects.toMatchObject({ code: "CONTENT_INTEGRITY_ERROR" });

    const base = setup().catalog.searchItems[0] as ResourceCatalogItem;
    const duplicateResource = {
      ...base,
      versionId: resourceVersionId("version-duplicate-test"),
      updatedAt: isoTimestamp("2026-07-26T02:00:00.000Z"),
    };
    await expect(
      setup([base, duplicateResource]).service.search({ context: scopeA }),
    ).rejects.toMatchObject({
      code: "CONTENT_INTEGRITY_ERROR",
    });
    const duplicateVersion = {
      ...base,
      resourceId: resourceId("resource-duplicate-test"),
      updatedAt: isoTimestamp("2026-07-26T02:00:00.000Z"),
    };
    await expect(
      setup([base, duplicateVersion]).service.search({ context: scopeA }),
    ).rejects.toMatchObject({
      code: "CONTENT_INTEGRITY_ERROR",
    });
  });

  it("投影前复核内部 Tenant 与 visibility 并 fail closed", async () => {
    const base = setup().catalog.searchItems[0] as ResourceCatalogItem;
    await expect(
      setup([{ ...base, tenantId: scopeB.tenantId }]).service.search({ context: scopeA }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    await expect(
      setup([{ ...base, visibility: "pending_explicit_commit" }]).service.search({
        context: scopeA,
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  });

  it("签名游标绑定 Tenant、User 和查询并拒绝篡改", async () => {
    const { service } = setup();
    const first = await service.search({ context: scopeA, query: "项目" });
    const cursor = first.nextCursor ?? "";
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;

    await expect(
      service.search({ context: scopeA, query: "项目", cursor: tampered }),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(service.search({ context: scopeB, query: "项目", cursor })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(
      service.search({
        context: { ...scopeA, userId: userId("another-user-test") },
        query: "项目",
        cursor,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(service.search({ context: scopeA, query: "其他", cursor })).rejects.toMatchObject({
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
    const cursor = oldCodec.encode({ context: scopeA, normalizedQuery: "项目", position });
    const rotated = createResourceCursorCodec({
      activeKid: "new",
      keys: [
        { kid: "old", secret: oldSecret },
        { kid: "new", secret: new Uint8Array(32).fill(4) },
      ],
      ttlSeconds: 30,
      now: () => current,
    });
    expect(rotated.decode({ context: scopeA, normalizedQuery: "项目", cursor })).toEqual(position);

    current = new Date("2026-07-26T04:00:31.000Z");
    expect(() => rotated.decode({ context: scopeA, normalizedQuery: "项目", cursor })).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("拒绝未来签发、非规范 base64url、未知 kid 和签名中间位篡改", () => {
    const secret = new Uint8Array(32).fill(8);
    const position = {
      updatedAt: isoTimestamp("2026-07-26T03:00:00.000Z"),
      resourceId: resourceAId,
    };
    const signer = createResourceCursorCodec({
      activeKid: "old",
      keys: [{ kid: "old", secret }],
      ttlSeconds: 300,
      now: () => new Date("2026-07-26T04:01:00.000Z"),
    });
    const cursor = signer.encode({ context: scopeA, normalizedQuery: "项目", position });
    const verifier = createResourceCursorCodec({
      activeKid: "old",
      keys: [{ kid: "old", secret }],
      ttlSeconds: 300,
      now: () => new Date("2026-07-26T04:00:00.000Z"),
    });
    expect(() =>
      verifier.decode({ context: scopeA, normalizedQuery: "项目", cursor }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));

    const [payload = "", signature = ""] = cursor.split(".");
    const nonCanonical = `${payload}=.${signature}`;
    expect(() =>
      verifier.decode({ context: scopeA, normalizedQuery: "项目", cursor: nonCanonical }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));

    const middle = Math.floor(signature.length / 2);
    const changed = signature[middle] === "a" ? "b" : "a";
    const middleTampered = `${payload}.${signature.slice(0, middle)}${changed}${signature.slice(middle + 1)}`;
    expect(() =>
      verifier.decode({ context: scopeA, normalizedQuery: "项目", cursor: middleTampered }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));

    const retiredVerifier = createResourceCursorCodec({
      activeKid: "new",
      keys: [{ kid: "new", secret: new Uint8Array(32).fill(9) }],
      ttlSeconds: 300,
      now: () => new Date("2026-07-26T04:01:01.000Z"),
    });
    expect(() =>
      retiredVerifier.decode({ context: scopeA, normalizedQuery: "项目", cursor }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it("拒绝目录适配器返回不确定排序，过程文件不会被核心自动发现", async () => {
    const data = fixture();
    const older: ResourceCatalogItem = {
      tenantId: scopeA.tenantId,
      visibility: "searchable",
      resourceId: resourceId("resource-z-test"),
      versionId: versionTwoId,
      versionNumber: 2,
      name: "较旧",
      origin: "upload",
      mediaType: "text/plain",
      sizeBytes: 1,
      updatedAt: isoTimestamp("2026-07-26T02:00:00.000Z"),
    };
    const newer: ResourceCatalogItem = {
      ...older,
      resourceId: data.resource.id,
      name: "较新",
      updatedAt: data.resource.updatedAt,
    };
    const { service } = setup([older, newer]);
    await expect(service.search({ context: scopeA })).rejects.toMatchObject({
      code: "CONTENT_INTEGRITY_ERROR",
    });

    // Workspace 过程文件没有 Resource 元数据，目录端口也没有 Workspace 自动发现入口。
    const empty = setup([]);
    await expect(empty.service.search({ context: scopeA, query: "scratch.tmp" })).resolves.toEqual({
      items: [],
    });
  });
});

describe("Resource 局部预览", () => {
  it("只用授权后的不可变版本读取范围，忽略调用方伪造的 objectKey", async () => {
    const { service, reader, data } = setup();
    const request = {
      context: scopeA,
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
      service.preview({ context: scopeB, resourceId: resourceAId, versionId: versionTwoId }),
    ).resolves.toEqual({ status: "not_found" });
    await expect(
      service.preview({
        context: scopeA,
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
    const promotionCapabilities = createPromotionCapabilityRegistry();
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
      promotionCapabilities: promotionCapabilities.verifier,
    });

    await expect(
      service.preview({ context: scopeA, resourceId: resourceAId, versionId: versionTwoId }),
    ).resolves.toEqual({ status: "unsupported_media_type", mediaType: "application/zip" });
    expect(reader.reads).toHaveLength(0);
  });

  it("拒绝超预算请求和越过授权范围的读取响应", async () => {
    const { service, reader } = setup();
    await expect(
      service.preview({
        context: scopeA,
        resourceId: resourceAId,
        versionId: versionTwoId,
        length: 9,
      }),
    ).rejects.toMatchObject({ code: "PREVIEW_BUDGET_EXCEEDED" });

    reader.extraByte = true;
    await expect(
      service.preview({
        context: scopeA,
        resourceId: resourceAId,
        versionId: versionTwoId,
        length: 4,
      }),
    ).rejects.toMatchObject({ code: "CONTENT_INTEGRITY_ERROR" });

    const short = setup();
    short.reader.shortRead = true;
    await expect(
      short.service.preview({
        context: scopeA,
        resourceId: resourceAId,
        versionId: versionTwoId,
        length: 4,
      }),
    ).rejects.toMatchObject({ code: "CONTENT_INTEGRITY_ERROR" });
  });

  it("范围越过结尾返回稳定结果，空请求范围明确拒绝", async () => {
    const { service, reader } = setup();
    await expect(
      service.preview({
        context: scopeA,
        resourceId: resourceAId,
        versionId: versionTwoId,
        offset: 18,
      }),
    ).resolves.toEqual({ status: "range_not_satisfiable", totalSizeBytes: 18 });
    await expect(
      service.preview({
        context: scopeA,
        resourceId: resourceAId,
        versionId: versionTwoId,
        length: 0,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(reader.reads).toHaveLength(0);

    const data = fixture();
    const emptyVersion = { ...data.versionTwo, sizeBytes: 0 } as ResourceVersion;
    const empty = setup(undefined, [emptyVersion]);
    await expect(
      empty.service.preview({
        context: scopeA,
        resourceId: resourceAId,
        versionId: versionTwoId,
      }),
    ).resolves.toMatchObject({
      status: "available",
      range: { offset: 0, length: 0 },
      totalSizeBytes: 0,
      truncated: false,
    });
    expect(empty.reader.reads).toHaveLength(0);
  });
});

describe("Resource 显式导入规划", () => {
  it("固定用户选择的旧版本快照，不随 latest 漂移且不伪称已写入", async () => {
    const { service, data, importTargets } = setup();
    const result = await service.planImport({
      context: scopeA,
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

  it.each([
    "../secret",
    "/absolute",
    "a//b",
    "a/./b",
    "a/../../b",
    "a\\b",
    "ａ／．．／b",
    "C:/secret",
    "file.txt:ads",
    "CON",
    "con.txt",
    "dir/LPT1.log",
    "name.",
    "name ",
    "a\u0001b",
    "a\u202Eb",
    "a\uD800b",
  ])("拒绝逃逸或非规范路径 %s", async (targetPath) => {
    const { service, importTargets } = setup();
    await expect(
      service.planImport({
        context: scopeA,
        resourceId: resourceAId,
        versionId: versionTwoId,
        targetWorkspaceId,
        targetPath,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(importTargets.inspections).toHaveLength(0);
  });

  it("目标已存在时默认拒绝覆盖", async () => {
    const { service, importTargets } = setup();
    importTargets.outcome = "occupied";
    await expect(
      service.planImport({
        context: scopeA,
        resourceId: resourceAId,
        versionId: versionTwoId,
        targetWorkspaceId,
        targetPath: "result.md",
      }),
    ).resolves.toEqual({ status: "target_conflict" });
  });
});

describe("promote_resource 授权边界", () => {
  it("仅生成显式 Agent 提升授权请求，提交前仍不可被目录搜索", async () => {
    const { service, capability } = setup();
    const result = await service.requestPromotion({
      context: scopeA,
      capability,
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
    const forgedCapability = {
      kind: "promote_resource_capability",
      ...scopeA,
      actor: agentContext.actor,
    };
    await expect(
      first.service.requestPromotion({
        context: scopeA,
        capability: forgedCapability,
        command: {
          workspaceId: targetWorkspaceId,
          revisionId: sourceRevisionId,
          relativePath: "output.md",
          resourceName: "输出",
        },
      }),
    ).resolves.toEqual({ status: "not_authorized" });
    expect(first.promotionAuthorizer.calls).toHaveLength(0);

    const serializedClone: unknown = JSON.parse(JSON.stringify(first.capability));
    await expect(
      first.service.requestPromotion({
        context: scopeA,
        capability: serializedClone,
        command: {
          workspaceId: targetWorkspaceId,
          revisionId: sourceRevisionId,
          relativePath: "output.md",
          resourceName: "输出",
        },
      }),
    ).resolves.toEqual({ status: "not_authorized" });

    const second = setup();
    second.promotionAuthorizer.mismatchTenant = true;
    await expect(
      second.service.requestPromotion({
        context: scopeA,
        capability: second.capability,
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
        context: scopeA,
        capability: third.capability,
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

describe("Resource 端口失败与运行时输入", () => {
  it("所有外部端口异常统一脱敏且不保留 cause", async () => {
    const secret = "SQL SELECT object_key=private/tenant-a/top-secret";
    const runs: Array<() => Promise<unknown>> = [];

    const searchFailure = setup();
    searchFailure.catalog.searchError = new Error(secret);
    runs.push(() => searchFailure.service.search({ context: scopeA }));

    const resolveFailure = setup();
    resolveFailure.catalog.resolveError = new Error(secret);
    runs.push(() =>
      resolveFailure.service.preview({
        context: scopeA,
        resourceId: resourceAId,
        versionId: versionTwoId,
      }),
    );

    const readerFailure = setup();
    readerFailure.reader.error = new Error(secret);
    runs.push(() =>
      readerFailure.service.preview({
        context: scopeA,
        resourceId: resourceAId,
        versionId: versionTwoId,
      }),
    );

    const targetFailure = setup();
    targetFailure.importTargets.error = new Error(secret);
    runs.push(() =>
      targetFailure.service.planImport({
        context: scopeA,
        resourceId: resourceAId,
        versionId: versionTwoId,
        targetWorkspaceId,
        targetPath: "safe.md",
      }),
    );

    const authorizerFailure = setup();
    authorizerFailure.promotionAuthorizer.error = new Error(secret);
    runs.push(() =>
      authorizerFailure.service.requestPromotion({
        context: scopeA,
        capability: authorizerFailure.capability,
        command: {
          workspaceId: targetWorkspaceId,
          revisionId: sourceRevisionId,
          relativePath: "safe.md",
          resourceName: "安全文件",
        },
      }),
    );

    for (const run of runs) {
      try {
        await run();
        expect.unreachable("外部端口异常必须失败");
      } catch (error) {
        expect(error).toMatchObject({
          code: "DEPENDENCY_FAILURE",
          message: "Resource 依赖操作失败",
        });
        expect(error).not.toHaveProperty("cause");
        expect(String(error)).not.toContain("object_key");
        expect(String(error)).not.toContain("top-secret");
      }
    }
  });

  it("外部结果 Getter 或 Proxy 抛出领域错误时仍统一脱敏", async () => {
    const getterSecret = "SQL SELECT objectKey=private/tenant-a/getter-secret";
    const getterFixture = fixture();
    const poisonedVersion = Object.create(getterFixture.versionTwo) as ResourceVersion;
    Object.defineProperty(poisonedVersion, "objectKey", {
      enumerable: true,
      get() {
        throw new ResourceServiceError("CONTENT_INTEGRITY_ERROR", getterSecret);
      },
    });
    const getterFailure = setup(undefined, [getterFixture.versionOne, poisonedVersion]);

    const proxySecret = "SQL SELECT objectKey=private/tenant-a/proxy-secret";
    const proxyFixture = setup();
    const baseItem = proxyFixture.catalog.searchItems[0] as ResourceCatalogItem;
    const poisonedItem = new Proxy(baseItem, {
      get(target, property, receiver) {
        if (property === "name") {
          throw new ResourceServiceError("NOT_AUTHORIZED", proxySecret);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const proxyFailure = setup([poisonedItem]);

    const runs = [
      () =>
        getterFailure.service.preview({
          context: scopeA,
          resourceId: resourceAId,
          versionId: versionTwoId,
        }),
      () => proxyFailure.service.search({ context: scopeA }),
    ];
    for (const run of runs) {
      try {
        await run();
        expect.unreachable("外部结果延迟异常必须失败");
      } catch (error) {
        expect(error).toMatchObject({
          code: "DEPENDENCY_FAILURE",
          message: "Resource 依赖操作失败",
        });
        expect(error).not.toHaveProperty("cause");
        expect(String(error)).not.toContain("SQL SELECT");
        expect(String(error)).not.toContain("objectKey");
        expect(String(error)).not.toContain("getter-secret");
        expect(String(error)).not.toContain("proxy-secret");
      }
    }
  });

  it("正常外部结果可用且服务自身校验错误保留语义", async () => {
    const normal = setup();
    await expect(normal.service.search({ context: scopeA })).resolves.toMatchObject({
      items: [{ resourceId: resourceAId, versionId: versionTwoId }],
    });

    const invalid = setup();
    const baseItem = invalid.catalog.searchItems[0] as ResourceCatalogItem;
    await expect(
      setup([{ ...baseItem, tenantId: scopeB.tenantId }]).service.search({ context: scopeA }),
    ).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
      message: "Resource 目录返回越权或不可见记录",
    });
  });

  it("运行时重验认证上下文和所有命令 ID", async () => {
    const first = setup();
    const invalidContext = {
      tenantId: "../tenant",
      userId: scopeA.userId,
    } as unknown as TrustedResourceContext;
    await expect(first.service.search({ context: invalidContext })).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
    });
    expect(first.catalog.searches).toHaveLength(0);

    const invalidResourceId = "../resource" as unknown as typeof resourceAId;
    await expect(
      first.service.preview({
        context: scopeA,
        resourceId: invalidResourceId,
        versionId: versionTwoId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(first.reader.reads).toHaveLength(0);
  });
});

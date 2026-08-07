import { createHash } from "node:crypto";
import { resourceId, resourceVersionId, tenantId } from "@cube-runtime/domain";
import type { BlobStore } from "@cube-runtime/persistence";
import {
  createResourceFilesystemCapabilityCodec,
  type HistoryFilesystemCatalog,
  type HistoryFilesystemFile,
  type ResourceFilesystemCatalog,
  type ResourceFilesystemFile,
} from "@cube-runtime/resource";
import type {
  SkillContentStore,
  SkillFilesystemCatalog,
  SkillFilesystemEntry,
  SkillFilesystemFile,
} from "@cube-runtime/skill";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerResourceFilesystemHttp } from "./resource-filesystem-http.js";

const tenant = tenantId("tenant-resource-http");
const skillBody = new TextEncoder().encode("# Review\n\n按清单检查。\n");
const skillDigest = createHash("sha256").update(skillBody).digest("hex");
const file: ResourceFilesystemFile = {
  resourceId: resourceId("resource-http-test"),
  versionId: resourceVersionId("version-http-test"),
  name: "说明 文档.txt",
  path: "/resources/resource-http-test/version-http-test/说明 文档.txt",
  mediaType: "text/plain",
  sizeBytes: 6,
  object: {
    tenantId: tenant,
    purpose: "resource",
    sha256: "a".repeat(64),
    size: 6,
    mediaType: "text/plain",
    incarnationId: "11111111-1111-4111-8111-111111111111",
    physicalObjectKey: "resource/http/object",
  },
};
const historyDirectoryName = "2026-08-07_14-32-08_采购合同风险审查";
const historyEntryName = "2026-08-07_14-33-10_说明 文档.txt";
const historyFile: HistoryFilesystemFile = {
  ...file,
  threadId: "thread-history-test",
  directoryName: historyDirectoryName,
  entryName: historyEntryName,
};

describe("Resource WebDAV HTTP 边界", () => {
  it("只用短期 capability 列目录，不披露对象键", async () => {
    const fixture = await appFixture();
    const root = await fixture.app.inject({
      method: "PROPFIND" as "GET",
      url: "/v1/resource-filesystem/",
      headers: { authorization: `Bearer ${fixture.token}`, depth: "0" },
    });
    expect(root.statusCode).toBe(207);
    expect(root.body).toContain("<d:href>/v1/resource-filesystem/</d:href>");
    expect(root.body).not.toContain("/v1/resource-filesystem//");
    const response = await fixture.app.inject({
      method: "PROPFIND" as "GET",
      url: "/v1/resource-filesystem/resource-http-test/version-http-test",
      headers: { authorization: `Bearer ${fixture.token}`, depth: "1" },
    });
    expect(response.statusCode).toBe(207);
    expect(response.body).toContain("%E8%AF%B4%E6%98%8E%20%E6%96%87%E6%A1%A3.txt");
    expect(response.body).not.toContain(file.object.physicalObjectKey);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    await fixture.app.close();
  });

  it("按需读取文件并支持单段 Range，未授权请求失败关闭", async () => {
    const fixture = await appFixture();
    const encodedPath =
      "/v1/resource-filesystem/resource-http-test/version-http-test/%E8%AF%B4%E6%98%8E%20%E6%96%87%E6%A1%A3.txt";
    const unauthorized = await fixture.app.inject({ method: "GET", url: encodedPath });
    expect(unauthorized.statusCode).toBe(401);

    const response = await fixture.app.inject({
      method: "GET",
      url: encodedPath,
      headers: { authorization: `Bearer ${fixture.token}`, range: "bytes=1-3" },
    });
    expect(response.statusCode).toBe(206);
    expect(response.body).toBe("bcd");
    expect(response.headers["content-range"]).toBe("bytes 1-3/6");
    expect(fixture.getBytes).toHaveBeenCalledOnce();
    await fixture.app.close();
  });

  it("Cubelet host-volume capability 使用相同 Tenant 目录但不要求 Sandbox TTL", async () => {
    const fixture = await appFixture();
    const response = await fixture.app.inject({
      method: "PROPFIND" as "GET",
      url: "/v1/resource-filesystem/",
      headers: { authorization: `Bearer ${fixture.hostToken}`, depth: "1" },
    });

    expect(response.statusCode).toBe(207);
    expect(response.body).toContain("resource-http-test");
    expect(response.body).toContain("/v1/resource-filesystem/skills/");
    await fixture.app.close();
  });

  it("向所有 Tenant 投影公开 Skill 市场，并按精确版本延迟读取包文件", async () => {
    const fixture = await appFixture();
    const directory = await fixture.app.inject({
      method: "PROPFIND" as "GET",
      url: "/v1/resource-filesystem/skills/code-review/1.2.3",
      headers: { authorization: `Bearer ${fixture.hostToken}`, depth: "1" },
    });
    expect(directory.statusCode).toBe(207);
    expect(directory.body).toContain("SKILL.md");
    expect(directory.body).toContain("scripts/");
    expect(directory.body).not.toContain("skill-secret-blob-ref");

    const response = await fixture.app.inject({
      method: "GET",
      url: "/v1/resource-filesystem/skills/code-review/1.2.3/SKILL.md",
      headers: { authorization: `Bearer ${fixture.hostToken}`, range: "bytes=2-7" },
    });
    expect(response.statusCode).toBe(206);
    expect(response.body).toBe("Review");
    expect(response.headers.etag).toBe(`"${skillDigest}"`);
    expect(fixture.readSkill).toHaveBeenCalledWith({
      blobRef: "skill-secret-blob-ref",
      expectedDigest: skillDigest,
      expectedSizeBytes: skillBody.byteLength,
    });

    const metadata = await fixture.app.inject({
      method: "GET",
      url: "/v1/resource-filesystem/skills/code-review/_metadata.json",
      headers: { authorization: `Bearer ${fixture.hostToken}` },
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toMatchObject({
      canonicalKey: "code-review",
      recommendedVersion: "1.2.3",
    });
    await fixture.app.close();
  });

  it("兼容 rclone 未声明 Content-Type 的 PROPFIND XML body", async () => {
    const fixture = await appFixture();
    const response = await fixture.app.inject({
      method: "PROPFIND" as "GET",
      url: "/v1/resource-filesystem/",
      headers: {
        authorization: `Bearer ${fixture.hostToken}`,
        depth: "1",
      },
      payload: '<?xml version="1.0"?><propfind xmlns="DAV:"/>',
    });

    expect(response.statusCode).toBe(207);
    expect(response.body).toContain("resource-http-test");
    await fixture.app.close();
  });
  const emptyThreadId = "thread-empty-before-first-attachment";

  it("为 personal Tenant 投影最近历史目录、稳定 Thread 入口和按需文件读取", async () => {
    const history: HistoryFilesystemCatalog = {
      listRecentDirectories: vi.fn(async () => [
        {
          threadId: historyFile.threadId,
          name: historyDirectoryName,
          createdAt: "2026-08-07T06:32:08.000Z",
          lastFileAt: "2026-08-07T06:33:10.000Z",
          fileCount: 1,
        },
      ]),
      listThreadIds: vi.fn(async () => [historyFile.threadId, emptyThreadId]),
      resolveDirectory: vi.fn(async ({ directoryName }) =>
        directoryName === historyDirectoryName
          ? {
              threadId: historyFile.threadId,
              name: historyDirectoryName,
              createdAt: "2026-08-07T06:32:08.000Z",
              lastFileAt: "2026-08-07T06:33:10.000Z",
              fileCount: 1,
            }
          : undefined,
      ),
      listThreadFiles: vi.fn(async ({ threadId }) =>
        threadId === historyFile.threadId
          ? [historyFile]
          : threadId === emptyThreadId
            ? []
            : undefined,
      ),
      resolveHistoryFile: vi.fn(async ({ directoryName, entryName }) =>
        directoryName === historyDirectoryName && entryName === historyEntryName
          ? historyFile
          : undefined,
      ),
      resolveThreadFile: vi.fn(async ({ threadId, entryName }) =>
        threadId === historyFile.threadId && entryName === historyEntryName
          ? historyFile
          : undefined,
      ),
    };
    const fixture = await appFixture(history);

    const root = await fixture.app.inject({
      method: "PROPFIND" as "GET",
      url: "/v1/resource-filesystem/",
      headers: { authorization: `Bearer ${fixture.hostToken}`, depth: "1" },
    });
    expect(root.statusCode).toBe(207);
    expect(root.body).toContain("/v1/resource-filesystem/history/");
    expect(root.body).toContain("/v1/resource-filesystem/.thread-files/");

    const directory = await fixture.app.inject({
      method: "PROPFIND" as "GET",
      url: "/v1/resource-filesystem/history",
      headers: { authorization: `Bearer ${fixture.hostToken}`, depth: "1" },
    });
    expect(directory.statusCode).toBe(207);
    const hiddenRoot = await fixture.app.inject({
      method: "PROPFIND" as "GET",
      url: "/v1/resource-filesystem/.thread-files",
      headers: { authorization: `Bearer ${fixture.hostToken}`, depth: "1" },
    });
    expect(hiddenRoot.statusCode).toBe(207);
    expect(hiddenRoot.body).toContain(
      `/v1/resource-filesystem/.thread-files/${historyFile.threadId}/`,
    );

    expect(directory.body).toContain(encodeURIComponent(historyDirectoryName));
    expect(hiddenRoot.body).toContain(`/v1/resource-filesystem/.thread-files/${emptyThreadId}/`);

    const emptyThreadFiles = await fixture.app.inject({
      method: "PROPFIND" as "GET",
      url: `/v1/resource-filesystem/.thread-files/${emptyThreadId}/files`,
      headers: { authorization: `Bearer ${fixture.hostToken}`, depth: "1" },
    });
    expect(emptyThreadFiles.statusCode).toBe(207);
    expect(emptyThreadFiles.body).toContain(
      `/v1/resource-filesystem/.thread-files/${emptyThreadId}/files/`,
    );

    const threadFiles = await fixture.app.inject({
      method: "PROPFIND" as "GET",
      url: `/v1/resource-filesystem/.thread-files/${historyFile.threadId}/files`,
      headers: { authorization: `Bearer ${fixture.hostToken}`, depth: "1" },
    });
    expect(threadFiles.statusCode).toBe(207);
    expect(threadFiles.body).toContain(encodeURIComponent(historyEntryName));

    const read = await fixture.app.inject({
      method: "GET",
      url: `/v1/resource-filesystem/history/${encodeURIComponent(historyDirectoryName)}/files/${encodeURIComponent(historyEntryName)}`,
      headers: { authorization: `Bearer ${fixture.hostToken}`, range: "bytes=1-3" },
    });
    expect(read.statusCode).toBe(206);
    expect(read.body).toBe("bcd");
    await fixture.app.close();
  });

  it("team Tenant 的 Catalog 明确关闭历史根和内部稳定视图", async () => {
    const teamHistory: HistoryFilesystemCatalog = {
      listRecentDirectories: vi.fn(async () => undefined),
      resolveDirectory: vi.fn(async () => undefined),
      listThreadIds: vi.fn(async () => undefined),
      listThreadFiles: vi.fn(async () => undefined),
      resolveHistoryFile: vi.fn(async () => undefined),
      resolveThreadFile: vi.fn(async () => undefined),
    };
    const fixture = await appFixture(teamHistory);
    const root = await fixture.app.inject({
      method: "PROPFIND" as "GET",
      url: "/v1/resource-filesystem/",
      headers: { authorization: `Bearer ${fixture.hostToken}`, depth: "1" },
    });
    expect(root.body).not.toContain("/v1/resource-filesystem/history/");
    const hiddenRoot = await fixture.app.inject({
      method: "PROPFIND" as "GET",
      url: "/v1/resource-filesystem/.thread-files",
      headers: { authorization: `Bearer ${fixture.hostToken}`, depth: "0" },
    });
    expect(hiddenRoot.statusCode).toBe(404);
    await fixture.app.close();
  });

  it("未启用个人历史 Catalog 时不暴露历史根或内部 Thread 视图", async () => {
    const fixture = await appFixture();
    const root = await fixture.app.inject({
      method: "PROPFIND" as "GET",
      url: "/v1/resource-filesystem/",
      headers: { authorization: `Bearer ${fixture.hostToken}`, depth: "1" },
    });
    expect(root.body).not.toContain("/v1/resource-filesystem/history/");
    const hidden = await fixture.app.inject({
      method: "PROPFIND" as "GET",
      url: "/v1/resource-filesystem/.thread-files/thread-history-test/files",
      headers: { authorization: `Bearer ${fixture.hostToken}`, depth: "1" },
    });
    expect(hidden.statusCode).toBe(404);
    await fixture.app.close();
  });
});

async function appFixture(history?: HistoryFilesystemCatalog) {
  const capabilities = createResourceFilesystemCapabilityCodec({
    secret: "resource-filesystem-http-test-key-32-bytes",
    now: () => 1_000,
  });
  const catalog: ResourceFilesystemCatalog = {
    list: vi.fn(async () => [file]),
    resolve: vi.fn(async (input) =>
      input.resourceId === file.resourceId && input.versionId === file.versionId ? file : undefined,
    ),
  };
  const getBytes = vi.fn(async () => new TextEncoder().encode("abcdef"));
  const blobs: BlobStore = {
    putStaging: async () => {
      throw new Error("unused");
    },
    promote: async () => {
      throw new Error("unused");
    },
    head: async () => undefined,
    read: () => {
      throw new Error("unused");
    },
    getBytes,
    deleteStaging: async () => undefined,
    presignDownload: async () => {
      throw new Error("unused");
    },
  };
  const metadataBody = new TextEncoder().encode(
    `${JSON.stringify({ canonicalKey: "code-review", recommendedVersion: "1.2.3" })}\n`,
  );
  const metadataDigest = createHash("sha256").update(metadataBody).digest("hex");
  const skillFile: SkillFilesystemFile = {
    mediaType: "text/markdown",
    sizeBytes: skillBody.byteLength,
    contentDigest: skillDigest,
    source: { kind: "blob", blobRef: "skill-secret-blob-ref" },
  };
  const metadataFile: SkillFilesystemFile = {
    mediaType: "application/json",
    sizeBytes: metadataBody.byteLength,
    contentDigest: metadataDigest,
    source: { kind: "inline", body: metadataBody },
  };
  const skillCatalog: SkillFilesystemCatalog = {
    listDirectory: vi.fn(async ({ segments }) => {
      const key = segments.join("/");
      const entries: Record<string, readonly SkillFilesystemEntry[]> = {
        "": [{ kind: "directory", name: "code-review" }],
        "code-review": [
          {
            kind: "file",
            name: "_metadata.json",
            mediaType: "application/json",
            sizeBytes: metadataBody.byteLength,
            contentDigest: metadataDigest,
          },
          { kind: "directory", name: "1.2.3" },
        ],
        "code-review/1.2.3": [
          {
            kind: "file",
            name: "SKILL.md",
            mediaType: skillFile.mediaType,
            sizeBytes: skillFile.sizeBytes,
            contentDigest: skillFile.contentDigest,
          },
          { kind: "directory", name: "scripts" },
        ],
      };
      return entries[key];
    }),
    resolveFile: vi.fn(async ({ segments }) => {
      const key = segments.join("/");
      if (key === "code-review/1.2.3/SKILL.md") return skillFile;
      if (key === "code-review/_metadata.json") return metadataFile;
      return undefined;
    }),
  };
  const readSkill = vi.fn(async () => skillBody);
  const skillContents: SkillContentStore = { read: readSkill };
  const app = Fastify();
  registerResourceFilesystemHttp(app, {
    catalog,
    blobs,
    capabilities,
    ...(history === undefined ? {} : { history }),
    skills: { catalog: skillCatalog, contents: skillContents },
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { readonly statusCode?: number }).statusCode;
    void reply.status(status === 401 ? 401 : 500).send();
  });
  await app.ready();
  return {
    app,
    getBytes,
    readSkill,
    token: capabilities.issue({
      tenantId: tenant,
      sandboxId: "sandbox-resource-http",
      ttlSeconds: 60,
    }),
    hostToken: capabilities.issueHostVolume({ tenantId: tenant }),
  };
}

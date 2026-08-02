import { resourceId, resourceVersionId, tenantId } from "@cube-runtime/domain";
import type { BlobStore } from "@cube-runtime/persistence";
import {
  createResourceFilesystemCapabilityCodec,
  type ResourceFilesystemCatalog,
  type ResourceFilesystemFile,
} from "@cube-runtime/resource";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerResourceFilesystemHttp } from "./resource-filesystem-http.js";

const tenant = tenantId("tenant-resource-http");
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
});

async function appFixture() {
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
  const app = Fastify();
  registerResourceFilesystemHttp(app, { catalog, blobs, capabilities });
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { readonly statusCode?: number }).statusCode;
    void reply.status(status === 401 ? 401 : 500).send();
  });
  await app.ready();
  return {
    app,
    getBytes,
    token: capabilities.issue({
      tenantId: tenant,
      sandboxId: "sandbox-resource-http",
      ttlSeconds: 60,
    }),
    hostToken: capabilities.issueHostVolume({ tenantId: tenant }),
  };
}

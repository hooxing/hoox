import { describe, expect, it } from "vitest";
import { BlobStoreError } from "./index.js";
import {
  S3BlobStore,
  type S3CopyObjectInput,
  type S3ObjectClient,
  type S3ObjectMetadata,
  type S3PresignInput,
  type S3PutObjectInput,
} from "./s3-blob-store.js";

describe("S3BlobStore", () => {
  it("只使用派生键，并隔离 Tenant 与用途", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, { bucket: "agent-runtime-dev", prefix: "test" });
    const staged = await store.putStaging({
      scope: { tenantId: "tenant_a" },
      purpose: "workspace",
      uploadId: "upload-1",
      body: bytes("hello"),
      mediaType: "text/plain",
    });

    expect(client.putKeys).toEqual(["test/tenants/tenant_a/staging/workspace/upload-1"]);
    await expect(store.head({ tenantId: "tenant_b" }, staged)).rejects.toMatchObject({
      code: "TENANT_SCOPE_MISMATCH",
    });
    await expect(
      store.putStaging({
        scope: { tenantId: "tenant_a/../tenant_b" },
        purpose: "workspace",
        uploadId: "upload-2",
        body: bytes("hello"),
        mediaType: "text/plain",
      }),
    ).rejects.toMatchObject({ code: "INVALID_BLOB_ARGUMENT" });
    await expect(
      store.putStaging({
        scope: { tenantId: "tenant_a" },
        purpose: "workspace",
        uploadId: "../escape",
        body: bytes("hello"),
        mediaType: "text/plain",
      }),
    ).rejects.toMatchObject({ code: "INVALID_BLOB_ARGUMENT" });
    await expect(
      store.putStaging({
        scope: { tenantId: "tenant_a" },
        purpose: "workspace/other" as never,
        uploadId: "upload-3",
        body: bytes("hello"),
        mediaType: "text/plain",
      }),
    ).rejects.toMatchObject({ code: "INVALID_BLOB_ARGUMENT" });
  });

  it("相同 uploadId 和内容幂等，内容变化时拒绝覆盖", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, { bucket: "agent-runtime-dev" });
    const input = {
      scope: { tenantId: "tenant_a" },
      purpose: "resource" as const,
      uploadId: "idempotent-1",
      body: bytes("same"),
      mediaType: "text/plain",
    };

    await store.putStaging(input);
    await store.putStaging(input);
    expect(client.putKeys).toHaveLength(1);

    await expect(store.putStaging({ ...input, body: bytes("different") })).rejects.toMatchObject({
      code: "BLOB_IDEMPOTENCY_CONFLICT",
    });
  });

  it("校验调用方声明的哈希和大小", async () => {
    const store = new S3BlobStore(new FakeS3ObjectClient(), { bucket: "agent-runtime-dev" });
    await expect(
      store.putStaging({
        scope: { tenantId: "tenant_a" },
        purpose: "artifact",
        uploadId: "hash-mismatch",
        body: bytes("actual"),
        mediaType: "text/plain",
        expectedSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "BLOB_INTEGRITY_MISMATCH" });
    await expect(
      store.putStaging({
        scope: { tenantId: "tenant_a" },
        purpose: "artifact",
        uploadId: "size-mismatch",
        body: bytes("actual"),
        mediaType: "text/plain",
        expectedSize: 999,
      }),
    ).rejects.toMatchObject({ code: "BLOB_INTEGRITY_MISMATCH" });
  });

  it("写响应未知但对象已落盘时通过 HEAD 收敛为成功", async () => {
    const client = new FakeS3ObjectClient();
    client.putUnknownAfterWrite = true;
    const store = new S3BlobStore(client, { bucket: "agent-runtime-dev" });

    const staged = await store.putStaging({
      scope: { tenantId: "tenant_a" },
      purpose: "trace",
      uploadId: "unknown-recovered",
      body: bytes("trace"),
      mediaType: "application/json",
    });
    expect((await store.head({ tenantId: "tenant_a" }, staged))?.blob).toEqual(staged);
  });

  it("写响应未知且对象不存在时保留未知结果", async () => {
    const client = new FakeS3ObjectClient();
    client.putUnknownWithoutWrite = true;
    const store = new S3BlobStore(client, { bucket: "agent-runtime-dev" });

    await expect(
      store.putStaging({
        scope: { tenantId: "tenant_a" },
        purpose: "trace",
        uploadId: "unknown-unresolved",
        body: bytes("trace"),
        mediaType: "application/json",
      }),
    ).rejects.toMatchObject({ code: "BLOB_RESULT_UNKNOWN", result: "unknown" });
  });

  it("提升为内容寻址稳定对象，并校验读取内容", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, { bucket: "agent-runtime-dev", prefix: "test" });
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "promote-1",
      body: bytes("deliverable"),
      mediaType: "text/plain",
    });
    const stable = await store.promote(scope, staged);

    expect(client.copyKeys).toEqual([
      {
        sourceKey: "test/tenants/tenant_a/staging/artifact/promote-1",
        destinationKey: `test/tenants/tenant_a/stable/artifact/sha256/${stable.sha256}`,
      },
    ]);
    expect(new TextDecoder().decode(await store.get(scope, stable))).toBe("deliverable");
    expect(await store.promote(scope, staged)).toEqual(stable);
    expect(client.copyKeys).toHaveLength(1);
  });

  it("限制预签名 TTL 和下载文件名", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, {
      bucket: "agent-runtime-dev",
      maxPresignTtlSeconds: 120,
    });
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "presign-1",
      body: bytes("download"),
      mediaType: "text/plain",
    });
    const stable = await store.promote(scope, staged);

    await expect(
      store.presignDownload({ scope, blob: stable, ttlSeconds: 121 }),
    ).rejects.toMatchObject({
      code: "INVALID_BLOB_ARGUMENT",
    });
    await expect(
      store.presignDownload({ scope, blob: stable, ttlSeconds: 60, downloadName: "bad\r\nname" }),
    ).rejects.toMatchObject({ code: "INVALID_BLOB_ARGUMENT" });
    await expect(
      store.presignDownload({ scope, blob: stable, ttlSeconds: 60, downloadName: "报告.txt" }),
    ).resolves.toContain("ttl=60");
  });

  it("删除响应未知时通过 HEAD 区分已删除与仍存在", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, { bucket: "agent-runtime-dev" });
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "preview",
      uploadId: "delete-1",
      body: bytes("preview"),
      mediaType: "text/plain",
    });

    client.deleteUnknownAfterDelete = true;
    await expect(store.delete(scope, staged)).resolves.toBeUndefined();

    const stagedAgain = await store.putStaging({
      scope,
      purpose: "preview",
      uploadId: "delete-2",
      body: bytes("preview"),
      mediaType: "text/plain",
    });
    client.deleteUnknownWithoutDelete = true;
    await expect(store.delete(scope, stagedAgain)).rejects.toMatchObject({
      code: "BLOB_RESULT_UNKNOWN",
      result: "unknown",
    });
  });
});

interface StoredObject {
  readonly body: Uint8Array;
  readonly metadata: S3ObjectMetadata;
}

class FakeS3ObjectClient implements S3ObjectClient {
  readonly objects = new Map<string, StoredObject>();
  readonly putKeys: string[] = [];
  readonly copyKeys: S3CopyObjectInput[] = [];
  putUnknownAfterWrite = false;
  putUnknownWithoutWrite = false;
  deleteUnknownAfterDelete = false;
  deleteUnknownWithoutDelete = false;

  async put(input: S3PutObjectInput): Promise<void> {
    this.putKeys.push(input.key);
    if (!this.putUnknownWithoutWrite) {
      this.objects.set(input.key, {
        body: input.body.slice(),
        metadata: {
          size: input.descriptor.size,
          mediaType: input.descriptor.mediaType,
          sha256: input.descriptor.sha256,
          etag: "fake-etag",
        },
      });
    }
    if (this.putUnknownAfterWrite || this.putUnknownWithoutWrite) {
      throw unknownResult();
    }
  }

  async head(key: string): Promise<S3ObjectMetadata | undefined> {
    return this.objects.get(key)?.metadata;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.objects.get(key)?.body.slice();
  }

  async copy(input: S3CopyObjectInput): Promise<void> {
    this.copyKeys.push(input);
    const source = this.objects.get(input.sourceKey);
    if (source === undefined) {
      throw new BlobStoreError("BLOB_NOT_FOUND", "fake source missing");
    }
    this.objects.set(input.destinationKey, {
      body: source.body.slice(),
      metadata: { ...source.metadata },
    });
  }

  async delete(key: string): Promise<void> {
    if (!this.deleteUnknownWithoutDelete) {
      this.objects.delete(key);
    }
    if (this.deleteUnknownAfterDelete || this.deleteUnknownWithoutDelete) {
      throw unknownResult();
    }
  }

  async presignGet(input: S3PresignInput): Promise<string> {
    return `https://example.invalid/private?ttl=${input.ttlSeconds}`;
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function unknownResult(): BlobStoreError {
  return new BlobStoreError("BLOB_RESULT_UNKNOWN", "fake unknown", { result: "unknown" });
}

import { describe, expect, it } from "vitest";
import {
  type BlobReferenceCommitPort,
  BlobStoreError,
  type StableBlobGcClaim,
  type StableBlobGcClaimPort,
  type StableBlobRef,
  type TenantBlobScope,
} from "./index.js";
import {
  S3BlobStore,
  S3StableBlobGarbageCollector,
  type S3CopyObjectInput,
  type S3GetObjectResult,
  type S3ObjectClient,
  type S3ObjectMetadata,
  type S3PresignInput,
  type S3PutObjectInput,
  encodeRfc5987Value,
} from "./s3-blob-store.js";

const config = { bucket: "agent-runtime-dev", maxBlobSizeBytes: 1_024 } as const;

describe("S3BlobStore", () => {
  it("只使用派生键，并隔离 Tenant 与用途", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, { ...config, prefix: "test" });
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
    const store = new S3BlobStore(client, config);
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

  it("条件写消除 HEAD 到 PUT 的并发覆盖", async () => {
    const sameClient = new FakeS3ObjectClient();
    const sameStore = new S3BlobStore(sameClient, config);
    const sameInput = {
      scope: { tenantId: "tenant_a" },
      purpose: "resource" as const,
      uploadId: "concurrent-same",
      body: bytes("same"),
      mediaType: "text/plain",
    };
    const sameResults = await Promise.all([
      sameStore.putStaging(sameInput),
      sameStore.putStaging(sameInput),
    ]);
    expect(sameResults[0]).toEqual(sameResults[1]);
    expect(sameClient.successfulPuts).toBe(1);

    const conflictClient = new FakeS3ObjectClient();
    const conflictStore = new S3BlobStore(conflictClient, config);
    const conflictResults = await Promise.allSettled([
      conflictStore.putStaging({ ...sameInput, uploadId: "concurrent-conflict" }),
      conflictStore.putStaging({
        ...sameInput,
        uploadId: "concurrent-conflict",
        body: bytes("different"),
      }),
    ]);
    expect(conflictResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = conflictResults.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: { code: "BLOB_IDEMPOTENCY_CONFLICT" },
    });
    expect(conflictClient.successfulPuts).toBe(1);
  });

  it("mediaType 是业务引用元数据，不参与内容身份", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, config);
    const base = {
      scope: { tenantId: "tenant_a" },
      purpose: "resource" as const,
      uploadId: "media-concurrent",
      body: bytes("same-content"),
    };
    const [text, binary] = await Promise.all([
      store.putStaging({ ...base, mediaType: "text/plain" }),
      store.putStaging({ ...base, mediaType: "application/octet-stream" }),
    ]);
    expect(client.successfulPuts).toBe(1);
    expect(text.mediaType).not.toBe(binary.mediaType);

    const [textStable, binaryStable] = await Promise.all([
      store.promote(base.scope, text),
      store.promote(base.scope, binary),
    ]);
    expect(textStable.sha256).toBe(binaryStable.sha256);
    await expect(store.head(base.scope, binaryStable)).resolves.toBeDefined();
  });

  it("校验调用方声明的哈希和大小", async () => {
    const store = new S3BlobStore(new FakeS3ObjectClient(), config);
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
    const store = new S3BlobStore(client, config);

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
    const store = new S3BlobStore(client, config);

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

  it("写响应与后续 HEAD 都失败时不能收敛成明确失败", async () => {
    const client = new FakeS3ObjectClient();
    client.putUnknownAfterWrite = true;
    client.failVerificationHeadAfterUnknownWrite = true;
    const store = new S3BlobStore(client, config);
    await expect(
      store.putStaging({
        scope: { tenantId: "tenant_a" },
        purpose: "trace",
        uploadId: "unknown-head-failed",
        body: bytes("trace"),
        mediaType: "application/json",
      }),
    ).rejects.toMatchObject({ code: "BLOB_RESULT_UNKNOWN", result: "unknown" });
  });

  it("提升为内容寻址稳定对象，并校验读取内容", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, { ...config, prefix: "test" });
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
    expect(new TextDecoder().decode(await store.getBytes(scope, stable))).toBe("deliverable");
    expect(await store.promote(scope, staged)).toEqual(stable);
    expect(client.copyKeys).toHaveLength(1);
  });

  it("限制预签名 TTL 和下载文件名", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, {
      ...config,
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
      store.presignDownload({
        scope,
        blob: stable,
        ttlSeconds: 121,
        responseMediaType: "application/pdf",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_BLOB_ARGUMENT",
    });
    await expect(
      store.presignDownload({
        scope,
        blob: stable,
        ttlSeconds: 60,
        responseMediaType: "application/pdf",
        downloadName: "bad\r\nname",
      }),
    ).rejects.toMatchObject({ code: "INVALID_BLOB_ARGUMENT" });
    await expect(
      store.presignDownload({
        scope,
        blob: stable,
        ttlSeconds: 60,
        responseMediaType: "application/pdf",
        downloadName: "报告.txt",
      }),
    ).resolves.toContain("ttl=60");
    expect(client.presignInputs.at(-1)).toMatchObject({
      responseMediaType: "application/pdf",
      delivery: "artifact-download",
      downloadName: "报告.txt",
    });

    await store.presignDownload({
      scope,
      blob: { ...stable, mediaType: "image/png" },
      ttlSeconds: 60,
      responseMediaType: "text/markdown",
      delivery: "inline-preview",
    });
    expect(client.presignInputs.at(-1)).toMatchObject({
      responseMediaType: "text/markdown",
      delivery: "inline-preview",
    });
  });

  it("上传前、GET ContentLength 和流式读取过程都执行大小上限", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, { ...config, maxBlobSizeBytes: 5 });
    await expect(
      store.putStaging({
        scope: { tenantId: "tenant_a" },
        purpose: "preview",
        uploadId: "too-large",
        body: bytes("123456"),
        mediaType: "text/plain",
      }),
    ).rejects.toMatchObject({ code: "INVALID_BLOB_ARGUMENT" });
    expect(client.putKeys).toHaveLength(0);

    const staged = await store.putStaging({
      scope: { tenantId: "tenant_a" },
      purpose: "preview",
      uploadId: "read-limit",
      body: bytes("1234"),
      mediaType: "text/plain",
    });
    client.contentLengthOverride = 6;
    await expect(store.getBytes({ tenantId: "tenant_a" }, staged)).rejects.toMatchObject({
      code: "BLOB_INTEGRITY_MISMATCH",
    });
    client.contentLengthOverride = undefined;
    client.extraReadChunk = bytes("56");
    await expect(store.getBytes({ tenantId: "tenant_a" }, staged)).rejects.toMatchObject({
      code: "BLOB_INTEGRITY_MISMATCH",
    });
  });

  it("删除响应未知时通过 HEAD 区分已删除与仍存在", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, config);
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "preview",
      uploadId: "delete-1",
      body: bytes("preview"),
      mediaType: "text/plain",
    });

    client.deleteUnknownAfterDelete = true;
    await expect(store.deleteStaging(scope, staged)).resolves.toBeUndefined();

    const stagedAgain = await store.putStaging({
      scope,
      purpose: "preview",
      uploadId: "delete-2",
      body: bytes("preview"),
      mediaType: "text/plain",
    });
    client.deleteUnknownWithoutDelete = true;
    await expect(store.deleteStaging(scope, stagedAgain)).rejects.toMatchObject({
      code: "BLOB_RESULT_UNKNOWN",
      result: "unknown",
    });

    const headFailureClient = new FakeS3ObjectClient();
    const headFailureStore = new S3BlobStore(headFailureClient, config);
    const stagedWithHeadFailure = await headFailureStore.putStaging({
      scope,
      purpose: "preview",
      uploadId: "delete-3",
      body: bytes("preview"),
      mediaType: "text/plain",
    });
    headFailureClient.deleteUnknownWithoutDelete = true;
    headFailureClient.failVerificationHeadAfterUnknownDelete = true;
    await expect(
      headFailureStore.deleteStaging(scope, stagedWithHeadFailure),
    ).rejects.toMatchObject({
      code: "BLOB_RESULT_UNKNOWN",
      result: "unknown",
    });
  });

  it("stable GC 事务 claim 阻止并发新增引用，删除完成后按 generation 完成", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, { ...config, prefix: "gc-test" });
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "gc-1",
      body: bytes("stable"),
      mediaType: "text/plain",
    });
    const stable = await store.promote(scope, staged);
    const lifecycle = new InMemoryStableLifecycle(scope.tenantId, stable);
    const gc = new S3StableBlobGarbageCollector(
      client,
      lifecycle,
      "gc-test",
      config.maxBlobSizeBytes,
    );
    await expect(gc.collectIfUnreachable(scope, stable)).resolves.toBe("still_referenced");
    await expect(store.head(scope, stable)).resolves.toBeDefined();
    lifecycle.removeReference();
    const referencePort: Pick<BlobReferenceCommitPort, "markReferenceStable"> = {
      async markReferenceStable() {
        return lifecycle.addVerifiedReference() === "added" ? "marked" : "gc_in_progress";
      },
    };
    lifecycle.onClaim = async () => {
      await expect(
        referencePort.markReferenceStable({
          scope,
          operationId: "concurrent-reference",
          referenceId: "reference-2",
          stable,
        }),
      ).resolves.toBe("gc_in_progress");
    };
    await expect(gc.collectIfUnreachable(scope, stable)).resolves.toBe("deleted");
    expect(lifecycle.state).toBe("deleted");
    expect(lifecycle.completedGeneration).toBe(1);
    await expect(store.head(scope, stable)).resolves.toBeUndefined();
  });

  it("stable 删除结果 UNKNOWN 时保留 deleting claim 交给恢复任务", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, { ...config, prefix: "gc-unknown" });
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "gc-unknown-1",
      body: bytes("stable"),
      mediaType: "text/plain",
    });
    const stable = await store.promote(scope, staged);
    const lifecycle = new InMemoryStableLifecycle(scope.tenantId, stable, 0);
    const gc = new S3StableBlobGarbageCollector(
      client,
      lifecycle,
      "gc-unknown",
      config.maxBlobSizeBytes,
    );
    client.deleteUnknownWithoutDelete = true;

    await expect(gc.collectIfUnreachable(scope, stable)).rejects.toMatchObject({
      code: "BLOB_RESULT_UNKNOWN",
      result: "unknown",
    });
    expect(lifecycle.state).toBe("deleting");
    expect(lifecycle.releaseCount).toBe(0);
    expect(lifecycle.addVerifiedReference()).toBe("gc_in_progress");
  });

  it("stable 删除明确失败时释放同 generation claim", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, { ...config, prefix: "gc-known-failure" });
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "gc-known-failure-1",
      body: bytes("stable"),
      mediaType: "text/plain",
    });
    const stable = await store.promote(scope, staged);
    const lifecycle = new InMemoryStableLifecycle(scope.tenantId, stable, 0);
    const gc = new S3StableBlobGarbageCollector(
      client,
      lifecycle,
      "gc-known-failure",
      config.maxBlobSizeBytes,
    );
    client.deleteKnownFailure = true;

    await expect(gc.collectIfUnreachable(scope, stable)).rejects.toMatchObject({
      code: "BLOB_PROVIDER_ERROR",
      result: "known",
    });
    expect(lifecycle.state).toBe("active");
    expect(lifecycle.releaseCount).toBe(1);
    await expect(store.head(scope, stable)).resolves.toBeDefined();
  });

  it("stable GC 端口拒绝过期 generation 的 Worker 完成新 claim", async () => {
    const scope = { tenantId: "tenant_a" };
    const stable: StableBlobRef = {
      kind: "stable",
      tenantId: scope.tenantId,
      purpose: "artifact",
      sha256: "a".repeat(64),
      size: 1,
      mediaType: "text/plain",
    };
    const lifecycle = new InMemoryStableLifecycle(scope.tenantId, stable, 0);
    const first = await lifecycle.claimUnreachable({ scope, blob: stable });
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") {
      throw new Error("测试前置条件错误");
    }
    await lifecycle.releaseClaim({ scope, blob: stable, claim: first.claim });
    const second = await lifecycle.claimUnreachable({ scope, blob: stable });
    expect(second.status).toBe("claimed");

    await expect(
      lifecycle.completeDeletion({ scope, blob: stable, claim: first.claim }),
    ).rejects.toThrow("generation 已失效");
  });

  it("RFC 5987 编码覆盖中文与 encodeURIComponent 保留字符", () => {
    expect(encodeRfc5987Value("报告'()*!.txt")).toBe("%E6%8A%A5%E5%91%8A%27%28%29%2A%21.txt");
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
  readonly presignInputs: S3PresignInput[] = [];
  putUnknownAfterWrite = false;
  putUnknownWithoutWrite = false;
  deleteUnknownAfterDelete = false;
  deleteUnknownWithoutDelete = false;
  deleteKnownFailure = false;
  successfulPuts = 0;
  contentLengthOverride: number | undefined;
  extraReadChunk: Uint8Array | undefined;
  failVerificationHeadAfterUnknownWrite = false;
  failVerificationHeadAfterUnknownDelete = false;
  private failNextHead = false;

  async put(input: S3PutObjectInput): Promise<void> {
    this.putKeys.push(input.key);
    if (this.objects.has(input.key)) {
      throw new BlobStoreError("BLOB_PRECONDITION_FAILED", "fake conditional conflict");
    }
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
      this.successfulPuts += 1;
    }
    if (this.putUnknownAfterWrite || this.putUnknownWithoutWrite) {
      this.failNextHead = this.failVerificationHeadAfterUnknownWrite;
      throw unknownResult();
    }
  }

  async head(key: string): Promise<S3ObjectMetadata | undefined> {
    if (this.failNextHead) {
      this.failNextHead = false;
      throw new BlobStoreError("BLOB_PROVIDER_ERROR", "fake head failure");
    }
    return this.objects.get(key)?.metadata;
  }

  async get(key: string): Promise<S3GetObjectResult | undefined> {
    const object = this.objects.get(key);
    if (object === undefined) {
      return undefined;
    }
    const body = object.body.slice();
    const extra = this.extraReadChunk;
    return {
      contentLength: this.contentLengthOverride ?? body.byteLength,
      body: (async function* () {
        yield body;
        if (extra !== undefined) {
          yield extra;
        }
      })(),
    };
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
    if (this.deleteKnownFailure) {
      throw new BlobStoreError("BLOB_PROVIDER_ERROR", "fake known delete failure");
    }
    if (!this.deleteUnknownWithoutDelete) {
      this.objects.delete(key);
    }
    if (this.deleteUnknownAfterDelete || this.deleteUnknownWithoutDelete) {
      this.failNextHead = this.failVerificationHeadAfterUnknownDelete;
      throw unknownResult();
    }
  }

  async presignGet(input: S3PresignInput): Promise<string> {
    this.presignInputs.push(input);
    return `https://example.invalid/private?ttl=${input.ttlSeconds}`;
  }
}

class InMemoryStableLifecycle implements StableBlobGcClaimPort {
  state: "active" | "deleting" | "deleted" = "active";
  completedGeneration: number | undefined;
  releaseCount = 0;
  onClaim: (() => Promise<void>) | undefined;
  private generation = 0;

  constructor(
    private readonly tenantId: string,
    private readonly blob: StableBlobRef,
    private references = 1,
  ) {}

  addVerifiedReference(): "added" | "gc_in_progress" {
    if (this.state === "deleting") {
      return "gc_in_progress";
    }
    // 测试端口模拟 markReferenceStable 已完成 promote + HEAD；deleted 可原子恢复 active。
    if (this.state === "deleted") {
      this.state = "active";
    }
    this.references += 1;
    return "added";
  }

  removeReference(): void {
    this.references -= 1;
  }

  async claimUnreachable(input: { readonly scope: TenantBlobScope; readonly blob: StableBlobRef }) {
    this.assertTarget(input.scope, input.blob);
    if (this.references > 0) {
      return { status: "still_referenced" as const };
    }
    this.state = "deleting";
    this.generation += 1;
    const claim = this.claim();
    await this.onClaim?.();
    return { status: "claimed" as const, claim };
  }

  async completeDeletion(input: {
    readonly scope: TenantBlobScope;
    readonly blob: StableBlobRef;
    readonly claim: StableBlobGcClaim;
  }) {
    this.assertTarget(input.scope, input.blob);
    this.assertGeneration(input.claim.generation);
    this.state = "deleted";
    this.completedGeneration = input.claim.generation;
  }

  async releaseClaim(input: {
    readonly scope: TenantBlobScope;
    readonly blob: StableBlobRef;
    readonly claim: StableBlobGcClaim;
  }) {
    this.assertTarget(input.scope, input.blob);
    this.assertGeneration(input.claim.generation);
    this.state = "active";
    this.releaseCount += 1;
  }

  private claim() {
    return {
      claimId: `claim-${this.generation}`,
      generation: this.generation,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      tenantId: this.tenantId,
      purpose: this.blob.purpose,
      sha256: this.blob.sha256,
      size: this.blob.size,
    };
  }

  private assertGeneration(generation: number): void {
    if (this.state !== "deleting" || generation !== this.generation) {
      throw new Error("GC claim generation 已失效");
    }
  }

  private assertTarget(scope: TenantBlobScope, blob: StableBlobRef): void {
    if (
      scope.tenantId !== this.tenantId ||
      blob.tenantId !== this.blob.tenantId ||
      blob.purpose !== this.blob.purpose ||
      blob.sha256 !== this.blob.sha256 ||
      blob.size !== this.blob.size
    ) {
      throw new Error("GC claim 目标不匹配");
    }
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function unknownResult(): BlobStoreError {
  return new BlobStoreError("BLOB_RESULT_UNKNOWN", "fake unknown", { result: "unknown" });
}

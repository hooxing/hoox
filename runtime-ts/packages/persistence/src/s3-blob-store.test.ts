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
const defaultAllocation = { incarnationId: "00000000-0000-4000-8000-000000000001" } as const;

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
      store.promote(base.scope, text, defaultAllocation),
      store.promote(base.scope, binary, defaultAllocation),
    ]);
    expect(textStable.sha256).toBe(binaryStable.sha256);
    await expect(store.head(base.scope, binaryStable)).resolves.toBeDefined();
  });

  it("校验调用方声明的哈希和大小", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, config);
    await expect(
      store.putStaging({
        scope: { tenantId: "tenant_a" },
        purpose: "artifact",
        uploadId: "invalid-expected-hash",
        body: bytes("actual"),
        mediaType: "text/plain",
        expectedSha256: "not-a-sha256",
      }),
    ).rejects.toMatchObject({ code: "INVALID_BLOB_ARGUMENT" });
    await expect(
      store.putStaging({
        scope: { tenantId: "tenant_a" },
        purpose: "artifact",
        uploadId: "invalid-expected-size",
        body: bytes("actual"),
        mediaType: "text/plain",
        expectedSize: -1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_BLOB_ARGUMENT" });
    expect(client.putKeys).toEqual([]);
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
    const stable = await store.promote(scope, staged, defaultAllocation);

    expect(client.copyKeys).toEqual([
      {
        sourceKey: "test/tenants/tenant_a/staging/artifact/promote-1",
        destinationKey: `test/stable/tenant_a/artifact/sha256/${stable.sha256}/incarnations/${defaultAllocation.incarnationId}`,
      },
    ]);
    expect(new TextDecoder().decode(await store.getBytes(scope, stable))).toBe("deliverable");
    expect(await store.promote(scope, staged, defaultAllocation)).toEqual(stable);
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
    const stable = await store.promote(scope, staged, defaultAllocation);

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
    const delivered: Uint8Array[] = [];
    await expect(
      (async () => {
        for await (const chunk of store.read({ tenantId: "tenant_a" }, staged)) {
          delivered.push(chunk);
        }
      })(),
    ).rejects.toMatchObject({ code: "BLOB_INTEGRITY_MISMATCH" });
    expect(delivered).toEqual([]);

    client.extraReadChunk = undefined;
    const key = client.putKeys.at(-1);
    const stored = key === undefined ? undefined : client.objects.get(key);
    if (key === undefined || stored === undefined) {
      throw new Error("测试前置对象不存在");
    }
    client.objects.set(key, { ...stored, body: bytes("zzzz") });
    const deliveredBeforeHash: Uint8Array[] = [];
    await expect(
      (async () => {
        for await (const chunk of store.read({ tenantId: "tenant_a" }, staged)) {
          deliveredBeforeHash.push(chunk);
        }
      })(),
    ).rejects.toMatchObject({ code: "BLOB_INTEGRITY_MISMATCH" });
    expect(deliveredBeforeHash).toEqual([]);
  });

  it("HEAD 返回的 metadata.size 超限统一视为存储完整性错误", async () => {
    const scope = { tenantId: "tenant_a" };

    const headClient = new FakeS3ObjectClient();
    const headStore = new S3BlobStore(headClient, { ...config, maxBlobSizeBytes: 8 });
    const headStaged = await headStore.putStaging({
      scope,
      purpose: "preview",
      uploadId: "head-size",
      body: bytes("1234"),
      mediaType: "text/plain",
    });
    headClient.headSizeOverride = 9;
    await expect(headStore.head(scope, headStaged)).rejects.toMatchObject({
      code: "BLOB_INTEGRITY_MISMATCH",
    });

    const promoteClient = new FakeS3ObjectClient();
    const promoteStore = new S3BlobStore(promoteClient, { ...config, maxBlobSizeBytes: 8 });
    const promoteStaged = await promoteStore.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "promote-size",
      body: bytes("1234"),
      mediaType: "text/plain",
    });
    promoteClient.headSizeOverride = 9;
    await expect(
      promoteStore.promote(scope, promoteStaged, defaultAllocation),
    ).rejects.toMatchObject({
      code: "BLOB_INTEGRITY_MISMATCH",
    });

    const presignClient = new FakeS3ObjectClient();
    const presignStore = new S3BlobStore(presignClient, { ...config, maxBlobSizeBytes: 8 });
    const presignStaged = await presignStore.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "presign-size",
      body: bytes("1234"),
      mediaType: "text/plain",
    });
    const stable = await presignStore.promote(scope, presignStaged, defaultAllocation);
    presignClient.headSizeOverride = 9;
    await expect(
      presignStore.presignDownload({
        scope,
        blob: stable,
        ttlSeconds: 30,
        responseMediaType: "text/plain",
      }),
    ).rejects.toMatchObject({ code: "BLOB_INTEGRITY_MISMATCH" });
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
    const stable = await store.promote(scope, staged, defaultAllocation);
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
    const stable = await store.promote(scope, staged, defaultAllocation);
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

  it("stable 远端删除明确失败后仍保持不可逆 deleting", async () => {
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
    const stable = await store.promote(scope, staged, defaultAllocation);
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
    expect(lifecycle.state).toBe("deleting");
    expect(lifecycle.releaseCount).toBe(0);
    expect(lifecycle.addVerifiedReference()).toBe("gc_in_progress");
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
      incarnationId: defaultAllocation.incarnationId,
      physicalObjectKey: `gc-generation/stable/tenant_a/artifact/sha256/${"a".repeat(64)}/incarnations/${defaultAllocation.incarnationId}`,
    };
    const lifecycle = new InMemoryStableLifecycle(scope.tenantId, stable, 0);
    const first = await lifecycle.claimUnreachable({ scope, blob: stable });
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") {
      throw new Error("测试前置条件错误");
    }
    await lifecycle.releasePreDeleteClaim({ scope, blob: stable, claim: first.claim });
    const second = await lifecycle.claimUnreachable({ scope, blob: stable });
    expect(second.status).toBe("claimed");

    await expect(
      lifecycle.completeDeletion({ scope, blob: stable, claim: first.claim }),
    ).rejects.toThrow("generation 已失效");
  });

  it("stable GC 的 begin、complete、release 都联合校验 claimId 与 generation", async () => {
    const scope = { tenantId: "tenant_a" };
    const stable: StableBlobRef = {
      kind: "stable",
      tenantId: scope.tenantId,
      purpose: "artifact",
      sha256: "b".repeat(64),
      size: 1,
      mediaType: "text/plain",
      incarnationId: defaultAllocation.incarnationId,
      physicalObjectKey: `gc-cas/stable/tenant_a/artifact/sha256/${"b".repeat(64)}/incarnations/${defaultAllocation.incarnationId}`,
    };
    const lifecycle = new InMemoryStableLifecycle(scope.tenantId, stable, 0);
    const claimed = await lifecycle.claimUnreachable({ scope, blob: stable });
    if (claimed.status !== "claimed") {
      throw new Error("测试前置 claim 失败");
    }
    const wrongPreDelete = { ...claimed.claim, claimId: "same-generation-wrong-id" };
    await expect(
      lifecycle.beginDeletion({ scope, blob: stable, claim: wrongPreDelete }),
    ).resolves.toEqual({ status: "claim_lost" });
    await expect(
      lifecycle.releasePreDeleteClaim({ scope, blob: stable, claim: wrongPreDelete }),
    ).rejects.toThrow("pre-delete claim 已失效");

    const begun = await lifecycle.beginDeletion({ scope, blob: stable, claim: claimed.claim });
    if (begun.status !== "started") {
      throw new Error("测试前置 begin 失败");
    }
    await expect(
      lifecycle.completeDeletion({
        scope,
        blob: stable,
        claim: { ...begun.claim, claimId: "same-generation-wrong-id" },
      }),
    ).rejects.toThrow("generation 已失效");
  });

  it("GC claim 的格式、Tenant 和物理身份错误使用稳定分类，executor 不判断数据库租约时钟", async () => {
    const scope = { tenantId: "tenant_a" };
    const stable: StableBlobRef = {
      kind: "stable",
      tenantId: scope.tenantId,
      purpose: "artifact",
      sha256: "c".repeat(64),
      size: 1,
      mediaType: "text/plain",
      incarnationId: defaultAllocation.incarnationId,
      physicalObjectKey: `gc-claim-validation/stable/tenant_a/artifact/sha256/${"c".repeat(64)}/incarnations/${defaultAllocation.incarnationId}`,
    };
    const validClaim: StableBlobGcClaim = {
      claimId: "claim-valid",
      generation: 1,
      phase: "pre_delete",
      // 是否仍有效由 PG claim 结果决定；executor 只验证可解析格式，不读取应用进程时钟。
      leaseExpiresAt: "2000-01-01T00:00:00.000Z",
      tenantId: scope.tenantId,
      purpose: stable.purpose,
      sha256: stable.sha256,
      size: stable.size,
      incarnationId: stable.incarnationId,
      physicalObjectKey: stable.physicalObjectKey,
    };

    const validGc = new S3StableBlobGarbageCollector(
      new FakeS3ObjectClient(),
      fixedClaimPort(validClaim),
      "gc-claim-validation",
      config.maxBlobSizeBytes,
    );
    await expect(validGc.collectIfUnreachable(scope, stable)).resolves.toBe("deleted");

    for (const invalidClaim of [
      { ...validClaim, claimId: "" },
      { ...validClaim, generation: 0 },
      { ...validClaim, phase: "invalid" as "pre_delete" },
    ]) {
      const gc = new S3StableBlobGarbageCollector(
        new FakeS3ObjectClient(),
        fixedClaimPort(invalidClaim),
        "gc-claim-validation",
        config.maxBlobSizeBytes,
      );
      await expect(gc.collectIfUnreachable(scope, stable)).rejects.toMatchObject({
        code: "INVALID_BLOB_ARGUMENT",
      });
    }

    const tenantGc = new S3StableBlobGarbageCollector(
      new FakeS3ObjectClient(),
      fixedClaimPort({ ...validClaim, tenantId: "tenant_b" }),
      "gc-claim-validation",
      config.maxBlobSizeBytes,
    );
    await expect(tenantGc.collectIfUnreachable(scope, stable)).rejects.toMatchObject({
      code: "TENANT_SCOPE_MISMATCH",
    });

    const physicalGc = new S3StableBlobGarbageCollector(
      new FakeS3ObjectClient(),
      fixedClaimPort({ ...validClaim, physicalObjectKey: `${validClaim.physicalObjectKey}-other` }),
      "gc-claim-validation",
      config.maxBlobSizeBytes,
    );
    await expect(physicalGc.collectIfUnreachable(scope, stable)).rejects.toMatchObject({
      code: "BLOB_INTEGRITY_MISMATCH",
    });
  });

  it("旧 DELETE 在途时 lease 过期，gen2 失败也不能恢复引用，最终由 gen3 收敛", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, { ...config, prefix: "gc-delayed-delete" });
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "gc-delayed-delete-1",
      body: bytes("stable"),
      mediaType: "text/plain",
    });
    const stable = await store.promote(scope, staged, defaultAllocation);
    const lifecycle = new InMemoryStableLifecycle(scope.tenantId, stable, 0);
    const gc = new S3StableBlobGarbageCollector(
      client,
      lifecycle,
      "gc-delayed-delete",
      config.maxBlobSizeBytes,
    );

    const delayed = controlledDeleteHook();
    client.deleteHooks.push(delayed.hook);
    const oldWorkerOutcome = gc.collectIfUnreachable(scope, stable).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await delayed.started;
    expect(lifecycle.state).toBe("deleting");

    // lease 未到期时不能签发第二个 claim，也不能再次触发远端 DELETE。
    await expect(gc.collectIfUnreachable(scope, stable)).resolves.toBe("in_progress");
    expect(client.deleteHooks).toHaveLength(0);

    lifecycle.advancePastLease();
    client.deleteHooks.push(async () => {
      throw new BlobStoreError("BLOB_PROVIDER_ERROR", "gen2 明确删除失败");
    });
    await expect(gc.collectIfUnreachable(scope, stable)).rejects.toMatchObject({
      code: "BLOB_PROVIDER_ERROR",
      result: "known",
    });
    expect(lifecycle.state).toBe("deleting");
    expect(lifecycle.addVerifiedReference()).toBe("gc_in_progress");

    // gen1 的旧 DELETE 随后成功，但旧 generation 无权完成 PG 状态。
    delayed.succeed();
    const oldOutcome = await oldWorkerOutcome;
    expect(oldOutcome.status).toBe("rejected");
    expect(lifecycle.state).toBe("deleting");
    await expect(store.head(scope, stable)).resolves.toBeUndefined();
    expect(lifecycle.addVerifiedReference()).toBe("gc_in_progress");

    lifecycle.advancePastLease();
    await expect(gc.collectIfUnreachable(scope, stable)).resolves.toBe("deleted");
    expect(lifecycle.state).toBe("deleted");
    expect(lifecycle.completedGeneration).toBe(3);
  });

  it("旧 incarnation 的在途 DELETE 不会删除 deleted 后发布的新 incarnation", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, { ...config, prefix: "gc-incarnation-race" });
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "gc-incarnation-race-1",
      body: bytes("stable"),
      mediaType: "text/plain",
    });
    const oldStable = await store.promote(scope, staged, defaultAllocation);
    const lifecycle = new InMemoryStableLifecycle(scope.tenantId, oldStable, 0);
    const gc = new S3StableBlobGarbageCollector(
      client,
      lifecycle,
      "gc-incarnation-race",
      config.maxBlobSizeBytes,
    );

    const delayed = controlledDeleteHook();
    client.deleteHooks.push(delayed.hook);
    const gen1Outcome = gc.collectIfUnreachable(scope, oldStable).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await delayed.started;

    lifecycle.advancePastLease();
    await expect(gc.collectIfUnreachable(scope, oldStable)).resolves.toBe("deleted");
    expect(lifecycle.completedGeneration).toBe(2);
    await expect(store.head(scope, oldStable)).resolves.toBeUndefined();

    const newAllocation = {
      incarnationId: "00000000-0000-4000-8000-000000000002",
    } as const;
    const newStable = await store.promote(scope, staged, newAllocation);
    expect(newStable.sha256).toBe(oldStable.sha256);
    expect(newStable.physicalObjectKey).not.toBe(oldStable.physicalObjectKey);
    lifecycle.publishNewIncarnation(newStable);
    expect(lifecycle.addVerifiedReference()).toBe("added");
    await expect(store.getBytes(scope, newStable)).resolves.toEqual(bytes("stable"));

    delayed.succeed();
    expect((await gen1Outcome).status).toBe("rejected");
    await expect(store.getBytes(scope, newStable)).resolves.toEqual(bytes("stable"));
    expect(client.deleteKeys).toEqual([oldStable.physicalObjectKey, oldStable.physicalObjectKey]);
    expect(client.deleteKeys).not.toContain(newStable.physicalObjectKey);
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
  readonly deleteHooks: Array<() => Promise<void>> = [];
  readonly deleteKeys: string[] = [];
  putUnknownAfterWrite = false;
  putUnknownWithoutWrite = false;
  deleteUnknownAfterDelete = false;
  deleteUnknownWithoutDelete = false;
  deleteKnownFailure = false;
  successfulPuts = 0;
  contentLengthOverride: number | undefined;
  extraReadChunk: Uint8Array | undefined;
  headSizeOverride: number | undefined;
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
    const metadata = this.objects.get(key)?.metadata;
    return metadata === undefined || this.headSizeOverride === undefined
      ? metadata
      : { ...metadata, size: this.headSizeOverride };
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
    this.deleteKeys.push(key);
    const hook = this.deleteHooks.shift();
    if (hook !== undefined) {
      await hook();
    }
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
  state: "active" | "pre_delete" | "deleting" | "deleted" = "active";
  completedGeneration: number | undefined;
  releaseCount = 0;
  onClaim: (() => Promise<void>) | undefined;
  private generation = 0;
  private logicalNow = Date.now();
  private leaseDeadline = 0;

  constructor(
    private readonly tenantId: string,
    private blob: StableBlobRef,
    private references = 1,
  ) {}

  addVerifiedReference(): "added" | "gc_in_progress" {
    if (this.state === "pre_delete" || this.state === "deleting") {
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

  advancePastLease(): void {
    this.logicalNow = this.leaseDeadline + 1;
  }

  publishNewIncarnation(blob: StableBlobRef): void {
    if (this.state !== "deleted") {
      throw new Error("只有 deleted 生命周期才能发布新 incarnation");
    }
    if (
      blob.tenantId !== this.blob.tenantId ||
      blob.purpose !== this.blob.purpose ||
      blob.sha256 !== this.blob.sha256 ||
      blob.size !== this.blob.size ||
      blob.incarnationId === this.blob.incarnationId ||
      blob.physicalObjectKey === this.blob.physicalObjectKey
    ) {
      throw new Error("新 incarnation 的逻辑身份或物理身份无效");
    }
    this.generation += 1;
    this.blob = blob;
    this.references = 0;
    this.state = "active";
  }

  async claimUnreachable(input: { readonly scope: TenantBlobScope; readonly blob: StableBlobRef }) {
    this.assertTarget(input.scope, input.blob);
    if (this.state === "deleted") {
      return { status: "already_deleted" as const };
    }
    if (this.references > 0) {
      return { status: "still_referenced" as const };
    }
    if (
      (this.state === "pre_delete" || this.state === "deleting") &&
      this.logicalNow <= this.leaseDeadline
    ) {
      return { status: "in_progress" as const };
    }
    if (this.state === "active") {
      this.state = "pre_delete";
    }
    this.generation += 1;
    this.leaseDeadline = this.logicalNow + 60_000;
    const claim = this.claim();
    await this.onClaim?.();
    return { status: "claimed" as const, claim };
  }

  async beginDeletion(input: {
    readonly scope: TenantBlobScope;
    readonly blob: StableBlobRef;
    readonly claim: StableBlobGcClaim;
  }) {
    this.assertTarget(input.scope, input.blob);
    if (
      this.state !== "pre_delete" ||
      input.claim.phase !== "pre_delete" ||
      !this.matchesCurrentClaim(input.claim)
    ) {
      return { status: "claim_lost" as const };
    }
    this.state = "deleting";
    return { status: "started" as const, claim: this.claim() };
  }

  async completeDeletion(input: {
    readonly scope: TenantBlobScope;
    readonly blob: StableBlobRef;
    readonly claim: StableBlobGcClaim;
  }) {
    this.assertTarget(input.scope, input.blob);
    this.assertDeletingGeneration(input.claim);
    this.state = "deleted";
    this.completedGeneration = input.claim.generation;
  }

  async releasePreDeleteClaim(input: {
    readonly scope: TenantBlobScope;
    readonly blob: StableBlobRef;
    readonly claim: StableBlobGcClaim;
  }) {
    this.assertTarget(input.scope, input.blob);
    if (
      this.state !== "pre_delete" ||
      input.claim.phase !== "pre_delete" ||
      !this.matchesCurrentClaim(input.claim)
    ) {
      throw new Error("GC pre-delete claim 已失效");
    }
    this.state = "active";
    this.releaseCount += 1;
  }

  async resolveLifecycle(input: { readonly scope: TenantBlobScope; readonly blob: StableBlobRef }) {
    this.assertTarget(input.scope, input.blob);
    return this.state;
  }

  private claim() {
    return {
      claimId: `claim-${this.generation}`,
      generation: this.generation,
      leaseExpiresAt: new Date(this.leaseDeadline).toISOString(),
      phase: this.state === "pre_delete" ? ("pre_delete" as const) : ("deleting" as const),
      tenantId: this.tenantId,
      purpose: this.blob.purpose,
      sha256: this.blob.sha256,
      size: this.blob.size,
      incarnationId: this.blob.incarnationId,
      physicalObjectKey: this.blob.physicalObjectKey,
    };
  }

  private assertDeletingGeneration(claim: StableBlobGcClaim): void {
    if (
      this.state !== "deleting" ||
      claim.phase !== "deleting" ||
      !this.matchesCurrentClaim(claim)
    ) {
      throw new Error("GC claim generation 已失效");
    }
  }

  private assertTarget(scope: TenantBlobScope, blob: StableBlobRef): void {
    if (
      scope.tenantId !== this.tenantId ||
      blob.tenantId !== this.blob.tenantId ||
      blob.purpose !== this.blob.purpose ||
      blob.sha256 !== this.blob.sha256 ||
      blob.size !== this.blob.size ||
      blob.incarnationId !== this.blob.incarnationId ||
      blob.physicalObjectKey !== this.blob.physicalObjectKey
    ) {
      throw new Error("GC claim 目标不匹配");
    }
  }

  private matchesCurrentClaim(claim: StableBlobGcClaim): boolean {
    return claim.generation === this.generation && claim.claimId === `claim-${this.generation}`;
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function unknownResult(): BlobStoreError {
  return new BlobStoreError("BLOB_RESULT_UNKNOWN", "fake unknown", { result: "unknown" });
}

function controlledDeleteHook(): {
  readonly hook: () => Promise<void>;
  readonly started: Promise<void>;
  readonly succeed: () => void;
} {
  let markStarted: (() => void) | undefined;
  let finish: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    hook: async () => {
      markStarted?.();
      await completion;
    },
    started,
    succeed: () => finish?.(),
  };
}

function fixedClaimPort(claim: StableBlobGcClaim): StableBlobGcClaimPort {
  return {
    async claimUnreachable() {
      return { status: "claimed", claim };
    },
    async beginDeletion() {
      return { status: "started", claim: { ...claim, phase: "deleting" } };
    },
    async completeDeletion() {},
    async releasePreDeleteClaim() {},
    async resolveLifecycle() {
      return "pre_delete";
    },
  };
}

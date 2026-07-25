import { describe, expect, it } from "vitest";
import {
  type BlobReferenceCommitPort,
  type BlobCommitSnapshot,
  BlobStoreError,
  type PromotionAuthorizationRef,
  type PromotionAuthorizationResolution,
  type PromotionExecutionClaim,
  type PromotionExecutionClaimResolution,
  type StableBlobGcClaim,
  type StableBlobGcClaimPort,
  type StableBlobLifecycleAllocation,
  type StableBlobLifecycleAllocationPort,
  type StableBlobPromotionAuthorization,
  type StableBlobPromotionAuthorizationPort,
  type StableBlobRetiredTombstonePort,
  type StableBlobRef,
  type StagedBlobRef,
  type TenantBlobScope,
  transitionBlobCommit,
} from "./index.js";
import {
  S3BlobStore,
  S3RetiredBlobTombstoneScrubber,
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
const defaultIncarnationId = "00000000-0000-4000-8000-000000000001";
const defaultLifecycleId = "10000000-0000-4000-8000-000000000001";
const defaultAllocationId = "20000000-0000-4000-8000-000000000001";
describe("S3BlobStore", () => {
  it("只使用派生键，并隔离 Tenant 与用途", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, promotionAuthorizations, { ...config, prefix: "test" });
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
    const store = new S3BlobStore(client, promotionAuthorizations, config);
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
    const sameStore = new S3BlobStore(sameClient, promotionAuthorizations, config);
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
    const conflictStore = new S3BlobStore(conflictClient, promotionAuthorizations, config);
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
    const store = new S3BlobStore(client, promotionAuthorizations, config);
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
    const { ref: authorization } = promotionAuthorizations.preparePromotion(text);
    const completionsBefore = promotionAuthorizations.successfulCompletionCount;

    const concurrent = await Promise.allSettled([
      store.promote(base.scope, text, authorization),
      store.promote(base.scope, binary, authorization),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(client.copyKeys).toHaveLength(1);
    expect(promotionAuthorizations.successfulCompletionCount - completionsBefore).toBe(1);
    const textStable = await store.promote(base.scope, text, authorization);
    const binaryStable = await store.promote(base.scope, binary, authorization);
    expect(textStable.sha256).toBe(binaryStable.sha256);
    await expect(store.head(base.scope, binaryStable)).resolves.toBeDefined();
  });

  it("校验调用方声明的哈希和大小", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, promotionAuthorizations, config);
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
    const store = new S3BlobStore(client, promotionAuthorizations, config);

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
    const store = new S3BlobStore(client, promotionAuthorizations, config);

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
    const store = new S3BlobStore(client, promotionAuthorizations, config);
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
    const store = new S3BlobStore(client, promotionAuthorizations, { ...config, prefix: "test" });
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "promote-1",
      body: bytes("deliverable"),
      mediaType: "text/plain",
    });
    const { ref: authorization, allocation } = promotionAuthorizations.preparePromotion(
      staged,
      "test",
    );
    const stable = await store.promote(scope, staged, authorization);

    expect(client.copyKeys).toEqual([
      {
        sourceKey: "test/tenants/tenant_a/staging/artifact/promote-1",
        destinationKey: allocation.physicalObjectKey,
      },
    ]);
    expect(new TextDecoder().decode(await store.getBytes(scope, stable))).toBe("deliverable");
    expect(await store.promote(scope, staged, authorization)).toEqual(stable);
    expect(client.copyKeys).toHaveLength(1);
  });

  it("COPY 结果 UNKNOWN 后以同一授权恢复到同一物理目标", async () => {
    const client = new FakeS3ObjectClient();
    client.copyUnknownWithoutWrite = true;
    const store = new S3BlobStore(client, promotionAuthorizations, config);
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "copy-unknown-same-authorization",
      body: bytes("deliverable"),
      mediaType: "text/plain",
    });
    const issued = promotionAuthorizations.preparePromotion(staged);

    await expect(store.promote(scope, staged, issued.ref)).rejects.toMatchObject({
      code: "BLOB_RESULT_UNKNOWN",
      result: "unknown",
    });
    client.copyUnknownWithoutWrite = false;
    await expect(store.promote(scope, staged, issued.ref)).rejects.toMatchObject({
      code: "BLOB_RESULT_UNKNOWN",
      result: "unknown",
    });
    expect(client.copyKeys).toHaveLength(1);
    // 模拟先前已经发出的远端请求迟到；reconcile 只能 HEAD，不能再次 COPY。
    await client.copy({
      sourceKey: issued.authorization.stagingObjectKey,
      destinationKey: issued.authorization.physicalObjectKey,
    });
    const stable = await store.promote(scope, staged, issued.ref);

    expect(stable.physicalObjectKey).toBe(issued.authorization.physicalObjectKey);
    expect(client.copyKeys.map((copy) => copy.destinationKey)).toEqual([
      issued.authorization.physicalObjectKey,
      issued.authorization.physicalObjectKey,
    ]);
  });

  it("COPY 已落盘但响应 UNKNOWN 时只 HEAD 授权绑定的物理键并收敛成功", async () => {
    const client = new FakeS3ObjectClient();
    client.copyUnknownAfterWrite = true;
    const store = new S3BlobStore(client, promotionAuthorizations, config);
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "copy-unknown-after-write",
      body: bytes("deliverable"),
      mediaType: "text/plain",
    });
    const prepared = promotionAuthorizations.preparePromotion(staged);

    const stable = await store.promote(scope, staged, prepared.ref);
    expect(stable.physicalObjectKey).toBe(prepared.authorization.physicalObjectKey);
    expect(client.copyKeys).toEqual([
      {
        sourceKey: prepared.authorization.stagingObjectKey,
        destinationKey: prepared.authorization.physicalObjectKey,
      },
    ]);
  });

  it("UNKNOWN 恢复时即使 source 已缺失，只要固定 destination 正确就收敛 succeeded", async () => {
    const client = new FakeS3ObjectClient();
    const state = new InMemoryPromotionAuthorizations();
    const store = new S3BlobStore(client, state, config);
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "unknown-source-missing",
      body: bytes("deliverable"),
      mediaType: "text/plain",
    });
    const prepared = state.preparePromotion(staged);
    const claim = await state.claimPromotionExecution({
      scope,
      authorization: prepared.ref,
      attemptId: "50000000-0000-4000-8000-000000000010",
    });
    if (claim.status !== "copy_allowed") throw new Error("UNKNOWN 前置 claim 失败");
    const marked = await state.markPromotionCopyIssued({ scope, execution: claim.execution });
    if (marked.status !== "marked") throw new Error("UNKNOWN 前置 intent 失败");
    await client.copy({
      sourceKey: prepared.authorization.stagingObjectKey,
      destinationKey: prepared.authorization.physicalObjectKey,
    });
    await store.deleteStaging(scope, staged);
    await state.completePromotionExecution({
      scope,
      execution: marked.execution,
      outcome: "unknown",
    });

    const stable = await store.promote(scope, staged, prepared.ref);
    expect(stable.physicalObjectKey).toBe(prepared.authorization.physicalObjectKey);
    expect(state.successfulCompletionCount).toBe(1);
  });

  it("source HEAD 后消失导致 COPY 明确失败，仍保持 UNKNOWN 且绝不发第二次 COPY", async () => {
    const client = new FakeS3ObjectClient();
    const state = new InMemoryPromotionAuthorizations();
    const store = new S3BlobStore(client, state, config);
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "source-disappears-after-head",
      body: bytes("deliverable"),
      mediaType: "text/plain",
    });
    const prepared = state.preparePromotion(staged);
    client.deleteSourceBeforeCopy = true;

    await expect(store.promote(scope, staged, prepared.ref)).rejects.toMatchObject({
      code: "BLOB_RESULT_UNKNOWN",
      result: "unknown",
    });
    client.deleteSourceBeforeCopy = false;
    await expect(store.promote(scope, staged, prepared.ref)).rejects.toMatchObject({
      code: "BLOB_RESULT_UNKNOWN",
      result: "unknown",
    });
    expect(client.copyKeys).toHaveLength(1);
    await expect(
      state.claimPromotionExecution({
        scope,
        authorization: prepared.ref,
        attemptId: "50000000-0000-4000-8000-000000000021",
      }),
    ).resolves.toMatchObject({ status: "reconcile", execution: { phase: "unknown" } });
  });

  it("COPY 成功后的首次验证失败只进入 reconcile，恢复时不再 COPY", async () => {
    const client = new FakeS3ObjectClient();
    const state = new InMemoryPromotionAuthorizations();
    const store = new S3BlobStore(client, state, config);
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "copy-verification-fails",
      body: bytes("deliverable"),
      mediaType: "text/plain",
    });
    const prepared = state.preparePromotion(staged);
    client.failHeadAfterCopySuccess = true;

    await expect(store.promote(scope, staged, prepared.ref)).rejects.toMatchObject({
      code: "BLOB_RESULT_UNKNOWN",
      result: "unknown",
    });
    client.failHeadAfterCopySuccess = false;
    await expect(store.promote(scope, staged, prepared.ref)).resolves.toMatchObject({
      physicalObjectKey: prepared.authorization.physicalObjectKey,
    });
    expect(client.copyKeys).toHaveLength(1);
    expect(state.successfulCompletionCount).toBe(1);
  });

  it("completed 授权的 HEAD 失败仍保持授权可重试，且不会再次 COPY", async () => {
    const client = new FakeS3ObjectClient();
    const state = new InMemoryPromotionAuthorizations();
    const store = new S3BlobStore(client, state, config);
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "completed-head-fails",
      body: bytes("deliverable"),
      mediaType: "text/plain",
    });
    const prepared = state.preparePromotion(staged);
    await store.promote(scope, staged, prepared.ref);
    client.failNextHeadOnce();

    await expect(store.promote(scope, staged, prepared.ref)).rejects.toMatchObject({
      code: "BLOB_RESULT_UNKNOWN",
      result: "unknown",
    });
    await expect(store.promote(scope, staged, prepared.ref)).resolves.toMatchObject({
      physicalObjectKey: prepared.authorization.physicalObjectKey,
    });
    expect(client.copyKeys).toHaveLength(1);
    expect(state.successfulCompletionCount).toBe(1);
  });

  it("resolve 返回畸形 canonical 时先转 reconcile，再抛稳定完整性错误", async () => {
    const client = new FakeS3ObjectClient();
    const state = new InMemoryPromotionAuthorizations();
    const store = new S3BlobStore(client, state, config);
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "malformed-resolve",
      body: bytes("deliverable"),
      mediaType: "text/plain",
    });
    const prepared = state.preparePromotion(staged);
    state.resolveResultMutation = (authorization) => ({
      ...authorization,
      physicalObjectKey: `${authorization.physicalObjectKey}-bad`,
    });

    await expect(store.promote(scope, staged, prepared.ref)).rejects.toMatchObject({
      code: "BLOB_INTEGRITY_MISMATCH",
      result: "unknown",
    });
    state.resolveResultMutation = undefined;
    await expect(store.promote(scope, staged, prepared.ref)).rejects.toMatchObject({
      code: "BLOB_RESULT_UNKNOWN",
      result: "unknown",
    });
    expect(client.copyKeys).toEqual([]);
    await expect(
      state.claimPromotionExecution({
        scope,
        authorization: prepared.ref,
        attemptId: "50000000-0000-4000-8000-000000000022",
      }),
    ).resolves.toMatchObject({ status: "reconcile", execution: { phase: "unknown" } });
  });

  it("claim/mark 畸形返回与 resolve reject 都在 COPY 前稳定失败并转入安全恢复", async () => {
    const scope = { tenantId: "tenant_a" };

    const claimClient = new FakeS3ObjectClient();
    const claimState = new InMemoryPromotionAuthorizations();
    const claimStore = new S3BlobStore(claimClient, claimState, config);
    const claimStaged = await claimStore.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "malformed-claim",
      body: bytes("claim"),
      mediaType: "text/plain",
    });
    const claimPrepared = claimState.preparePromotion(claimStaged);
    claimState.claimResultMutation = (claim) => ({ ...claim, generation: 0 });
    await expect(claimStore.promote(scope, claimStaged, claimPrepared.ref)).rejects.toMatchObject({
      code: "BLOB_INTEGRITY_MISMATCH",
      result: "unknown",
    });
    expect(claimClient.copyKeys).toEqual([]);

    const markClient = new FakeS3ObjectClient();
    const markState = new InMemoryPromotionAuthorizations();
    const markStore = new S3BlobStore(markClient, markState, config);
    const markStaged = await markStore.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "malformed-mark",
      body: bytes("mark"),
      mediaType: "text/plain",
    });
    const markPrepared = markState.preparePromotion(markStaged);
    markState.markResultMutation = (claim) => ({
      ...claim,
      physicalObjectKey: `${claim.physicalObjectKey}-bad`,
    });
    await expect(markStore.promote(scope, markStaged, markPrepared.ref)).rejects.toMatchObject({
      code: "BLOB_RESULT_UNKNOWN",
      result: "unknown",
    });
    markState.markResultMutation = undefined;
    await expect(markStore.promote(scope, markStaged, markPrepared.ref)).rejects.toMatchObject({
      code: "BLOB_RESULT_UNKNOWN",
      result: "unknown",
    });
    expect(markClient.copyKeys).toEqual([]);

    const resolveClient = new FakeS3ObjectClient();
    const resolveState = new InMemoryPromotionAuthorizations();
    const resolveStore = new S3BlobStore(resolveClient, resolveState, config);
    const resolveStaged = await resolveStore.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "resolve-reject",
      body: bytes("resolve"),
      mediaType: "text/plain",
    });
    const resolvePrepared = resolveState.preparePromotion(resolveStaged);
    resolveState.rejectResolve = true;
    await expect(
      resolveStore.promote(scope, resolveStaged, resolvePrepared.ref),
    ).rejects.toMatchObject({
      code: "BLOB_RESULT_UNKNOWN",
      result: "unknown",
    });
    expect(resolveClient.copyKeys).toEqual([]);
    resolveState.rejectResolve = false;
    await expect(
      resolveState.claimPromotionExecution({
        scope,
        authorization: resolvePrepared.ref,
        attemptId: "50000000-0000-4000-8000-000000000011",
      }),
    ).resolves.toMatchObject({ status: "reconcile", execution: { phase: "unknown" } });
  });

  it("拒绝调用方自造的授权引用，且不会触发 COPY", async () => {
    const client = new FakeS3ObjectClient();
    const scope = { tenantId: "tenant_a" };
    const store = new S3BlobStore(client, promotionAuthorizations, config);
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "untrusted-allocation",
      body: bytes("deliverable"),
      mediaType: "text/plain",
    });
    const selfMade = {
      tenantId: scope.tenantId,
      operationId: "operation-forged",
      authorizationId: "30000000-0000-4000-8000-000000009999",
    };
    await expect(store.promote(scope, staged, selfMade)).rejects.toMatchObject({
      code: "INVALID_BLOB_ARGUMENT",
    });
    await expect(
      store.promote(scope, staged, allocationFor(staged) as unknown as PromotionAuthorizationRef),
    ).rejects.toMatchObject({ code: "INVALID_BLOB_ARGUMENT" });
    expect(client.copyKeys).toEqual([]);
  });

  it.each([
    ["其他 operation", "wrong_operation"],
    ["仅预留但未开始", "not_started"],
    ["已永久 retired", "retired"],
  ] as const)("拒绝%s的授权状态", async (_name, condition) => {
    const client = new FakeS3ObjectClient();
    const scope = { tenantId: "tenant_a" };
    const store = new S3BlobStore(client, promotionAuthorizations, config);
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: `authorization-${condition}`,
      body: bytes("deliverable"),
      mediaType: "text/plain",
    });
    const issued = promotionAuthorizations.preparePromotion(staged, "agent-runtime", {
      status: condition === "not_started" ? "reserved" : "started",
    });
    if (condition === "retired") {
      const claimed = await promotionAuthorizations.claimPromotionExecution({
        scope,
        authorization: issued.ref,
        attemptId: "50000000-0000-4000-8000-000000000001",
      });
      if (claimed.status !== "copy_allowed") throw new Error("retired 测试 claim 失败");
      const marked = await promotionAuthorizations.markPromotionCopyIssued({
        scope,
        execution: claimed.execution,
      });
      if (marked.status !== "marked") throw new Error("retired 测试 intent 失败");
      await promotionAuthorizations.completePromotionExecution({
        scope,
        execution: marked.execution,
        outcome: "succeeded",
      });
      promotionAuthorizations.retire(issued.ref);
    }
    const ref =
      condition === "wrong_operation"
        ? { ...issued.ref, operationId: `${issued.ref.operationId}-other` }
        : issued.ref;
    await expect(store.promote(scope, staged, ref)).rejects.toMatchObject({
      code: "INVALID_BLOB_ARGUMENT",
      message: expect.stringContaining(condition),
    });
    expect(client.copyKeys).toEqual([]);
  });

  it("同一授权不能跨 staging upload 重放", async () => {
    const client = new FakeS3ObjectClient();
    const scope = { tenantId: "tenant_a" };
    const store = new S3BlobStore(client, promotionAuthorizations, config);
    const first = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "authorized-staging",
      body: bytes("same"),
      mediaType: "text/plain",
    });
    const other = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "other-staging",
      body: bytes("same"),
      mediaType: "text/plain",
    });
    const issued = promotionAuthorizations.preparePromotion(first);

    await expect(store.promote(scope, other, issued.ref)).rejects.toMatchObject({
      code: "BLOB_INTEGRITY_MISMATCH",
    });
    expect(client.copyKeys).toEqual([]);
  });

  it("execution claim 后禁止并发撤销或退休，UNKNOWN 只能围绕同一 claim 收敛", async () => {
    const staged = stagedRefForTest("execution-intent", "f".repeat(64));
    const prepared = promotionAuthorizations.preparePromotion(staged);
    const scope = { tenantId: staged.tenantId };
    const claimed = await promotionAuthorizations.claimPromotionExecution({
      scope,
      authorization: prepared.ref,
      attemptId: "50000000-0000-4000-8000-000000000002",
    });
    if (claimed.status !== "copy_allowed") throw new Error("测试 execution claim 失败");

    expect(() => promotionAuthorizations.retire(prepared.ref)).toThrow("禁止 retired");
    expect(() => promotionAuthorizations.setStatus(prepared.ref, "inactive")).toThrow("不能撤销");
    await expect(
      promotionAuthorizations.claimPromotionExecution({
        scope,
        authorization: prepared.ref,
        attemptId: "50000000-0000-4000-8000-000000000003",
      }),
    ).resolves.toEqual({ status: "in_progress" });

    const issued = await promotionAuthorizations.markPromotionCopyIssued({
      scope,
      execution: claimed.execution,
    });
    if (issued.status !== "marked") throw new Error("测试 COPY intent 失败");
    await promotionAuthorizations.completePromotionExecution({
      scope,
      execution: issued.execution,
      outcome: "unknown",
    });
    expect(() => promotionAuthorizations.retire(prepared.ref)).toThrow("禁止 retired");

    const recovery = await promotionAuthorizations.claimPromotionExecution({
      scope,
      authorization: prepared.ref,
      attemptId: "50000000-0000-4000-8000-000000000004",
    });
    if (recovery.status !== "reconcile") throw new Error("测试 UNKNOWN 恢复 claim 失败");
    expect(recovery.execution).toMatchObject({
      executionId: claimed.execution.executionId,
      phase: "unknown",
      physicalObjectKey: prepared.authorization.physicalObjectKey,
    });
    await promotionAuthorizations.completePromotionExecution({
      scope,
      execution: recovery.execution,
      outcome: "succeeded",
    });
    expect(() => promotionAuthorizations.retire(prepared.ref)).not.toThrow();
  });

  it("限制预签名 TTL 和下载文件名", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, promotionAuthorizations, {
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
    const stable = await store.promote(
      scope,
      staged,
      promotionAuthorizations.preparePromotion(staged).ref,
    );

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
    const store = new S3BlobStore(client, promotionAuthorizations, {
      ...config,
      maxBlobSizeBytes: 5,
    });
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
    const headStore = new S3BlobStore(headClient, promotionAuthorizations, {
      ...config,
      maxBlobSizeBytes: 8,
    });
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
    const promoteStore = new S3BlobStore(promoteClient, promotionAuthorizations, {
      ...config,
      maxBlobSizeBytes: 8,
    });
    const promoteStaged = await promoteStore.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "promote-size",
      body: bytes("1234"),
      mediaType: "text/plain",
    });
    promoteClient.headSizeOverride = 9;
    await expect(
      promoteStore.promote(
        scope,
        promoteStaged,
        promotionAuthorizations.preparePromotion(promoteStaged).ref,
      ),
    ).rejects.toMatchObject({
      code: "BLOB_INTEGRITY_MISMATCH",
    });

    const presignClient = new FakeS3ObjectClient();
    const presignStore = new S3BlobStore(presignClient, promotionAuthorizations, {
      ...config,
      maxBlobSizeBytes: 8,
    });
    const presignStaged = await presignStore.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "presign-size",
      body: bytes("1234"),
      mediaType: "text/plain",
    });
    const stable = await presignStore.promote(
      scope,
      presignStaged,
      promotionAuthorizations.preparePromotion(presignStaged).ref,
    );
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
    const store = new S3BlobStore(client, promotionAuthorizations, config);
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
    const headFailureStore = new S3BlobStore(headFailureClient, promotionAuthorizations, config);
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
    const store = new S3BlobStore(client, promotionAuthorizations, {
      ...config,
      prefix: "gc-test",
    });
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "gc-1",
      body: bytes("stable"),
      mediaType: "text/plain",
    });
    const stable = await store.promote(
      scope,
      staged,
      promotionAuthorizations.preparePromotion(staged, "gc-test").ref,
    );
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
    const store = new S3BlobStore(client, promotionAuthorizations, {
      ...config,
      prefix: "gc-unknown",
    });
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "gc-unknown-1",
      body: bytes("stable"),
      mediaType: "text/plain",
    });
    const stable = await store.promote(
      scope,
      staged,
      promotionAuthorizations.preparePromotion(staged, "gc-unknown").ref,
    );
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
    const store = new S3BlobStore(client, promotionAuthorizations, {
      ...config,
      prefix: "gc-known-failure",
    });
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "gc-known-failure-1",
      body: bytes("stable"),
      mediaType: "text/plain",
    });
    const stable = await store.promote(
      scope,
      staged,
      promotionAuthorizations.preparePromotion(staged, "gc-known-failure").ref,
    );
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
      incarnationId: defaultIncarnationId,
      physicalObjectKey: `gc-generation/stable/tenant_a/artifact/sha256/${"a".repeat(64)}/incarnations/${defaultIncarnationId}`,
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
      incarnationId: defaultIncarnationId,
      physicalObjectKey: `gc-cas/stable/tenant_a/artifact/sha256/${"b".repeat(64)}/incarnations/${defaultIncarnationId}`,
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
      incarnationId: defaultIncarnationId,
      physicalObjectKey: `gc-claim-validation/stable/tenant_a/artifact/sha256/${"c".repeat(64)}/incarnations/${defaultIncarnationId}`,
    };
    const validClaim: StableBlobGcClaim = {
      claimId: "claim-valid",
      generation: 1,
      phase: "pre_delete",
      // 是否仍有效由 PG claim 结果决定；executor 只验证规范 UTC ISO 格式，不读取应用进程时钟。
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
      { ...validClaim, tenantId: "../tenant" },
      { ...validClaim, purpose: "unknown" as "artifact" },
      { ...validClaim, sha256: "bad-hash" },
      { ...validClaim, size: -1 },
      { ...validClaim, leaseExpiresAt: "2000-01-01T00:00:00Z" },
      { ...validClaim, leaseExpiresAt: "2000-01-01T08:00:00.000+08:00" },
      { ...validClaim, leaseExpiresAt: "not-a-date" },
      { ...validClaim, physicalObjectKey: "/absolute/key" },
      { ...validClaim, physicalObjectKey: "prefix/stable/../escape" },
      { ...validClaim, physicalObjectKey: "prefix/stable/control\nkey" },
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

  it("beginDeletion 除 phase 外改变任一 claim 字段都在 DELETE 前拒绝", async () => {
    const scope = { tenantId: "tenant_a" };
    const staged: StagedBlobRef = {
      kind: "staging",
      tenantId: scope.tenantId,
      purpose: "artifact",
      uploadId: "begin-continuity",
      sha256: "d".repeat(64),
      size: 1,
      mediaType: "text/plain",
    };
    const allocation = allocationFor(staged, "gc-begin-continuity");
    const stable: StableBlobRef = { kind: "stable", mediaType: staged.mediaType, ...allocation };
    const baseClaim: StableBlobGcClaim = {
      claimId: "claim-continuity",
      generation: 7,
      phase: "pre_delete",
      leaseExpiresAt: "2000-01-01T00:00:00.000Z",
      tenantId: stable.tenantId,
      purpose: stable.purpose,
      sha256: stable.sha256,
      size: stable.size,
      incarnationId: stable.incarnationId,
      physicalObjectKey: stable.physicalObjectKey,
    };

    for (const mutation of [
      { claimId: "changed-claim" },
      { generation: 8 },
      { leaseExpiresAt: "2000-01-01T00:00:01.000Z" },
      { tenantId: "tenant_b" },
      { purpose: "resource" as const },
      { sha256: "e".repeat(64) },
      { size: 2 },
      { incarnationId: "00000000-0000-4000-8000-000000000099" },
      { physicalObjectKey: `${stable.physicalObjectKey}-changed` },
    ]) {
      const client = new FakeS3ObjectClient();
      const port = fixedClaimPort(baseClaim, { ...baseClaim, ...mutation, phase: "deleting" });
      const gc = new S3StableBlobGarbageCollector(
        client,
        port,
        "gc-begin-continuity",
        config.maxBlobSizeBytes,
      );
      await expect(gc.collectIfUnreachable(scope, stable)).rejects.toMatchObject({
        code: "BLOB_INTEGRITY_MISMATCH",
      });
      expect(client.deleteKeys).toEqual([]);
    }
  });

  it("旧 DELETE 在途时 lease 过期，gen2 失败也不能恢复引用，最终由 gen3 收敛", async () => {
    const client = new FakeS3ObjectClient();
    const store = new S3BlobStore(client, promotionAuthorizations, {
      ...config,
      prefix: "gc-delayed-delete",
    });
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "gc-delayed-delete-1",
      body: bytes("stable"),
      mediaType: "text/plain",
    });
    const stable = await store.promote(
      scope,
      staged,
      promotionAuthorizations.preparePromotion(staged, "gc-delayed-delete").ref,
    );
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
    const store = new S3BlobStore(client, promotionAuthorizations, {
      ...config,
      prefix: "gc-incarnation-race",
    });
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "gc-incarnation-race-1",
      body: bytes("stable"),
      mediaType: "text/plain",
    });
    const oldAuthorization = promotionAuthorizations.preparePromotion(
      staged,
      "gc-incarnation-race",
    );
    const oldStable = await store.promote(scope, staged, oldAuthorization.ref);
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
    expect(() => lifecycle.publishNewIncarnation(oldStable)).toThrow("retired incarnation");
    promotionAuthorizations.retire(oldAuthorization.ref);
    await expect(store.promote(scope, staged, oldAuthorization.ref)).rejects.toMatchObject({
      message: expect.stringContaining("retired"),
    });

    const newAuthorization = promotionAuthorizations.preparePromotion(
      staged,
      "gc-incarnation-race",
      {
        allocation: {
          incarnationId: "00000000-0000-4000-8000-000000000002",
          allocationId: "20000000-0000-4000-8000-000000000002",
          generation: 3,
        },
      },
    );
    expect(newAuthorization.allocation.mode).toBe("new_after_deleted");
    const newStable = await store.promote(scope, staged, newAuthorization.ref);
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

  it("已签发的旧 COPY 即使迟到也只命中 retired key，并由 tombstone scrub 收敛", async () => {
    const client = new FakeS3ObjectClient();
    const prefix = "promotion-late-copy";
    const store = new S3BlobStore(client, promotionAuthorizations, { ...config, prefix });
    const scope = { tenantId: "tenant_a" };
    const staged = await store.putStaging({
      scope,
      purpose: "artifact",
      uploadId: "late-copy",
      body: bytes("stable"),
      mediaType: "text/plain",
    });
    const oldAuthorization = promotionAuthorizations.preparePromotion(staged, prefix);
    const oldStable = await store.promote(scope, staged, oldAuthorization.ref);
    const lifecycle = new InMemoryStableLifecycle(scope.tenantId, oldStable, 0);
    const gc = new S3StableBlobGarbageCollector(client, lifecycle, prefix, config.maxBlobSizeBytes);
    await expect(gc.collectIfUnreachable(scope, oldStable)).resolves.toBe("deleted");
    promotionAuthorizations.retire(oldAuthorization.ref);

    const newAuthorization = promotionAuthorizations.preparePromotion(staged, prefix);
    expect(newAuthorization.allocation.mode).toBe("new_after_deleted");
    const newStable = await store.promote(scope, staged, newAuthorization.ref);

    // 模拟已经离开进程、无法撤销的旧网络请求在新 incarnation 发布后才抵达对象存储。
    await client.copy({
      sourceKey: `${prefix}/tenants/${scope.tenantId}/staging/artifact/${staged.uploadId}`,
      destinationKey: oldStable.physicalObjectKey,
    });
    await expect(store.head(scope, oldStable)).resolves.toBeDefined();
    await expect(store.getBytes(scope, newStable)).resolves.toEqual(bytes("stable"));

    const tombstones = new InMemoryRetiredTombstones(oldStable);
    const scrubber = new S3RetiredBlobTombstoneScrubber(
      client,
      tombstones,
      prefix,
      config.maxBlobSizeBytes,
    );
    await expect(scrubber.scrubNext(scope)).resolves.toBe("scrubbed");
    // tombstone 不因完成一轮 scrub 被删除；再次迟到仍由下一轮精确清除。
    await client.copy({
      sourceKey: `${prefix}/tenants/${scope.tenantId}/staging/artifact/${staged.uploadId}`,
      destinationKey: oldStable.physicalObjectKey,
    });
    await expect(scrubber.scrubNext(scope)).resolves.toBe("scrubbed");
    expect(tombstones.completeCount).toBe(2);
    await expect(store.head(scope, oldStable)).resolves.toBeUndefined();
    await expect(store.getBytes(scope, newStable)).resolves.toEqual(bytes("stable"));
  });

  it("RFC 5987 编码覆盖中文与 encodeURIComponent 保留字符", () => {
    expect(encodeRfc5987Value("报告'()*!.txt")).toBe("%E6%8A%A5%E5%91%8A%27%28%29%2A%21.txt");
  });
});

interface StoredObject {
  readonly body: Uint8Array;
  readonly metadata: S3ObjectMetadata;
}

/**
 * 模拟 PostgreSQL 的生命周期事务与 promotion_started 授权行。
 * BlobStore 只能拿 authorizationId 反查规范记录，不能回显调用方拼出的 allocation。
 */
class InMemoryPromotionAuthorizations
  implements StableBlobLifecycleAllocationPort, StableBlobPromotionAuthorizationPort
{
  claimResultMutation: ((claim: PromotionExecutionClaim) => PromotionExecutionClaim) | undefined;
  markResultMutation: ((claim: PromotionExecutionClaim) => PromotionExecutionClaim) | undefined;
  resolveResultMutation:
    | ((authorization: StableBlobPromotionAuthorization) => StableBlobPromotionAuthorization)
    | undefined;
  rejectResolve = false;
  successfulCompletionCount = 0;
  private sequence = 0;
  private readonly records = new Map<
    string,
    {
      status: "reserved" | "started" | "succeeded" | "retired" | "consumed" | "inactive";
      value: StableBlobPromotionAuthorization;
      execution: PromotionExecutionClaim | undefined;
    }
  >();
  private readonly retiredLogicalKeys = new Set<string>();
  private readonly commits = new Map<string, BlobCommitSnapshot>();

  async reserve(input: {
    readonly scope: TenantBlobScope;
    readonly staged: StagedBlobRef;
    readonly operationId: string;
    readonly referenceId: string;
  }): Promise<StableBlobLifecycleAllocation> {
    return this.preparePromotion(input.staged, "agent-runtime", {
      operationId: input.operationId,
      referenceId: input.referenceId,
      status: "reserved",
    }).allocation;
  }

  preparePromotion(
    staged: StagedBlobRef,
    prefix = "agent-runtime",
    options: {
      readonly operationId?: string;
      readonly referenceId?: string;
      readonly status?: "reserved" | "started";
      readonly allocation?: Partial<
        Pick<
          StableBlobLifecycleAllocation,
          "incarnationId" | "lifecycleId" | "allocationId" | "generation"
        >
      >;
    } = {},
  ): {
    readonly ref: PromotionAuthorizationRef;
    readonly authorization: StableBlobPromotionAuthorization;
    readonly allocation: StableBlobLifecycleAllocation;
  } {
    this.sequence += 1;
    const suffix = this.sequence.toString().padStart(12, "0");
    const logicalKey = `${staged.tenantId}/${staged.purpose}/${staged.sha256}/${staged.size}`;
    const mode = this.retiredLogicalKeys.has(logicalKey) ? "new_after_deleted" : "active_reuse";
    const allocation = allocationFor(staged, prefix, {
      incarnationId: options.allocation?.incarnationId ?? `00000000-0000-4000-8000-${suffix}`,
      lifecycleId: options.allocation?.lifecycleId ?? `10000000-0000-4000-8000-${suffix}`,
      allocationId: options.allocation?.allocationId ?? `20000000-0000-4000-8000-${suffix}`,
      generation: options.allocation?.generation ?? this.sequence,
      mode,
    });
    const operationId = options.operationId ?? `operation-${this.sequence}`;
    const referenceId = options.referenceId ?? `reference-${this.sequence}`;
    const referenceCommitted: BlobCommitSnapshot = {
      operationId,
      scope: { tenantId: staged.tenantId },
      status: "reference_committed",
      version: 3,
      staged,
      referenceId,
    };
    const stable: StableBlobRef = {
      kind: "stable",
      tenantId: staged.tenantId,
      purpose: staged.purpose,
      sha256: staged.sha256,
      size: staged.size,
      mediaType: staged.mediaType,
      incarnationId: allocation.incarnationId,
      physicalObjectKey: allocation.physicalObjectKey,
    };
    const reserved = transitionBlobCommit(referenceCommitted, {
      type: "allocation_reserved",
      allocation,
      stable,
    });
    this.commits.set(`${staged.tenantId}/${operationId}`, reserved);
    if ((options.status ?? "started") === "started") {
      return this.startPromotionTransaction(
        {
          scope: { tenantId: staged.tenantId },
          operationId,
          expectedSnapshotVersion: reserved.version,
          allocationId: allocation.allocationId,
        },
        prefix,
      );
    }
    // 仅用于验证 reserved 尚不能执行；生产 startPromotion 不会在事务前返回 AuthorizationRef。
    const authorizationId = `30000000-0000-4000-8000-${suffix}`;
    const authorization: StableBlobPromotionAuthorization = {
      ...allocation,
      authorizationId,
      operationId,
      referenceId,
      stagingUploadId: staged.uploadId,
      stagingObjectKey: `${prefix}/tenants/${staged.tenantId}/staging/${staged.purpose}/${staged.uploadId}`,
    };
    this.records.set(authorizationId, {
      status: "reserved",
      value: authorization,
      execution: undefined,
    });
    return {
      ref: { tenantId: staged.tenantId, operationId, authorizationId },
      authorization,
      allocation,
    };
  }

  private startPromotionTransaction(
    input: {
      readonly scope: TenantBlobScope;
      readonly operationId: string;
      readonly expectedSnapshotVersion: number;
      readonly allocationId: string;
    },
    prefix: string,
  ): {
    readonly ref: PromotionAuthorizationRef;
    readonly authorization: StableBlobPromotionAuthorization;
    readonly allocation: StableBlobLifecycleAllocation;
  } {
    // 模拟 Repository：只读取最小命令，canonical 字段全部取自同一事务内的 snapshot/allocation。
    const scope = { tenantId: input.scope.tenantId };
    const operationId = input.operationId;
    const expectedVersion = input.expectedSnapshotVersion;
    const allocationId = input.allocationId;
    const current = this.commits.get(`${scope.tenantId}/${operationId}`);
    if (
      current?.status !== "allocation_reserved" ||
      current.version !== expectedVersion ||
      current.allocation?.allocationId !== allocationId ||
      current.staged === undefined ||
      current.referenceId === undefined
    ) {
      throw new Error("startPromotion 最小命令与数据库状态不一致");
    }
    const allocation = current.allocation;
    const authorizationId = `30000000-0000-4000-8000-${this.sequence.toString().padStart(12, "0")}`;
    const authorization: StableBlobPromotionAuthorization = {
      ...allocation,
      authorizationId,
      operationId,
      referenceId: current.referenceId,
      stagingUploadId: current.staged.uploadId,
      stagingObjectKey: `${prefix}/tenants/${scope.tenantId}/staging/${current.staged.purpose}/${current.staged.uploadId}`,
    };
    const ref = { tenantId: scope.tenantId, operationId, authorizationId };
    const next = transitionBlobCommit(current, { type: "promotion_started", authorization: ref });
    this.commits.set(`${scope.tenantId}/${operationId}`, next);
    this.records.set(authorizationId, {
      status: "started",
      value: authorization,
      execution: undefined,
    });
    return { ref, authorization, allocation };
  }

  retire(ref: PromotionAuthorizationRef): void {
    const record = this.records.get(ref.authorizationId);
    if (record === undefined) {
      throw new Error("测试授权不存在");
    }
    if (record.status === "started") {
      throw new Error("started/executing/unknown promotion 未收敛前禁止 retired");
    }
    record.status = "retired";
    const value = record.value;
    this.retiredLogicalKeys.add(`${value.tenantId}/${value.purpose}/${value.sha256}/${value.size}`);
  }

  setStatus(
    ref: PromotionAuthorizationRef,
    status: "reserved" | "started" | "retired" | "consumed" | "inactive",
  ): void {
    const record = this.records.get(ref.authorizationId);
    if (record === undefined) {
      throw new Error("测试授权不存在");
    }
    if (record.status === "started" && status !== "started") {
      throw new Error("在途 promotion 授权不能撤销或退休");
    }
    record.status = status;
  }

  async claimPromotionExecution(input: {
    readonly scope: TenantBlobScope;
    readonly authorization: PromotionAuthorizationRef;
    readonly attemptId: string;
  }): Promise<PromotionExecutionClaimResolution> {
    const completed = this.records.get(input.authorization.authorizationId);
    if (
      completed?.status === "succeeded" &&
      completed.value.tenantId === input.scope.tenantId &&
      completed.value.tenantId === input.authorization.tenantId &&
      completed.value.operationId === input.authorization.operationId
    ) {
      return { status: "completed", authorization: completed.value };
    }
    const resolved = this.resolveRecord(input.scope, input.authorization);
    if (resolved.status !== "authorized") {
      return resolved;
    }
    const record = resolved.record;
    if (record.execution !== undefined) {
      return record.execution.phase === "claimed"
        ? { status: "in_progress" }
        : { status: "reconcile", execution: record.execution };
    }
    const execution: PromotionExecutionClaim = {
      tenantId: record.value.tenantId,
      operationId: record.value.operationId,
      authorizationId: record.value.authorizationId,
      executionId: `40000000-0000-4000-8000-${this.sequence.toString().padStart(12, "0")}`,
      attemptId: input.attemptId,
      generation: 1,
      phase: "claimed",
      incarnationId: record.value.incarnationId,
      physicalObjectKey: record.value.physicalObjectKey,
    };
    record.execution = execution;
    return {
      status: "copy_allowed",
      execution: this.claimResultMutation?.(execution) ?? execution,
    };
  }

  async resolveAuthorizedForCopy(input: {
    readonly scope: TenantBlobScope;
    readonly execution: PromotionExecutionClaim;
  }): Promise<PromotionAuthorizationResolution> {
    if (this.rejectResolve) {
      throw new Error("fake resolve rejected");
    }
    const ref = {
      tenantId: input.execution.tenantId,
      operationId: input.execution.operationId,
      authorizationId: input.execution.authorizationId,
    };
    const resolved = this.resolveRecord(input.scope, ref);
    if (resolved.status !== "authorized") {
      return resolved;
    }
    if (!sameExecution(resolved.record.execution, input.execution)) {
      return { status: "inactive" };
    }
    return {
      status: "authorized",
      authorization: this.resolveResultMutation?.(resolved.record.value) ?? resolved.record.value,
    };
  }

  async markPromotionCopyIssued(input: {
    readonly scope: TenantBlobScope;
    readonly execution: PromotionExecutionClaim;
  }) {
    const record = this.records.get(input.execution.authorizationId);
    if (
      record === undefined ||
      input.scope.tenantId !== record.value.tenantId ||
      !sameExecutionIdentity(record.execution, input.execution)
    ) {
      return { status: "claim_lost" as const };
    }
    if (record.execution?.phase === "claimed") {
      record.execution = { ...record.execution, phase: "executing" };
    }
    const execution = record.execution as PromotionExecutionClaim;
    return {
      status: "marked" as const,
      execution: this.markResultMutation?.(execution) ?? execution,
    };
  }

  async completePromotionExecution(input: {
    readonly scope: TenantBlobScope;
    readonly execution: PromotionExecutionClaim;
    readonly outcome: "succeeded" | "not_copied" | "unknown" | "reconcile";
  }): Promise<void> {
    const record = this.records.get(input.execution.authorizationId);
    if (record?.status === "succeeded" && input.outcome === "succeeded") {
      return;
    }
    if (
      record === undefined ||
      input.scope.tenantId !== record.value.tenantId ||
      !sameExecutionIdentity(record.execution, input.execution)
    ) {
      throw new Error("promotion execution CAS 已失效");
    }
    if (input.outcome === "not_copied") {
      if (record.execution?.phase !== "claimed") {
        throw new Error("已发出 COPY 的 intent 不能撤销为 not_copied");
      }
      record.status = "inactive";
      record.execution = undefined;
      return;
    }
    if (input.outcome === "unknown") {
      if (record.execution?.phase !== "executing" && record.execution?.phase !== "unknown") {
        throw new Error("未发出 COPY 不能记为 unknown");
      }
      record.execution = { ...record.execution, phase: "unknown" };
      return;
    }
    if (input.outcome === "reconcile") {
      record.execution = { ...input.execution, phase: "unknown" };
      return;
    }
    record.status = "succeeded";
    record.execution = undefined;
    this.successfulCompletionCount += 1;
  }

  private resolveRecord(
    scope: TenantBlobScope,
    authorization: PromotionAuthorizationRef,
  ):
    | {
        readonly status: "authorized";
        readonly record: {
          status: "reserved" | "started" | "succeeded" | "retired" | "consumed" | "inactive";
          value: StableBlobPromotionAuthorization;
          execution: PromotionExecutionClaim | undefined;
        };
      }
    | Exclude<PromotionAuthorizationResolution, { readonly status: "authorized" }> {
    const record = this.records.get(authorization.authorizationId);
    if (record === undefined) return { status: "not_found" };
    if (
      record.value.operationId !== authorization.operationId ||
      record.value.tenantId !== scope.tenantId ||
      record.value.tenantId !== authorization.tenantId
    ) {
      return { status: "wrong_operation" };
    }
    if (record.status === "reserved") return { status: "not_started" };
    if (record.status === "succeeded") return { status: "consumed" };
    if (record.status !== "started") return { status: record.status };
    return { status: "authorized", record };
  }
}

function sameExecution(
  current: PromotionExecutionClaim | undefined,
  supplied: PromotionExecutionClaim,
): boolean {
  return (
    current !== undefined &&
    current.tenantId === supplied.tenantId &&
    current.operationId === supplied.operationId &&
    current.authorizationId === supplied.authorizationId &&
    current.executionId === supplied.executionId &&
    current.generation === supplied.generation &&
    current.attemptId === supplied.attemptId &&
    current.phase === supplied.phase &&
    current.incarnationId === supplied.incarnationId &&
    current.physicalObjectKey === supplied.physicalObjectKey
  );
}

function sameExecutionIdentity(
  current: PromotionExecutionClaim | undefined,
  supplied: PromotionExecutionClaim,
): boolean {
  return (
    current !== undefined &&
    current.tenantId === supplied.tenantId &&
    current.operationId === supplied.operationId &&
    current.authorizationId === supplied.authorizationId &&
    current.executionId === supplied.executionId &&
    current.generation === supplied.generation &&
    current.attemptId === supplied.attemptId &&
    current.incarnationId === supplied.incarnationId &&
    current.physicalObjectKey === supplied.physicalObjectKey
  );
}

const promotionAuthorizations = new InMemoryPromotionAuthorizations();

class FakeS3ObjectClient implements S3ObjectClient {
  readonly objects = new Map<string, StoredObject>();
  readonly putKeys: string[] = [];
  readonly copyKeys: S3CopyObjectInput[] = [];
  readonly presignInputs: S3PresignInput[] = [];
  readonly deleteHooks: Array<() => Promise<void>> = [];
  readonly deleteKeys: string[] = [];
  putUnknownAfterWrite = false;
  putUnknownWithoutWrite = false;
  copyUnknownAfterWrite = false;
  copyUnknownWithoutWrite = false;
  deleteSourceBeforeCopy = false;
  failHeadAfterCopySuccess = false;
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

  failNextHeadOnce(): void {
    this.failNextHead = true;
  }

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
    if (this.deleteSourceBeforeCopy) {
      this.objects.delete(input.sourceKey);
    }
    const source = this.objects.get(input.sourceKey);
    if (source === undefined) {
      throw new BlobStoreError("BLOB_NOT_FOUND", "fake source missing");
    }
    if (!this.copyUnknownWithoutWrite) {
      this.objects.set(input.destinationKey, {
        body: source.body.slice(),
        metadata: { ...source.metadata },
      });
      this.failNextHead = this.failHeadAfterCopySuccess;
    }
    if (this.copyUnknownAfterWrite || this.copyUnknownWithoutWrite) {
      throw unknownResult();
    }
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

class InMemoryRetiredTombstones implements StableBlobRetiredTombstonePort {
  completeCount = 0;

  constructor(private readonly blob: StableBlobRef) {}

  async claimForScrub(input: { readonly scope: TenantBlobScope }) {
    if (input.scope.tenantId !== this.blob.tenantId) {
      throw new Error("tombstone Tenant 不匹配");
    }
    return {
      status: "claimed" as const,
      tombstone: {
        tombstoneId: `tombstone-${this.blob.incarnationId}`,
        generation: this.completeCount + 1,
        tenantId: this.blob.tenantId,
        purpose: this.blob.purpose,
        sha256: this.blob.sha256,
        size: this.blob.size,
        incarnationId: this.blob.incarnationId,
        physicalObjectKey: this.blob.physicalObjectKey,
      },
    };
  }

  async completeScrub(): Promise<void> {
    // 永久 tombstone 只更新 scrub 进度，不从 Fake 中移除。
    this.completeCount += 1;
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
  private readonly retiredIncarnations = new Set<string>();
  private readonly retiredPhysicalKeys = new Set<string>();

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
      this.retiredIncarnations.has(blob.incarnationId) ||
      this.retiredPhysicalKeys.has(blob.physicalObjectKey)
    ) {
      throw new Error("retired incarnation 永久禁止复用");
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
    this.retiredIncarnations.add(this.blob.incarnationId);
    this.retiredPhysicalKeys.add(this.blob.physicalObjectKey);
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
    return this.state === "deleted"
      ? {
          status: "deleted" as const,
          retiredIncarnationId: this.blob.incarnationId,
          retiredPhysicalObjectKey: this.blob.physicalObjectKey,
        }
      : { status: this.state };
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

function stagedRefForTest(uploadId: string, sha256: string): StagedBlobRef {
  return {
    kind: "staging",
    tenantId: "tenant_a",
    purpose: "artifact",
    uploadId,
    sha256,
    size: 1,
    mediaType: "text/plain",
  };
}

function allocationFor(
  staged: StagedBlobRef,
  prefix = "agent-runtime",
  overrides: Partial<
    Pick<
      StableBlobLifecycleAllocation,
      "incarnationId" | "lifecycleId" | "allocationId" | "generation" | "mode"
    >
  > = {},
): StableBlobLifecycleAllocation {
  const incarnationId = overrides.incarnationId ?? defaultIncarnationId;
  return {
    tenantId: staged.tenantId,
    purpose: staged.purpose,
    sha256: staged.sha256,
    size: staged.size,
    incarnationId,
    physicalObjectKey: `${prefix}/stable/${staged.tenantId}/${staged.purpose}/sha256/${staged.sha256}/incarnations/${incarnationId}`,
    lifecycleId: overrides.lifecycleId ?? defaultLifecycleId,
    allocationId: overrides.allocationId ?? defaultAllocationId,
    generation: overrides.generation ?? 1,
    mode: overrides.mode ?? "active_reuse",
  };
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

function fixedClaimPort(
  claim: StableBlobGcClaim,
  deletingClaim: StableBlobGcClaim = { ...claim, phase: "deleting" },
): StableBlobGcClaimPort {
  return {
    async claimUnreachable() {
      return { status: "claimed", claim };
    },
    async beginDeletion() {
      return { status: "started", claim: deletingClaim };
    },
    async completeDeletion() {},
    async releasePreDeleteClaim() {},
    async resolveLifecycle() {
      return { status: "pre_delete" };
    },
  };
}

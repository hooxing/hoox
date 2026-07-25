import { randomUUID } from "node:crypto";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  createS3BlobStore,
  createS3StableBlobGarbageCollector,
  sha256Hex,
  transitionBlobCommit,
  type BlobCommitSnapshot,
  type BlobCommitStatePort,
  type PromotionAuthorizationRef,
  type PromotionExecutionClaim,
  type StableBlobLifecycleAllocation,
  type StableBlobLifecycleAllocationPort,
  type StableBlobPromotionAuthorization,
  type StableBlobPromotionAuthorizationPort,
  type StableBlobRef,
  type StagedBlobRef,
} from "./index.js";

const integration = process.env.RUN_MINIO_INTEGRATION === "true" ? describe : describe.skip;

integration("MinIO Blob Store 集成", () => {
  it("完成私有对象 staging、提升、读取、预签名与无残留清理", async () => {
    const config = requiredConfig();
    const unique = randomUUID();
    const prefix = `integration-test/${unique}`;
    const scope = { tenantId: `integration_${unique.replaceAll("-", "_")}` };
    const body = new TextEncoder().encode(`minio-${unique}`);
    const descriptor = {
      sha256: sha256Hex(body),
      size: body.byteLength,
      mediaType: "text/plain",
    };
    // 引用在上传前即可确定，因此即使 PUT 响应未知，finally 仍有能力按精确引用和唯一前缀清理。
    const staged: StagedBlobRef = {
      kind: "staging",
      tenantId: scope.tenantId,
      purpose: "artifact",
      uploadId: `upload-${unique}`,
      ...descriptor,
    };
    const operationId = `operation-${unique}`;
    const referenceId = `reference-${unique}`;
    const persistence = new IntegrationPersistenceFake(prefix);
    const referenceCommitted: BlobCommitSnapshot = {
      operationId,
      scope,
      status: "reference_committed",
      version: 3,
      staged,
      referenceId,
    };
    await persistence.create(referenceCommitted);
    const allocation = await persistence.reserve({ scope, staged, operationId, referenceId });
    const stable: StableBlobRef = {
      kind: "stable",
      tenantId: allocation.tenantId,
      purpose: allocation.purpose,
      sha256: allocation.sha256,
      size: allocation.size,
      mediaType: staged.mediaType,
      incarnationId: allocation.incarnationId,
      physicalObjectKey: allocation.physicalObjectKey,
    };
    const allocationReserved = transitionBlobCommit(referenceCommitted, {
      type: "allocation_reserved",
      allocation,
      stable,
    });
    expect(
      await persistence.compareAndSet({
        scope,
        operationId,
        expectedVersion: referenceCommitted.version,
        next: allocationReserved,
      }),
    ).toBe(true);
    const started = await persistence.startPromotion({
      scope,
      operationId,
      expectedSnapshotVersion: allocationReserved.version,
      allocationId: allocation.allocationId,
    });
    if (started.status !== "started") throw new Error("MinIO startPromotion 事务失败");
    const authorizationRef = started.authorization;
    const common = {
      bucket: config.bucket,
      endpoint: config.endpoint,
      publicEndpoint: config.publicEndpoint,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      forcePathStyle: true,
      prefix,
      maxPresignTtlSeconds: 60,
      maxBlobSizeBytes: 1_024 * 1_024,
    } as const;
    const store = createS3BlobStore(common, persistence);
    const gc = createS3StableBlobGarbageCollector(common, {
      async claimUnreachable({ scope: claimScope, blob }) {
        return {
          status: "claimed",
          claim: {
            claimId: `integration-claim-${unique}`,
            generation: 1,
            phase: "pre_delete",
            tenantId: claimScope.tenantId,
            purpose: blob.purpose,
            sha256: blob.sha256,
            size: blob.size,
            incarnationId: blob.incarnationId,
            physicalObjectKey: blob.physicalObjectKey,
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        };
      },
      async beginDeletion({ claim }) {
        return { status: "started", claim: { ...claim, phase: "deleting" } };
      },
      async completeDeletion() {},
      async releasePreDeleteClaim() {},
      async resolveLifecycle() {
        return { status: "active" };
      },
    });
    const cleanupClient = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });

    try {
      expect(
        await store.putStaging({
          scope,
          purpose: staged.purpose,
          uploadId: staged.uploadId,
          body,
          mediaType: staged.mediaType,
        }),
      ).toEqual(staged);
      expect((await store.head(scope, staged))?.blob).toEqual(staged);
      expect(await store.getBytes(scope, staged)).toEqual(body);

      expect(await store.promote(scope, staged, authorizationRef)).toEqual(stable);
      expect(await store.getBytes(scope, stable)).toEqual(body);
      const downloadUrl = await store.presignDownload({
        scope,
        blob: { ...stable, mediaType: "application/pdf" },
        ttlSeconds: 30,
        responseMediaType: "application/pdf",
        downloadName: "集成'()*.txt",
      });
      const response = await fetch(downloadUrl);
      expect(response.ok).toBe(true);
      expect(response.headers.get("content-type")).toBe("application/pdf");
      expect(response.headers.get("content-disposition")).toBe(
        "attachment; filename*=UTF-8''%E9%9B%86%E6%88%90%27%28%29%2A.txt",
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);

      const previewUrl = await store.presignDownload({
        scope,
        blob: { ...stable, mediaType: "text/markdown" },
        ttlSeconds: 30,
        responseMediaType: "text/markdown",
        delivery: "inline-preview",
      });
      const previewResponse = await fetch(previewUrl);
      expect(previewResponse.ok).toBe(true);
      expect(previewResponse.headers.get("content-type")).toBe("text/markdown");
      expect(previewResponse.headers.get("content-disposition")).toBe("inline");
      expect(new Uint8Array(await previewResponse.arrayBuffer())).toEqual(body);
    } finally {
      // 两条清理互不依赖；即使其中一个结果未知，另一条仍会执行。
      const cleanupResults = await Promise.allSettled([
        store.deleteStaging(scope, staged),
        gc.collectIfUnreachable(scope, stable),
      ]);

      // 唯一前缀是集成测试专属兜底，不属于生产 GC API。它处理未知写/删结果留下的对象。
      const leakedKeys = await listKeys(cleanupClient, config.bucket, prefix);
      if (leakedKeys.length > 0) {
        await cleanupClient.send(
          new DeleteObjectsCommand({
            Bucket: config.bucket,
            Delete: { Objects: leakedKeys.map((key) => ({ Key: key })), Quiet: true },
          }),
        );
      }

      expect(await listKeys(cleanupClient, config.bucket, prefix)).toEqual([]);
      expect(await store.head(scope, staged)).toBeUndefined();
      expect(await store.head(scope, stable)).toBeUndefined();
      expect(cleanupResults.every((result) => result.status === "fulfilled")).toBe(true);
      cleanupClient.destroy();
    }
  });

  it("持久层 Fake 只消费显式 pre-intent/not-copied 证明并保留审计 tombstone", async () => {
    const absent = await createStartedIntegrationPersistenceFake("proof-absent");
    await expect(
      absent.persistence.provePromotionNotCopied({
        scope: absent.scope,
        operationId: absent.operationId,
        expectedSnapshotVersion: absent.snapshotVersion,
        authorizationId: absent.authorization.authorizationId,
      }),
    ).resolves.toEqual({ status: "proof_unavailable" });

    const preIntent = await createStartedIntegrationPersistenceFake("proof-pre-intent");
    const preIntentClaim = await preIntent.persistence.claimPromotionExecution({
      scope: preIntent.scope,
      authorization: preIntent.authorization,
      attemptId: randomUUID(),
    });
    if (preIntentClaim.status !== "copy_allowed") throw new Error("pre-intent claim 失败");
    await expect(
      preIntent.persistence.provePromotionNotCopied({
        scope: preIntent.scope,
        operationId: preIntent.operationId,
        expectedSnapshotVersion: preIntent.snapshotVersion,
        authorizationId: preIntent.authorization.authorizationId,
      }),
    ).resolves.toMatchObject({ status: "proven_not_copied" });
    expect(preIntent.persistence.proofStatusForTest()).toBe("consumed_not_copied");

    const notCopied = await createStartedIntegrationPersistenceFake("proof-not-copied");
    const notCopiedClaim = await notCopied.persistence.claimPromotionExecution({
      scope: notCopied.scope,
      authorization: notCopied.authorization,
      attemptId: randomUUID(),
    });
    if (notCopiedClaim.status !== "copy_allowed") throw new Error("not-copied claim 失败");
    await notCopied.persistence.completePromotionExecution({
      scope: notCopied.scope,
      execution: notCopiedClaim.execution,
      outcome: "not_copied",
    });
    await expect(
      notCopied.persistence.provePromotionNotCopied({
        scope: notCopied.scope,
        operationId: notCopied.operationId,
        expectedSnapshotVersion: notCopied.snapshotVersion,
        authorizationId: notCopied.authorization.authorizationId,
      }),
    ).resolves.toMatchObject({ status: "proven_not_copied" });
    expect(notCopied.persistence.proofStatusForTest()).toBe("consumed_not_copied");

    const copyIssued = await createStartedIntegrationPersistenceFake("proof-copy-issued");
    const copyIssuedClaim = await copyIssued.persistence.claimPromotionExecution({
      scope: copyIssued.scope,
      authorization: copyIssued.authorization,
      attemptId: randomUUID(),
    });
    if (copyIssuedClaim.status !== "copy_allowed") throw new Error("copy-issued claim 失败");
    await copyIssued.persistence.markPromotionCopyIssued({
      scope: copyIssued.scope,
      execution: copyIssuedClaim.execution,
    });
    await expect(
      copyIssued.persistence.provePromotionNotCopied({
        scope: copyIssued.scope,
        operationId: copyIssued.operationId,
        expectedSnapshotVersion: copyIssued.snapshotVersion,
        authorizationId: copyIssued.authorization.authorizationId,
      }),
    ).resolves.toEqual({ status: "copy_may_have_been_issued" });

    const markUnknown = await createStartedIntegrationPersistenceFake("proof-mark-unknown");
    const markUnknownClaim = await markUnknown.persistence.claimPromotionExecution({
      scope: markUnknown.scope,
      authorization: markUnknown.authorization,
      attemptId: randomUUID(),
    });
    if (markUnknownClaim.status !== "copy_allowed") throw new Error("mark-unknown claim 失败");
    markUnknown.persistence.markResponseUnknownForTest = true;
    await expect(
      markUnknown.persistence.markPromotionCopyIssued({
        scope: markUnknown.scope,
        execution: markUnknownClaim.execution,
      }),
    ).rejects.toThrow("响应未知");
    await expect(
      markUnknown.persistence.provePromotionNotCopied({
        scope: markUnknown.scope,
        operationId: markUnknown.operationId,
        expectedSnapshotVersion: markUnknown.snapshotVersion,
        authorizationId: markUnknown.authorization.authorizationId,
      }),
    ).resolves.toEqual({ status: "copy_may_have_been_issued" });
  });
});

async function createStartedIntegrationPersistenceFake(label: string) {
  const tenantId = `integration_${label.replaceAll("-", "_")}`;
  const scope = { tenantId };
  const operationId = `operation-${label}`;
  const referenceId = `reference-${label}`;
  const prefix = `integration-proof/${label}`;
  const staged: StagedBlobRef = {
    kind: "staging",
    tenantId,
    purpose: "artifact",
    uploadId: `upload-${label}`,
    sha256: "a".repeat(64),
    size: 1,
    mediaType: "text/plain",
  };
  const persistence = new IntegrationPersistenceFake(prefix);
  const referenceCommitted: BlobCommitSnapshot = {
    operationId,
    scope,
    status: "reference_committed",
    version: 3,
    staged,
    referenceId,
  };
  await persistence.create(referenceCommitted);
  const allocation = await persistence.reserve({ scope, staged, operationId, referenceId });
  const stable: StableBlobRef = {
    kind: "stable",
    tenantId,
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
  if (
    !(await persistence.compareAndSet({
      scope,
      operationId,
      expectedVersion: referenceCommitted.version,
      next: reserved,
    }))
  ) {
    throw new Error("proof Fake allocation CAS 失败");
  }
  const started = await persistence.startPromotion({
    scope,
    operationId,
    expectedSnapshotVersion: reserved.version,
    allocationId: allocation.allocationId,
  });
  if (started.status !== "started") throw new Error("proof Fake startPromotion 失败");
  return {
    persistence,
    scope,
    operationId,
    authorization: started.authorization,
    snapshotVersion: started.snapshotVersion,
  };
}

/** 真实 MinIO 走 reference→reserve→最小 startPromotion→execution claim 的状态化数据库 Fake。 */
class IntegrationPersistenceFake
  implements
    BlobCommitStatePort,
    StableBlobLifecycleAllocationPort,
    StableBlobPromotionAuthorizationPort
{
  private execution: PromotionExecutionClaim | undefined;
  private authorization: StableBlobPromotionAuthorization | undefined;
  private snapshot: BlobCommitSnapshot | undefined;
  private allocation: StableBlobLifecycleAllocation | undefined;
  private promotionProof:
    | "pre_intent"
    | "not_copied"
    | "copy_issued"
    | "mark_unknown"
    | "consumed_not_copied"
    | undefined;
  private status: "reserved" | "started" | "retired" | "consumed" | "inactive" = "started";
  markResponseUnknownForTest = false;

  constructor(private readonly prefix: string) {}

  proofStatusForTest() {
    return this.promotionProof;
  }

  async load(scope: { readonly tenantId: string }, operationId: string) {
    return this.snapshot?.scope.tenantId === scope.tenantId &&
      this.snapshot.operationId === operationId
      ? this.snapshot
      : undefined;
  }

  async create(snapshot: BlobCommitSnapshot): Promise<void> {
    if (this.snapshot !== undefined) throw new Error("MinIO Fake snapshot 已存在");
    this.snapshot = snapshot;
  }

  async compareAndSet(input: {
    readonly scope: { readonly tenantId: string };
    readonly operationId: string;
    readonly expectedVersion: number;
    readonly next: BlobCommitSnapshot;
  }): Promise<boolean> {
    if (
      this.snapshot === undefined ||
      this.snapshot.scope.tenantId !== input.scope.tenantId ||
      this.snapshot.operationId !== input.operationId ||
      this.snapshot.version !== input.expectedVersion ||
      input.next.status === "promotion_started"
    ) {
      return false;
    }
    this.snapshot = input.next;
    return true;
  }

  async reserve(input: {
    readonly scope: { readonly tenantId: string };
    readonly staged: StagedBlobRef;
    readonly operationId: string;
    readonly referenceId: string;
  }): Promise<StableBlobLifecycleAllocation> {
    if (
      this.snapshot?.operationId !== input.operationId ||
      this.snapshot.scope.tenantId !== input.scope.tenantId ||
      this.snapshot.referenceId !== input.referenceId
    ) {
      throw new Error("MinIO reserve 与 reference 状态不一致");
    }
    const incarnationId = randomUUID();
    this.allocation = {
      tenantId: input.scope.tenantId,
      purpose: input.staged.purpose,
      sha256: input.staged.sha256,
      size: input.staged.size,
      incarnationId,
      physicalObjectKey: `${this.prefix}/stable/${input.scope.tenantId}/${input.staged.purpose}/sha256/${input.staged.sha256}/incarnations/${incarnationId}`,
      lifecycleId: randomUUID(),
      allocationId: randomUUID(),
      generation: 1,
      // Fake 由自身生命周期状态决定，调用方没有 mode 参数。
      mode: "active_reuse",
    };
    return this.allocation;
  }

  async startPromotion(input: {
    readonly scope: { readonly tenantId: string };
    readonly operationId: string;
    readonly expectedSnapshotVersion: number;
    readonly allocationId: string;
  }) {
    const scope = { tenantId: input.scope.tenantId };
    const operationId = input.operationId;
    const expectedVersion = input.expectedSnapshotVersion;
    const allocationId = input.allocationId;
    const current = this.snapshot;
    const allocation = this.allocation;
    if (current === undefined || current.version !== expectedVersion) {
      return { status: "version_conflict" as const };
    }
    if (current.status !== "allocation_reserved") return { status: "invalid_state" as const };
    if (
      allocation === undefined ||
      allocation.allocationId !== allocationId ||
      current.staged === undefined ||
      current.referenceId === undefined ||
      current.scope.tenantId !== scope.tenantId ||
      current.operationId !== operationId
    ) {
      return { status: "allocation_unavailable" as const };
    }
    const authorizationId = randomUUID();
    this.authorization = {
      ...allocation,
      authorizationId,
      operationId,
      referenceId: current.referenceId,
      stagingUploadId: current.staged.uploadId,
      stagingObjectKey: `${this.prefix}/tenants/${scope.tenantId}/staging/${current.staged.purpose}/${current.staged.uploadId}`,
    };
    const ref = { tenantId: scope.tenantId, operationId, authorizationId };
    this.snapshot = transitionBlobCommit(current, {
      type: "promotion_started",
      authorization: ref,
    });
    this.status = "started";
    this.promotionProof = undefined;
    return {
      status: "started" as const,
      authorization: ref,
      snapshotVersion: this.snapshot.version,
    };
  }

  async provePromotionNotCopied(input: {
    readonly scope: { readonly tenantId: string };
    readonly operationId: string;
    readonly expectedSnapshotVersion: number;
    readonly authorizationId: string;
  }) {
    const current = this.snapshot;
    if (current === undefined || current.version !== input.expectedSnapshotVersion) {
      return { status: "version_conflict" as const };
    }
    if (current.status !== "promotion_started") return { status: "invalid_state" as const };
    if (
      current.scope.tenantId !== input.scope.tenantId ||
      current.operationId !== input.operationId ||
      current.promotionAuthorization?.authorizationId !== input.authorizationId
    ) {
      return { status: "authorization_mismatch" as const };
    }
    if (this.promotionProof === undefined) {
      return { status: "proof_unavailable" as const };
    }
    if (
      this.promotionProof === "copy_issued" ||
      this.promotionProof === "mark_unknown" ||
      this.promotionProof === "consumed_not_copied"
    ) {
      return { status: "copy_may_have_been_issued" as const };
    }
    this.snapshot = transitionBlobCommit(current, { type: "promotion_proven_not_copied" });
    this.status = "inactive";
    // 消费后保留 execution、authorization 与永久 proof tombstone 作为审计证据。
    this.promotionProof = "consumed_not_copied";
    return {
      status: "proven_not_copied" as const,
      snapshotVersion: this.snapshot.version,
    };
  }

  async claimPromotionExecution(input: {
    readonly scope: { readonly tenantId: string };
    readonly authorization: PromotionAuthorizationRef;
    readonly attemptId: string;
  }) {
    if (!this.matchesAuthorization(input.scope, input.authorization)) {
      return { status: "wrong_operation" as const };
    }
    if (this.status === "reserved") return { status: "not_started" as const };
    if (this.status === "consumed") {
      return { status: "completed" as const, authorization: this.requireAuthorization() };
    }
    if (this.status !== "started") return { status: this.status };
    if (this.execution !== undefined) {
      return this.execution.phase === "claimed"
        ? { status: "in_progress" as const }
        : { status: "reconcile" as const, execution: this.execution };
    }
    const authorization = this.requireAuthorization();
    this.execution ??= {
      tenantId: authorization.tenantId,
      operationId: authorization.operationId,
      authorizationId: authorization.authorizationId,
      executionId: randomUUID(),
      attemptId: input.attemptId,
      generation: 1,
      phase: "claimed",
      incarnationId: authorization.incarnationId,
      physicalObjectKey: authorization.physicalObjectKey,
    };
    this.promotionProof ??= "pre_intent";
    return { status: "copy_allowed" as const, execution: this.execution };
  }

  async resolveAuthorizedForCopy(input: {
    readonly scope: { readonly tenantId: string };
    readonly execution: PromotionExecutionClaim;
  }) {
    if (!this.matchesExecution(input.scope, input.execution)) {
      return { status: "wrong_operation" as const };
    }
    if (this.status === "reserved") {
      return { status: "not_started" as const };
    }
    if (this.status !== "started") {
      return { status: this.status };
    }
    return { status: "authorized" as const, authorization: this.requireAuthorization() };
  }

  async markPromotionCopyIssued(input: {
    readonly scope: { readonly tenantId: string };
    readonly execution: PromotionExecutionClaim;
  }) {
    if (!this.matchesExecution(input.scope, input.execution)) {
      return { status: "claim_lost" as const };
    }
    this.execution = { ...input.execution, phase: "executing" };
    this.promotionProof = this.markResponseUnknownForTest ? "mark_unknown" : "copy_issued";
    if (this.markResponseUnknownForTest) {
      throw new Error("MinIO Fake mark 响应未知");
    }
    return { status: "marked" as const, execution: this.execution };
  }

  async completePromotionExecution(input: {
    readonly scope: { readonly tenantId: string };
    readonly execution: PromotionExecutionClaim;
    readonly outcome: "succeeded" | "not_copied" | "unknown" | "reconcile";
  }): Promise<void> {
    if (!this.matchesExecutionIdentity(input.scope, input.execution)) {
      throw new Error("MinIO 集成授权 execution CAS 失效");
    }
    if (input.outcome === "not_copied") {
      if (this.execution?.phase !== "claimed") throw new Error("COPY intent 不可撤销");
      this.status = "inactive";
      this.promotionProof = "not_copied";
      return;
    }
    if (input.outcome === "unknown") {
      this.execution = { ...input.execution, phase: "unknown" };
      return;
    }
    if (input.outcome === "reconcile") {
      this.execution = { ...input.execution, phase: "unknown" };
      return;
    }
    this.status = "consumed";
    this.execution = undefined;
  }

  private matchesAuthorization(
    scope: { readonly tenantId: string },
    ref: PromotionAuthorizationRef,
  ): boolean {
    const authorization = this.authorization;
    if (authorization === undefined) return false;
    return (
      scope.tenantId === authorization.tenantId &&
      ref.tenantId === authorization.tenantId &&
      ref.operationId === authorization.operationId &&
      ref.authorizationId === authorization.authorizationId
    );
  }

  private matchesExecution(
    scope: { readonly tenantId: string },
    execution: PromotionExecutionClaim,
  ): boolean {
    return (
      this.matchesExecutionIdentity(scope, execution) && this.execution?.phase === execution.phase
    );
  }

  private matchesExecutionIdentity(
    scope: { readonly tenantId: string },
    execution: PromotionExecutionClaim,
  ): boolean {
    const authorization = this.authorization;
    return (
      authorization !== undefined &&
      scope.tenantId === authorization.tenantId &&
      this.execution?.executionId === execution.executionId &&
      this.execution.generation === execution.generation &&
      this.execution.attemptId === execution.attemptId
    );
  }

  private requireAuthorization(): StableBlobPromotionAuthorization {
    if (this.authorization === undefined) throw new Error("MinIO canonical authorization 尚未落库");
    return this.authorization;
  }
}

async function listKeys(client: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const result = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  if (result.IsTruncated) {
    throw new Error("集成测试唯一前缀出现超出单页的异常对象数量");
  }
  return (result.Contents ?? []).flatMap((item) => (item.Key === undefined ? [] : [item.Key]));
}

function requiredConfig(): {
  endpoint: string;
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
} {
  const endpoint = required("S3_ENDPOINT");
  const publicEndpoint = required("S3_PUBLIC_ENDPOINT");
  const region = required("S3_REGION");
  const bucket = required("S3_BUCKET");
  const accessKeyId = required("S3_ACCESS_KEY_ID");
  const secretAccessKey = required("S3_SECRET_ACCESS_KEY");
  return { endpoint, publicEndpoint, region, bucket, accessKeyId, secretAccessKey };
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`MinIO 集成测试缺少环境变量 ${name}`);
  }
  return value;
}

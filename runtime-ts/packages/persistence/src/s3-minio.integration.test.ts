import { randomUUID } from "node:crypto";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  createS3BlobStore,
  createS3StableBlobGarbageCollector,
  sha256Hex,
  type PromotionAuthorizationRef,
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
    const incarnationId = randomUUID();
    const lifecycleId = randomUUID();
    const allocationId = randomUUID();
    const authorizationId = randomUUID();
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
    const stable: StableBlobRef = {
      kind: "stable",
      tenantId: scope.tenantId,
      purpose: "artifact",
      incarnationId,
      physicalObjectKey: `${prefix}/stable/${scope.tenantId}/artifact/sha256/${descriptor.sha256}/incarnations/${incarnationId}`,
      ...descriptor,
    };
    const allocation = {
      tenantId: scope.tenantId,
      purpose: staged.purpose,
      sha256: staged.sha256,
      size: staged.size,
      incarnationId,
      physicalObjectKey: stable.physicalObjectKey,
      lifecycleId,
      allocationId,
      generation: 1,
      mode: "active_reuse" as const,
    };
    const authorization: StableBlobPromotionAuthorization = {
      ...allocation,
      authorizationId,
      operationId: `operation-${unique}`,
      referenceId: `reference-${unique}`,
      stagingUploadId: staged.uploadId,
      stagingObjectKey: `${prefix}/tenants/${scope.tenantId}/staging/artifact/${staged.uploadId}`,
    };
    const authorizationRef: PromotionAuthorizationRef = {
      tenantId: scope.tenantId,
      operationId: authorization.operationId,
      authorizationId,
    };
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
    const store = createS3BlobStore(
      common,
      new IntegrationPromotionAuthorizations(authorization, "started"),
    );
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
});

/** 真实 MinIO 也通过与单元测试相同的状态化授权解析契约，不允许回显调用参数。 */
class IntegrationPromotionAuthorizations implements StableBlobPromotionAuthorizationPort {
  constructor(
    private readonly authorization: StableBlobPromotionAuthorization,
    private status: "reserved" | "started" | "retired" | "consumed" | "inactive",
  ) {}

  async resolveAuthorizedForCopy(input: {
    readonly scope: { readonly tenantId: string };
    readonly authorization: PromotionAuthorizationRef;
  }) {
    if (
      input.scope.tenantId !== this.authorization.tenantId ||
      input.authorization.tenantId !== this.authorization.tenantId ||
      input.authorization.operationId !== this.authorization.operationId ||
      input.authorization.authorizationId !== this.authorization.authorizationId
    ) {
      return { status: "wrong_operation" as const };
    }
    if (this.status === "reserved") {
      return { status: "not_started" as const };
    }
    if (this.status !== "started") {
      return { status: this.status };
    }
    return { status: "authorized" as const, authorization: this.authorization };
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

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createS3BlobStore, type StableBlobRef, type StagedBlobRef } from "./index.js";

const integration = process.env.RUN_MINIO_INTEGRATION === "true" ? describe : describe.skip;

integration("MinIO Blob Store 集成", () => {
  it("完成私有对象 staging、提升、读取、预签名与清理", async () => {
    const config = requiredConfig();
    const unique = randomUUID();
    const scope = { tenantId: `integration_${unique.replaceAll("-", "_")}` };
    const store = createS3BlobStore({
      bucket: config.bucket,
      endpoint: config.endpoint,
      publicEndpoint: config.publicEndpoint,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      forcePathStyle: true,
      prefix: `integration-test/${unique}`,
      maxPresignTtlSeconds: 60,
    });
    let staged: StagedBlobRef | undefined;
    let stable: StableBlobRef | undefined;

    try {
      const body = new TextEncoder().encode(`minio-${unique}`);
      staged = await store.putStaging({
        scope,
        purpose: "artifact",
        uploadId: `upload-${unique}`,
        body,
        mediaType: "text/plain",
      });
      expect((await store.head(scope, staged))?.blob).toEqual(staged);
      expect(await store.get(scope, staged)).toEqual(body);

      stable = await store.promote(scope, staged);
      expect(await store.get(scope, stable)).toEqual(body);
      const downloadUrl = await store.presignDownload({
        scope,
        blob: stable,
        ttlSeconds: 30,
        downloadName: "integration.txt",
      });
      const response = await fetch(downloadUrl);
      expect(response.ok).toBe(true);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    } finally {
      if (stable !== undefined) {
        await store.delete(scope, stable);
      }
      if (staged !== undefined) {
        await store.delete(scope, staged);
      }
    }
  });
});

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
